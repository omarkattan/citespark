import 'dotenv/config';
import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { many, one, query } from './db/index.js';
import { runCycleForProject } from './jobs/runCycle.js';
import { buildRecommendations, persistRecommendations } from './lib/recommend.js';
import { syncGa4 } from './lib/ga4.js';
import { generatePrompts } from './lib/prompts.js';
import { discoverSite } from './lib/discover.js';
import { PLANS, PLAN_ORDER, planFor } from './lib/plans.js';
import {
  stripeEnabled, getStripe, getEntitlements, checkCanAddSite, checkCanAddQuestions,
  createCheckoutSession, createPortalSession, handleWebhook, budgetForCycle
} from './lib/billing.js';
import { MOCK } from './lib/dataforseo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);
// Stripe signs the raw body, so this route is mounted before the JSON parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeEnabled) return res.status(503).json({ error: 'Billing is not configured' });
  try {
    const s = await getStripe();
    const event = s.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
    await handleWebhook(event);
    res.json({ received: true });
  } catch (err) {
    console.error('stripe webhook rejected:', err.message);
    res.status(400).json({ error: `Webhook error: ${err.message}` });
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(
  cookieSession({
    name: 'citespark',
    keys: [process.env.SESSION_SECRET || 'change-me-in-env'],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  })
);

const publicDir = path.join(__dirname, 'public');
const STARTED_AT = new Date().toISOString();

/** Express 4 does not catch rejected promises, so an unhandled DB error
 *  would otherwise take the whole process down. Wrap every async handler. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Sign in to continue' });
  next();
}

async function assertProject(req, res) {
  const project = await one('SELECT * FROM projects WHERE id = $1 AND org_id = $2', [
    Number(req.params.id),
    req.session.orgId
  ]);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return project;
}

/* ---------------- auth ---------------- */

app.post('/api/register', wrap(async (req, res) => {
  const { email, password, orgName } = req.body || {};
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Enter an email and a password of at least 8 characters' });
  }
  const existing = await one('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing) return res.status(409).json({ error: 'That email is already registered' });

  const org = await one('INSERT INTO orgs (name) VALUES ($1) RETURNING id', [orgName || email.split('@')[1]]);
  const hash = await bcrypt.hash(password, 10);
  const user = await one(
    'INSERT INTO users (org_id, email, password_hash) VALUES ($1,$2,$3) RETURNING id, org_id',
    [org.id, email.toLowerCase(), hash]
  );
  req.session.userId = user.id;
  req.session.orgId = user.org_id;
  res.json({ ok: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await one('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase()]);
  if (!user || !(await bcrypt.compare(String(password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'That email and password do not match' });
  }
  req.session.userId = user.id;
  req.session.orgId = user.org_id;
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ signedIn: Boolean(req.session?.userId), mock: MOCK });
});

/* ---------------- data ---------------- */

app.get('/api/projects', requireAuth, wrap(async (req, res) => {
  const rows = await many(
    'SELECT id, name, domain, brand_name FROM projects WHERE org_id = $1 ORDER BY id',
    [req.session.orgId]
  );
  res.json(rows);
}));

app.get('/api/projects/:id/overview', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const cycleRow = await one('SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok', [project.id]);
  const cycle = cycleRow?.d;
  if (!cycle) return res.json({ project, cycle: null, engines: [], visibility: 0, competitors: [] });

  const own = await one(
    `SELECT COUNT(*)::int AS runs, SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::int AS hits,
            AVG(m.ordinal)::float AS avg_ordinal
     FROM runs r JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.project_id = $1 AND r.cycle_date = $2 AND r.ok`,
    [project.id, cycle]
  );

  const engines = await many(
    `SELECT r.engine, COUNT(*)::int AS runs, SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::int AS hits
     FROM runs r JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.project_id = $1 AND r.cycle_date = $2 AND r.ok
     GROUP BY r.engine ORDER BY r.engine`,
    [project.id, cycle]
  );

  const competitors = await many(
    `SELECT e.name, e.kind, COUNT(*)::int AS runs, SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::int AS hits
     FROM runs r JOIN mentions m ON m.run_id = r.id JOIN entities e ON e.id = m.entity_id
     WHERE r.project_id = $1 AND r.cycle_date = $2 AND r.ok
     GROUP BY e.id ORDER BY hits DESC`,
    [project.id, cycle]
  );

  const history = await many(
    `SELECT r.cycle_date, SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS rate
     FROM runs r JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.project_id = $1 AND r.ok
     GROUP BY r.cycle_date ORDER BY r.cycle_date`,
    [project.id]
  );

  const spend = await one(
    'SELECT COALESCE(SUM(cost_usd),0)::float AS total FROM runs WHERE project_id = $1 AND cycle_date = $2',
    [project.id, cycle]
  );

  res.json({
    project,
    cycle,
    visibility: own.runs ? own.hits / own.runs : 0,
    avgOrdinal: own.avg_ordinal,
    runs: own.runs,
    engines: engines.map((e) => ({ engine: e.engine, rate: e.runs ? e.hits / e.runs : 0, runs: e.runs })),
    competitors: competitors.map((c) => ({ name: c.name, kind: c.kind, rate: c.runs ? c.hits / c.runs : 0 })),
    history: history.map((h) => ({ date: h.cycle_date, rate: Number(h.rate) })),
    spend: spend.total
  });
}));

app.get('/api/projects/:id/prompts', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const cycleRow = await one('SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok', [project.id]);
  const cycle = cycleRow?.d;
  if (!cycle) return res.json([]);

  const rows = await many(
    `SELECT p.id, p.text, p.cluster, p.intent, p.ai_search_volume,
            r.id AS run_id, r.engine, r.run_index, m.mentioned, m.ordinal, m.snippet
     FROM prompts p
     JOIN runs r ON r.prompt_id = p.id AND r.cycle_date = $2 AND r.ok
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE p.project_id = $1
     ORDER BY p.ai_search_volume DESC, p.id, r.engine, r.run_index`,
    [project.id, cycle]
  );

  const citations = await many(
    `SELECT r.prompt_id, c.domain, COUNT(*)::int AS n
     FROM citations c JOIN runs r ON r.id = c.run_id
     WHERE r.project_id = $1 AND r.cycle_date = $2
     GROUP BY r.prompt_id, c.domain ORDER BY n DESC`,
    [project.id, cycle]
  );

  const fanOut = await many(
    `SELECT r.prompt_id, q AS query, COUNT(*)::int AS n
     FROM runs r, UNNEST(r.fan_out_queries) AS q
     WHERE r.project_id = $1 AND r.cycle_date = $2 AND r.ok
     GROUP BY r.prompt_id, q ORDER BY n DESC`,
    [project.id, cycle]
  );

  const byPrompt = new Map();
  for (const row of rows) {
    if (!byPrompt.has(row.id)) {
      byPrompt.set(row.id, {
        id: row.id,
        text: row.text,
        cluster: row.cluster,
        intent: row.intent,
        volume: row.ai_search_volume,
        runs: [],
        snippet: null,
        citations: [],
        fanOut: []
      });
    }
    const p = byPrompt.get(row.id);
    p.runs.push({ engine: row.engine, mentioned: row.mentioned, ordinal: row.ordinal });
    if (!p.snippet && row.snippet) p.snippet = row.snippet;
  }
  for (const c of citations) {
    const p = byPrompt.get(c.prompt_id);
    if (p && p.citations.length < 6) p.citations.push({ domain: c.domain, n: c.n });
  }
  for (const f of fanOut) {
    const p = byPrompt.get(f.prompt_id);
    if (p && p.fanOut.length < 4) p.fanOut.push(f.query);
  }

  const out = [...byPrompt.values()].map((p) => ({
    ...p,
    rate: p.runs.length ? p.runs.filter((r) => r.mentioned).length / p.runs.length : 0
  }));

  res.json(out);
}));

app.get('/api/projects/:id/recommendations', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const status = req.query.status || 'open';
  const rows = await many(
    'SELECT * FROM recommendations WHERE project_id = $1 AND status = $2 ORDER BY priority DESC LIMIT 60',
    [project.id, status]
  );
  res.json(rows);
}));

app.patch('/api/recommendations/:recId', requireAuth, wrap(async (req, res) => {
  const { status } = req.body || {};
  if (!['open', 'doing', 'done', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Unknown status' });
  }
  const result = await query(
    `UPDATE recommendations SET status = $1, updated_at = now()
     WHERE id = $2 AND project_id IN (SELECT id FROM projects WHERE org_id = $3)`,
    [status, Number(req.params.recId), req.session.orgId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Action not found' });
  res.json({ ok: true });
}));

app.get('/api/projects/:id/sources', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const cycleRow = await one('SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok', [project.id]);
  if (!cycleRow?.d) return res.json([]);
  const rows = await many(
    `SELECT c.domain, COUNT(*)::int AS citations, COUNT(DISTINCT r.prompt_id)::int AS prompts
     FROM citations c JOIN runs r ON r.id = c.run_id
     WHERE r.project_id = $1 AND r.cycle_date = $2
     GROUP BY c.domain ORDER BY citations DESC LIMIT 20`,
    [project.id, cycleRow.d]
  );
  const own = project.domain.replace(/^www\./, '');
  res.json(rows.map((r) => ({ ...r, owned: r.domain === own })));
}));

app.get('/api/projects/:id/traffic', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const rows = await many(
    `SELECT platform, classification_method,
            SUM(sessions)::int AS sessions,
            SUM(conversions)::float AS conversions,
            SUM(revenue)::float AS revenue
     FROM ga4_daily
     WHERE project_id = $1 AND date > CURRENT_DATE - INTERVAL '30 days'
     GROUP BY platform, classification_method ORDER BY sessions DESC`,
    [project.id]
  );
  res.json(rows);
}));

/* ---------------- setup: projects, competitors, questions ---------------- */

app.post('/api/discover', requireAuth, wrap(async (req, res) => {
  const result = await discoverSite(req.body?.domain);
  if (!result.ok) return res.status(422).json(result);
  res.json(result);
}));

app.post('/api/projects', requireAuth, wrap(async (req, res) => {
  const { name, domain, brandName, aliases, category, market, qualifier, competitors, generate } = req.body || {};

  const cleanDomain = String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');

  if (!cleanDomain.includes('.')) return res.status(400).json({ error: 'Enter a domain, for example sandstormdigital.com' });
  if (!brandName?.trim()) return res.status(400).json({ error: 'Enter the brand name as customers would say it' });

  const existing = await one('SELECT id FROM projects WHERE org_id = $1 AND domain = $2', [req.session.orgId, cleanDomain]);
  if (existing) return res.status(409).json({ error: 'You are already tracking that domain' });

  const blocked = await checkCanAddSite(req.session.orgId);
  if (blocked) return res.status(402).json({ error: blocked, upgrade: true });

  const project = await one(
    `INSERT INTO projects (org_id, name, domain, brand_name, aliases, market, language, category, qualifier)
     VALUES ($1,$2,$3,$4,$5,$6,'en',$7,$8) RETURNING *`,
    [
      req.session.orgId,
      (name || brandName).trim(),
      cleanDomain,
      brandName.trim(),
      Array.isArray(aliases) ? aliases.map((a) => String(a).trim()).filter(Boolean).slice(0, 10) : [],
      (market || 'GB').toUpperCase(),
      (category || 'business').trim(),
      (qualifier || 'small business').trim()
    ]
  );

  await query(
    `INSERT INTO entities (project_id, name, domain, kind, aliases) VALUES ($1,$2,$3,'owned',$4)
     ON CONFLICT (project_id, name) DO NOTHING`,
    [project.id, project.brand_name, project.domain, project.aliases]
  );

  for (const c of Array.isArray(competitors) ? competitors.slice(0, 20) : []) {
    const cName = String(c.name || '').trim();
    if (!cName) continue;
    await query(
      `INSERT INTO entities (project_id, name, domain, kind) VALUES ($1,$2,$3,'competitor')
       ON CONFLICT (project_id, name) DO NOTHING`,
      [project.id, cName, String(c.domain || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '') || null]
    );
  }

  const entitlements = await getEntitlements(req.session.orgId);
  let added = 0;
  if (generate !== false) {
    const prompts = await generatePrompts({
      brand: project.brand_name,
      domain: project.domain,
      category: project.category,
      market: project.market === 'GB' ? 'the UK' : project.market,
      qualifier: project.qualifier,
      count: Math.min(20, entitlements.plan.questions)
    });
    for (const p of prompts.slice(0, entitlements.plan.questions)) {
      await query(
        `INSERT INTO prompts (project_id, text, cluster, intent, ai_search_volume)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id, text) DO NOTHING`,
        [project.id, p.text, p.cluster, p.intent, p.ai_search_volume]
      );
      added++;
    }
  }

  res.json({ ok: true, project, promptsAdded: added });
}));

app.patch('/api/projects/:id', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const { name, brandName, aliases, category, qualifier, market, runsPerCycle } = req.body || {};
  await query(
    `UPDATE projects SET
       name = COALESCE($2, name),
       brand_name = COALESCE($3, brand_name),
       aliases = COALESCE($4, aliases),
       category = COALESCE($5, category),
       qualifier = COALESCE($6, qualifier),
       market = COALESCE($7, market),
       runs_per_cycle = COALESCE($8, runs_per_cycle)
     WHERE id = $1`,
    [
      project.id,
      name?.trim() || null,
      brandName?.trim() || null,
      Array.isArray(aliases) ? aliases.map((a) => String(a).trim()).filter(Boolean) : null,
      category?.trim() || null,
      qualifier?.trim() || null,
      market?.toUpperCase() || null,
      Number.isInteger(runsPerCycle) ? Math.min(10, Math.max(1, runsPerCycle)) : null
    ]
  );
  // Keep the owned entity in step with the brand name.
  if (brandName?.trim() || aliases) {
    await query(
      `UPDATE entities SET name = COALESCE($2, name), aliases = COALESCE($3, aliases)
       WHERE project_id = $1 AND kind = 'owned'`,
      [project.id, brandName?.trim() || null, Array.isArray(aliases) ? aliases : null]
    );
  }
  res.json({ ok: true });
}));

app.delete('/api/projects/:id', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  await query('DELETE FROM projects WHERE id = $1', [project.id]);
  res.json({ ok: true });
}));

app.get('/api/projects/:id/setup', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const entities = await many('SELECT id, name, domain, kind, aliases FROM entities WHERE project_id = $1 ORDER BY kind, name', [project.id]);
  const prompts = await many(
    'SELECT id, text, cluster, intent, ai_search_volume, active FROM prompts WHERE project_id = $1 ORDER BY active DESC, ai_search_volume DESC, id',
    [project.id]
  );
  res.json({ project, entities, prompts });
}));

app.post('/api/projects/:id/entities', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter the competitor name' });
  const domain = String(req.body?.domain || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const row = await one(
    `INSERT INTO entities (project_id, name, domain, kind) VALUES ($1,$2,$3,'competitor')
     ON CONFLICT (project_id, name) DO NOTHING RETURNING *`,
    [project.id, name, domain || null]
  );
  if (!row) return res.status(409).json({ error: 'That name is already tracked' });
  res.json(row);
}));

app.delete('/api/entities/:entityId', requireAuth, wrap(async (req, res) => {
  const result = await query(
    `DELETE FROM entities WHERE id = $1 AND kind = 'competitor'
       AND project_id IN (SELECT id FROM projects WHERE org_id = $2)`,
    [Number(req.params.entityId), req.session.orgId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Competitor not found' });
  res.json({ ok: true });
}));

app.post('/api/projects/:id/prompts', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const text = String(req.body?.text || '').trim();
  if (text.length < 10) return res.status(400).json({ error: 'Write the question as a customer would type it' });
  if (text.length > 500) return res.status(400).json({ error: 'Questions are capped at 500 characters by the engines' });
  const overQuestions = await checkCanAddQuestions(req.session.orgId, project.id, 1);
  if (overQuestions) return res.status(402).json({ error: overQuestions, upgrade: true });
  const row = await one(
    `INSERT INTO prompts (project_id, text, cluster, intent, ai_search_volume, source)
     VALUES ($1,$2,$3,$4,$5,'custom') ON CONFLICT (project_id, text) DO NOTHING RETURNING *`,
    [
      project.id,
      text,
      String(req.body?.cluster || 'custom').toLowerCase(),
      ['discovery', 'comparison', 'commercial', 'problem'].includes(req.body?.intent) ? req.body.intent : 'commercial',
      Number.isFinite(Number(req.body?.volume)) ? Math.max(0, Math.round(Number(req.body.volume))) : 100
    ]
  );
  if (!row) return res.status(409).json({ error: 'That question is already tracked' });
  res.json(row);
}));

app.patch('/api/prompts/:promptId', requireAuth, wrap(async (req, res) => {
  const result = await query(
    `UPDATE prompts SET active = COALESCE($2, active)
     WHERE id = $1 AND project_id IN (SELECT id FROM projects WHERE org_id = $3)`,
    [Number(req.params.promptId), typeof req.body?.active === 'boolean' ? req.body.active : null, req.session.orgId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Question not found' });
  res.json({ ok: true });
}));

app.delete('/api/prompts/:promptId', requireAuth, wrap(async (req, res) => {
  const result = await query(
    'DELETE FROM prompts WHERE id = $1 AND project_id IN (SELECT id FROM projects WHERE org_id = $2)',
    [Number(req.params.promptId), req.session.orgId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Question not found' });
  res.json({ ok: true });
}));

app.post('/api/projects/:id/generate-prompts', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const ent = await getEntitlements(req.session.orgId);
  const active = await one('SELECT COUNT(*)::int AS n FROM prompts WHERE project_id = $1 AND active', [project.id]);
  const room = ent.plan.questions - active.n;
  if (room <= 0) {
    return res.status(402).json({
      error: `The ${ent.plan.name} plan allows ${ent.plan.questions} active question${ent.plan.questions === 1 ? '' : 's'} per site. Pause one or upgrade to add more.`,
      upgrade: true
    });
  }

  const prompts = await generatePrompts({
    brand: project.brand_name,
    domain: project.domain,
    category: project.category,
    market: project.market === 'GB' ? 'the UK' : project.market,
    qualifier: project.qualifier,
    count: Math.min(30, Math.max(5, Number(req.body?.count) || 10))
  });
  let added = 0;
  for (const p of prompts) {
    if (added >= room) break;
    const row = await one(
      `INSERT INTO prompts (project_id, text, cluster, intent, ai_search_volume)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id, text) DO NOTHING RETURNING id`,
      [project.id, p.text, p.cluster, p.intent, p.ai_search_volume]
    );
    if (row) added++;
  }
  res.json({ ok: true, added, suggested: prompts.length, room });
}));

/* ---------------- billing ---------------- */

app.get('/api/plans', (_req, res) => {
  res.json({ plans: PLAN_ORDER.map((id) => PLANS[id]), stripeEnabled });
});

app.get('/api/billing', requireAuth, wrap(async (req, res) => {
  const e = await getEntitlements(req.session.orgId);
  res.json({ ...e, stripeEnabled });
}));

app.post('/api/billing/checkout', requireAuth, wrap(async (req, res) => {
  const { plan, interval } = req.body || {};
  if (!PLANS[plan] || plan === 'free') return res.status(400).json({ error: 'Choose a paid plan' });
  const user = await one('SELECT email FROM users WHERE id = $1', [req.session.userId]);
  try {
    const session = await createCheckoutSession({
      orgId: req.session.orgId,
      email: user.email,
      planId: plan,
      interval: interval === 'year' ? 'year' : 'month',
      origin: `${req.protocol}://${req.get('host')}`
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/billing/portal', requireAuth, wrap(async (req, res) => {
  try {
    const session = await createPortalSession({
      orgId: req.session.orgId,
      origin: `${req.protocol}://${req.get('host')}`
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

/* ---------------- actions ---------------- */

app.post('/api/projects/:id/run', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const active = await one('SELECT COUNT(*)::int AS n FROM prompts WHERE project_id = $1 AND active', [project.id]);
  const budget = await budgetForCycle(req.session.orgId, {
    questions: active.n,
    engines: (process.env.ENGINES || 'chatgpt,gemini,perplexity').split(',').map((s) => s.trim()),
    runs: project.runs_per_cycle
  });

  if (!budget.ok) return res.status(402).json({ error: budget.reason, upgrade: true });

  res.json({
    ok: true,
    started: true,
    mock: MOCK,
    calls: budget.maxCalls,
    estimateUsd: budget.estimateUsd,
    trimmed: budget.trimmed
  });
  runCycleForProject(project.id).catch((err) => console.error('cycle failed:', err));
}));

app.post('/api/projects/:id/rebuild', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const recs = await buildRecommendations(project.id);
  await persistRecommendations(project.id, recs);
  res.json({ ok: true, count: recs.length });
}));

app.post('/api/projects/:id/sync-ga4', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  try {
    res.json(await syncGa4(project.id));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ---------------- pages ---------------- */

// index: false so that GET / does not bypass the session check below.
// no-cache on the HTML and JS means a deploy is visible on the next normal
// refresh, rather than needing a hard refresh to clear a stale bundle.
app.use(
  express.static(publicDir, {
    index: false,
    etag: true,
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    }
  })
);

app.get('/login', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'login.html'));
});

// Public marketing page.
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'landing.html'));
});

// The product itself.
app.get('/app', (req, res) => {
  if (!req.session?.userId) return res.redirect('/login');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Lets you confirm which build is actually running.
app.get('/api/version', (_req, res) => {
  res.json({
    startedAt: STARTED_AT,
    features: ['landing-page', 'scan-site', 'country-dropdown', 'fanout-queries', 'project-delete',
      'billing', 'annual-plans', 'current-plan-display', 'stripe-mode-recovery', 'upgrade-ux', 'neutral-examples']
  });
});

// Errors surface as JSON rather than taking the service down.
app.use((err, _req, res, _next) => {
  console.error('request failed:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
});

process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`CiteSpark listening on ${port}${MOCK ? ' [MOCK MODE]' : ''}`);
});
