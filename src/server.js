import 'dotenv/config';
import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { many, one, query } from './db/index.js';
import { runCycleForProject } from './jobs/runCycle.js';
import { buildRecommendations, persistRecommendations } from './lib/recommend.js';
import {
  syncGa4, authUrl, exchangeCode, storeConnection, disconnect as ga4Disconnect,
  listProperties, oauthConfigured
} from './lib/ga4.js';
import { signState, readState } from './lib/tokens.js';
import { generatePrompts } from './lib/prompts.js';
import { discoverSite } from './lib/discover.js';
import { PLANS, PLAN_ORDER, planFor } from './lib/plans.js';
import { proposeQuestions, runDemo, checkLimits, hashIp, DEMO_CONFIG } from './lib/demo.js';
import { teardown } from './lib/teardown.js';
import { notifyTrial, notifySignup, notifyPaid, notifyFeedback, notifyAssignment, looksLikeEmail, emailConfigured } from './lib/notify.js';
import { listSites as listGscSites, candidates as gscCandidates, importQuestions } from './lib/gsc.js';
import { landscape, PLATFORMS, mentionsConfigured } from './lib/mentions.js';
import {
  stripeEnabled, getStripe, getEntitlements, checkCanAddSite, checkCanAddQuestions,
  createCheckoutSession, createPortalSession, handleWebhook, budgetForCycle, engineCosts
} from './lib/billing.js';
import { MOCK, ENGINES, ENGINE_IDS } from './lib/dataforseo.js';

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

/**
 * Send every old hostname to the canonical one.
 *
 * Without this, an old subdomain that still resolves keeps serving the site,
 * and because every internal link is relative you stay on it forever. That
 * also splits your search indexing across two hostnames.
 *
 * Only page requests are redirected. API routes are left alone so a
 * webhook still registered against an old URL keeps working rather than
 * failing on a redirected POST.
 */
const CANONICAL_HOST = (process.env.CANONICAL_HOST || '').trim().toLowerCase();

app.use((req, res, next) => {
  if (!CANONICAL_HOST) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path === '/healthz' || req.path.startsWith('/api/')) return next();

  const host = (req.hostname || '').toLowerCase();
  if (!host || host === CANONICAL_HOST) return next();
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return next();

  return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
});

app.use(express.json({ limit: '1mb' }));
app.use(
  cookieSession({
    name: 'cited',
    keys: [process.env.SESSION_SECRET || 'change-me-in-env'],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  })
);

const publicDir = path.join(__dirname, 'public');
const STARTED_AT = new Date().toISOString();

// Country codes read badly inside a generated question, so name the market.
const MARKET_NAMES = {
  AE: 'the UAE', SA: 'Saudi Arabia', QA: 'Qatar', KW: 'Kuwait', BH: 'Bahrain', OM: 'Oman',
  EG: 'Egypt', GB: 'the UK', US: 'the United States', IN: 'India', DE: 'Germany',
  FR: 'France', ES: 'Spain', IT: 'Italy', NL: 'the Netherlands', CA: 'Canada',
  AU: 'Australia', IE: 'Ireland', ZA: 'South Africa', SG: 'Singapore'
};

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

  /**
   * Every question on the project, whether or not it has been asked.
   *
   * This used to join on runs, so a question added since the last cycle was
   * simply absent: someone adds five questions for a buyer type, opens this
   * tab, and finds nothing. A question that exists but has not run yet is a
   * legitimate state and the list should show it as such.
   */
  const rows = await many(
    `SELECT p.id, p.text, p.cluster, p.intent, p.ai_search_volume, p.active, p.source,
            p.persona_id, pe.name AS persona, pe.descriptor AS persona_descriptor,
            r.id AS run_id, r.engine, r.run_index, m.mentioned, m.ordinal, m.snippet
     FROM prompts p
     LEFT JOIN personas pe ON pe.id = p.persona_id
     LEFT JOIN runs r ON r.prompt_id = p.id AND r.cycle_date = $2 AND r.ok
     LEFT JOIN mentions m ON m.run_id = r.id
       AND m.entity_id = (SELECT id FROM entities WHERE project_id = $1 AND kind = 'owned' LIMIT 1)
     WHERE p.project_id = $1
     ORDER BY p.persona_id NULLS FIRST, p.ai_search_volume DESC NULLS LAST, p.id, r.engine, r.run_index`,
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
        active: row.active,
        source: row.source,
        personaId: row.persona_id,
        persona: row.persona,
        personaDescriptor: row.persona_descriptor,
        runs: [],
        snippet: null,
        citations: [],
        fanOut: []
      });
    }
    const p = byPrompt.get(row.id);
    // A left join produces a row with no run for a question never asked.
    if (row.run_id) p.runs.push({ engine: row.engine, mentioned: row.mentioned, ordinal: row.ordinal });
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
    // Never asked is not the same as asked and not named, and a rate of zero
    // would say the second.
    measured: p.runs.length > 0,
    rate: p.runs.length ? p.runs.filter((r) => r.mentioned).length / p.runs.length : null
  }));

  res.json(out);
}));

/**
 * Everything needed to show movement over time. One endpoint rather than
 * several, because every chart on the page shares the same cycle axis.
 */
app.get('/api/projects/:id/history', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const cycles = await many(
    `SELECT r.cycle_date AS date,
            COUNT(*)::int AS runs,
            SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS rate,
            AVG(m.ordinal)::float AS avg_ordinal
     FROM runs r
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.project_id = $1 AND r.ok
     GROUP BY r.cycle_date
     ORDER BY r.cycle_date`,
    [project.id]
  );

  const byEngine = await many(
    `SELECT r.cycle_date AS date, r.engine,
            SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS rate
     FROM runs r
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.project_id = $1 AND r.ok
     GROUP BY r.cycle_date, r.engine
     ORDER BY r.cycle_date`,
    [project.id]
  );

  const byEntity = await many(
    `SELECT r.cycle_date AS date, e.name, e.kind,
            SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS rate
     FROM runs r
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id
     WHERE r.project_id = $1 AND r.ok
     GROUP BY r.cycle_date, e.id
     ORDER BY r.cycle_date`,
    [project.id]
  );

  const spend = await many(
    `SELECT cycle_date AS date, COALESCE(SUM(cost_usd),0)::float AS cost, COUNT(*)::int AS calls
     FROM runs WHERE project_id = $1 GROUP BY cycle_date ORDER BY cycle_date`,
    [project.id]
  );

  // Question-level movement between the two most recent cycles, which is
  // where a client's "what changed and why" question actually gets answered.
  let movers = [];
  if (cycles.length >= 2) {
    const latest = cycles[cycles.length - 1].date;
    const prior = cycles[cycles.length - 2].date;
    movers = await many(
      `WITH per AS (
         SELECT p.id, p.text, r.cycle_date,
                SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS rate
         FROM runs r
         JOIN prompts p ON p.id = r.prompt_id
         JOIN mentions m ON m.run_id = r.id
         JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
         WHERE r.project_id = $1 AND r.ok AND r.cycle_date IN ($2, $3)
         GROUP BY p.id, r.cycle_date
       )
       SELECT a.id, a.text,
              b.rate AS before, a.rate AS after, (a.rate - b.rate) AS delta
       FROM per a JOIN per b ON b.id = a.id AND b.cycle_date = $3
       WHERE a.cycle_date = $2 AND a.rate IS DISTINCT FROM b.rate
       ORDER BY ABS(a.rate - b.rate) DESC
       LIMIT 8`,
      [project.id, latest, prior]
    );
  }

  res.json({
    project: { name: project.name, brand_name: project.brand_name },
    cycles: cycles.map((c) => ({ ...c, rate: Number(c.rate), avg_ordinal: c.avg_ordinal })),
    byEngine: byEngine.map((r) => ({ ...r, rate: Number(r.rate) })),
    byEntity: byEntity.map((r) => ({ ...r, rate: Number(r.rate) })),
    spend,
    movers: movers.map((m) => ({ ...m, before: Number(m.before), after: Number(m.after), delta: Number(m.delta) }))
  });
}));

app.get('/api/projects/:id/recommendations', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const status = String(req.query.status || 'open');
  const valid = ['open', 'doing', 'done', 'dismissed', 'all', 'active'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Unknown status filter' });

  // Sort by what needs attention: anything overdue first, then by due date,
  // then by priority. A task with a date beats an unowned one with a higher score.
  const where =
    status === 'all' ? '' :
    status === 'active' ? "AND status IN ('open','doing')" :
    'AND status = $2';
  const params = ['all', 'active'].includes(status) ? [project.id] : [project.id, status];

  const rows = await many(
    `SELECT * FROM recommendations
     WHERE project_id = $1 ${where}
     ORDER BY
       CASE WHEN due_date IS NOT NULL AND due_date < CURRENT_DATE AND status IN ('open','doing') THEN 0 ELSE 1 END,
       due_date NULLS LAST,
       priority DESC
     LIMIT 100`,
    params
  );

  const counts = await one(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'open')::int      AS open,
       COUNT(*) FILTER (WHERE status = 'doing')::int     AS doing,
       COUNT(*) FILTER (WHERE status = 'done')::int      AS done,
       COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed,
       COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status IN ('open','doing'))::int AS overdue,
       COUNT(*)::int AS total
     FROM recommendations WHERE project_id = $1`,
    [project.id]
  );

  const people = await many(
    `SELECT DISTINCT assignee FROM recommendations
     WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1) AND assignee IS NOT NULL AND assignee <> ''
     ORDER BY assignee`,
    [req.session.orgId]
  );
  const members = await many('SELECT email FROM users WHERE org_id = $1 ORDER BY email', [req.session.orgId]);

  res.json({
    tasks: rows,
    counts,
    people: [...new Set([...members.map((m) => m.email), ...people.map((p) => p.assignee)])]
  });
}));

/**
 * Read the page that was actually cited and explain why. This is the answer
 * to "why them and not me", which no amount of generic advice can give.
 */
/**
 * Delete an action outright. Dismissing keeps it in the record; deleting
 * removes it and suppresses the fingerprint so the next cycle does not
 * regenerate it. Reversible from the Dismissed filter.
 */
app.delete('/api/recommendations/:recId', requireAuth, wrap(async (req, res) => {
  const rec = await one(
    `SELECT r.id, r.project_id, r.fingerprint, r.title FROM recommendations r
     JOIN projects p ON p.id = r.project_id
     WHERE r.id = $1 AND p.org_id = $2`,
    [Number(req.params.recId), req.session.orgId]
  );
  if (!rec) return res.status(404).json({ error: 'Action not found' });

  await query(
    `INSERT INTO recommendation_suppressions (project_id, fingerprint, title)
     VALUES ($1,$2,$3) ON CONFLICT (project_id, fingerprint) DO NOTHING`,
    [rec.project_id, rec.fingerprint, rec.title]
  );
  await query('DELETE FROM recommendations WHERE id = $1', [rec.id]);

  const n = await one('SELECT COUNT(*)::int AS n FROM recommendation_suppressions WHERE project_id = $1', [rec.project_id]);
  res.json({ ok: true, suppressed: n.n });
}));

app.get('/api/projects/:id/suppressed', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  res.json(
    await many(
      'SELECT id, fingerprint, title, created_at FROM recommendation_suppressions WHERE project_id = $1 ORDER BY created_at DESC',
      [project.id]
    )
  );
}));

/** Let a deleted action come back on the next cycle. */
app.delete('/api/projects/:id/suppressed/:suppressionId', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const result = await query('DELETE FROM recommendation_suppressions WHERE id = $1 AND project_id = $2', [
    Number(req.params.suppressionId), project.id
  ]);
  if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

app.post('/api/projects/:id/teardown', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const url = String(req.body?.url || '').trim();
  const question = String(req.body?.question || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'That action has no page to analyse' });
  if (!question) return res.status(400).json({ error: 'No question is attached to that action' });

  const competitors = await many("SELECT domain FROM entities WHERE project_id = $1 AND kind = 'competitor'", [project.id]);
  const { classifySource } = await import('./lib/teardown.js');
  const { kind } = classifySource(new URL(url).hostname, {
    ownDomain: project.domain,
    competitorDomains: competitors.map((c) => c.domain)
  });

  try {
    const result = await teardown({ url, question, kind, ownBrand: project.brand_name });
    if (!result.ok) return res.status(422).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}));

app.patch('/api/recommendations/:recId', requireAuth, wrap(async (req, res) => {
  const { status, assignee, dueDate, notes } = req.body || {};

  // Read the current assignee first, so a genuine change can be told from a
  // re-save of the same value.
  const previous = await one(
    `SELECT r.assignee FROM recommendations r JOIN projects p ON p.id = r.project_id
     WHERE r.id = $1 AND p.org_id = $2`,
    [Number(req.params.recId), req.session.orgId]
  );

  if (status !== undefined && !['open', 'doing', 'done', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Unknown status' });
  }
  if (dueDate !== undefined && dueDate !== null && dueDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return res.status(400).json({ error: 'Use a date in YYYY-MM-DD form' });
  }

  const row = await one(
    `UPDATE recommendations SET
       status       = COALESCE($2, status),
       assignee     = CASE WHEN $3::text IS NULL THEN assignee ELSE NULLIF(trim($3), '') END,
       due_date     = CASE WHEN $4::text IS NULL THEN due_date ELSE NULLIF($4, '')::date END,
       notes        = CASE WHEN $5::text IS NULL THEN notes ELSE NULLIF(trim($5), '') END,
       -- A rescheduled or reopened task becomes chaseable again.
       overdue_notified_at = CASE
         WHEN $4::text IS NOT NULL AND NULLIF($4,'')::date IS DISTINCT FROM due_date THEN NULL
         WHEN $2 IN ('open','doing') AND status = 'done' THEN NULL
         ELSE overdue_notified_at END,
       started_at   = CASE WHEN $2 = 'doing' AND started_at IS NULL THEN now() ELSE started_at END,
       completed_at = CASE WHEN $2 = 'done' THEN now()
                           WHEN $2 IN ('open','doing') THEN NULL
                           ELSE completed_at END,
       updated_at   = now()
     WHERE id = $1 AND project_id IN (SELECT id FROM projects WHERE org_id = $6)
     RETURNING *`,
    [
      Number(req.params.recId),
      status ?? null,
      assignee === undefined ? null : String(assignee),
      dueDate === undefined ? null : String(dueDate ?? ''),
      notes === undefined ? null : String(notes),
      req.session.orgId
    ]
  );
  if (!row) return res.status(404).json({ error: 'Action not found' });

  // Tell the person the work was given to. Once per assignment: re-saving a
  // due date or a note must not send it again.
  const newlyAssigned =
    assignee !== undefined &&
    row.assignee &&
    row.assignee !== previous?.assignee &&
    looksLikeEmail(row.assignee);

  /**
   * Whether the email actually went is reported back, not assumed.
   *
   * Sending is deliberately fire-and-forget so a mail outage cannot break the
   * task board. The cost is that a broken sender is invisible until someone
   * says "they never got it", which is exactly what happened.
   */
  if (newlyAssigned) {
    const project = await one('SELECT name, domain FROM projects WHERE id = $1', [row.project_id]);
    const me = await one('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    notifyAssignment({
      to: row.assignee,
      assignedBy: me?.email || null,
      site: project?.name || project?.domain || 'your site',
      task: row,
      appUrl: tasksLinkFor(row.assignee, req.session.orgId, req)
    });
    await query('UPDATE recommendations SET assigned_notified_at = now() WHERE id = $1', [row.id]);
  }

  // Reported as attempted rather than delivered, since the send resolves
  // after this response. The UI checks the log a moment later.
  res.json({ ...row, notified: newlyAssigned, mailConfigured: emailConfigured || Boolean(process.env.RESEND_API_KEY) });
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

  if (!cleanDomain.includes('.')) return res.status(400).json({ error: 'Enter a domain, for example yourcompany.com' });
  if (!brandName?.trim()) return res.status(400).json({ error: 'Enter the brand name as customers would say it' });

  const existing = await one('SELECT id FROM projects WHERE org_id = $1 AND domain = $2', [req.session.orgId, cleanDomain]);
  if (existing) return res.status(409).json({ error: 'You are already tracking that domain' });

  const blocked = await checkCanAddSite(req.session.orgId);
  if (blocked) return res.status(402).json({ error: blocked, upgrade: true });

  const startingEngines = ENGINE_IDS.slice(0, (await getEntitlements(req.session.orgId)).plan.engines);

  const project = await one(
    `INSERT INTO projects (org_id, name, domain, brand_name, aliases, market, language, category, qualifier, engines)
     VALUES ($1,$2,$3,$4,$5,$6,'en',$7,$8,$9) RETURNING *`,
    [
      req.session.orgId,
      (name || brandName).trim(),
      cleanDomain,
      brandName.trim(),
      Array.isArray(aliases) ? aliases.map((a) => String(a).trim()).filter(Boolean).slice(0, 10) : [],
      (market || 'AE').toUpperCase(),
      (category || 'business').trim(),
      (qualifier || 'small business').trim(),
      startingEngines
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
      market: MARKET_NAMES[project.market] || project.market,
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
  const { name, brandName, aliases, category, qualifier, market, runsPerCycle, engines, autoCycle } = req.body || {};

  let engineList = null;
  if (Array.isArray(engines)) {
    const ent = await getEntitlements(req.session.orgId);
    engineList = engines.filter((e) => ENGINE_IDS.includes(e)).slice(0, ent.plan.engines);
    if (!engineList.length) engineList = ['chatgpt'];
  }

  await query(
    `UPDATE projects SET
       name = COALESCE($2, name),
       brand_name = COALESCE($3, brand_name),
       aliases = COALESCE($4, aliases),
       category = COALESCE($5, category),
       qualifier = COALESCE($6, qualifier),
       market = COALESCE($7, market),
       runs_per_cycle = COALESCE($8, runs_per_cycle),
       engines = COALESCE($9, engines),
       auto_cycle = COALESCE($10, auto_cycle)
     WHERE id = $1`,
    [
      project.id,
      name?.trim() || null,
      brandName?.trim() || null,
      Array.isArray(aliases) ? aliases.map((a) => String(a).trim()).filter(Boolean) : null,
      category?.trim() || null,
      qualifier?.trim() || null,
      market?.toUpperCase() || null,
      Number.isInteger(runsPerCycle) ? Math.min(10, Math.max(1, runsPerCycle)) : null,
      engineList,
      typeof autoCycle === 'boolean' ? autoCycle : null
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

/**
 * Cost per call is not one number. The SERP surfaces (AI Overview, AI Mode)
 * are a flat task fee, while the LLM surfaces carry the engine's own web
 * search charge on top and vary by how much the model retrieves.
 *
 * So rather than quoting a flat rate, use what this account has actually
 * been charged, falling back to conservative defaults until there is data.
 */
app.get('/api/projects/:id/setup', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const entities = await many('SELECT id, name, domain, kind, aliases FROM entities WHERE project_id = $1 ORDER BY kind, name', [project.id]);
  const prompts = await many(
    'SELECT id, text, cluster, intent, ai_search_volume, active FROM prompts WHERE project_id = $1 ORDER BY active DESC, ai_search_volume DESC, id',
    [project.id]
  );
  const pricing = await engineCosts(req.session.orgId);
  res.json({ project, entities, prompts, ...pricing });
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

/** Record what happened to a prompt, so a change log is possible later. */
async function logPromptEvent(projectId, event, { promptId = null, text, previous = null, source = null }) {
  const persona = promptId
    ? (await one('SELECT pe.name FROM prompts p LEFT JOIN personas pe ON pe.id = p.persona_id WHERE p.id = $1', [promptId]))?.name
    : null;
  await query(
    `INSERT INTO prompt_events (project_id, prompt_id, event, text, previous, persona, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [projectId, promptId, event, text, previous, persona || null, source]
  ).catch(() => {});
}

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
  await logPromptEvent(project.id, 'added', { promptId: row.id, text: row.text, source: 'custom' });
  res.json(row);
}));

/**
 * Pause or resume every question on a site in one request.
 *
 * Resuming respects the plan: if there are more questions than the plan
 * allows we resume the highest-volume ones up to the ceiling and say how
 * many were left paused, rather than failing the whole thing.
 */
app.post('/api/projects/:id/prompts/bulk', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const active = Boolean(req.body?.active);

  if (!active) {
    const r = await query('UPDATE prompts SET active = false WHERE project_id = $1 AND active', [project.id]);
    return res.json({ ok: true, changed: r.rowCount, activeNow: 0, capped: 0 });
  }

  const ent = await getEntitlements(req.session.orgId);
  const limit = ent.plan.questions;

  // Highest estimated volume first, so the cap keeps the questions that matter.
  await query(
    `UPDATE prompts SET active = (id IN (
       SELECT id FROM prompts WHERE project_id = $1
       ORDER BY ai_search_volume DESC, id
       LIMIT $2
     )) WHERE project_id = $1`,
    [project.id, limit]
  );

  const counts = await one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE active)::int AS active
     FROM prompts WHERE project_id = $1`,
    [project.id]
  );

  res.json({
    ok: true,
    activeNow: counts.active,
    capped: counts.total - counts.active,
    limit,
    planName: ent.plan.name
  });
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
  // Read it before it goes, or the change log has nothing to record.
  const before = await one(
    `SELECT p.id, p.text, p.project_id, p.source, pe.name AS persona
     FROM prompts p LEFT JOIN personas pe ON pe.id = p.persona_id
     WHERE p.id = $1 AND p.project_id IN (SELECT id FROM projects WHERE org_id = $2)`,
    [Number(req.params.promptId), req.session.orgId]
  );

  const result = await query(
    'DELETE FROM prompts WHERE id = $1 AND project_id IN (SELECT id FROM projects WHERE org_id = $2)',
    [Number(req.params.promptId), req.session.orgId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Question not found' });

  if (before) {
    await query(
      `INSERT INTO prompt_events (project_id, prompt_id, event, text, persona, source)
       VALUES ($1,$2,'removed',$3,$4,$5)`,
      [before.project_id, before.id, before.text, before.persona, before.source]
    ).catch(() => {});
  }
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
    market: MARKET_NAMES[project.market] || project.market,
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

/* ---------------- public demo ---------------- */

function clientIp(req) {
  return hashIp((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip);
}

app.get('/api/demo/config', (_req, res) => res.json(DEMO_CONFIG));

app.post('/api/demo/scan', wrap(async (req, res) => {
  const ipHash = clientIp(req);
  const limits = await checkLimits(ipHash);
  if (!limits.ok) return res.status(429).json({ error: limits.reason });

  const result = await proposeQuestions(req.body?.domain);
  if (!result.ok) return res.status(422).json(result);
  res.json({ ...result, remaining: limits.remaining });
}));

app.post('/api/demo/run', wrap(async (req, res) => {
  const ipHash = clientIp(req);
  const limits = await checkLimits(ipHash);
  if (!limits.ok) return res.status(429).json({ error: limits.reason });

  const { domain, brandName, question, token, market, source } = req.body || {};
  if (!domain || !brandName || !question || !token) {
    return res.status(400).json({ error: 'Scan a site first.' });
  }

  const result = await runDemo({
    domain, brandName, question, token, market, ipHash,
    source: String(source || '').slice(0, 40) || null
  });
  if (!result.ok) return res.status(422).json(result);

  // Not for a cached repeat: the same link doing the rounds is not a new lead.
  if (!result.cached) {
    notifyTrial({
      domain, brandName, question,
      rate: result.rate, runs: result.runs,
      source: String(source || '').slice(0, 40) || null
    });
  }

  res.json({ ...result, remaining: Math.max(0, limits.remaining - 1) });
}));

app.post('/api/demo/lead', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  await query(
    'INSERT INTO demo_leads (email, domain) VALUES ($1,$2) ON CONFLICT (email, domain) DO NOTHING',
    [email, String(req.body?.domain || '').slice(0, 200) || null]
  );
  res.json({ ok: true });
}));

/* ---------------- billing ---------------- */

app.get('/api/engines', (_req, res) => {
  res.json(ENGINE_IDS.map((id) => ({ id, ...ENGINES[id], model: undefined, path: undefined })));
});

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

/**
 * In-memory progress for a running cycle. Losing this on restart is fine:
 * the run itself is recorded in the database, and the client falls back to
 * simply reloading if the status disappears.
 */
const cycles = new Map();

app.get('/api/projects/:id/cycle-status', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  res.json(cycles.get(project.id) || { phase: 'idle' });
}));

/** How much a run would cover, so the choice is made with the numbers visible. */
app.get('/api/projects/:id/run-scope', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const all = (await one('SELECT COUNT(*)::int AS n FROM prompts WHERE project_id = $1 AND active', [project.id])).n;
  const unrun = (
    await one(
      `SELECT COUNT(*)::int AS n FROM prompts p
       WHERE p.project_id = $1 AND p.active
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.prompt_id = p.id AND r.ok)`,
      [project.id]
    )
  ).n;

  const engines = (project.engines || []).length || 1;
  const runs = project.runs_per_cycle || 1;
  const latest = (await one('SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok', [project.id]))?.d;

  res.json({
    all,
    unrun,
    checksAll: all * engines * runs,
    checksUnrun: unrun * engines * runs,
    // A partial run joins this cycle rather than starting a new one.
    joinsCycle: latest
  });
}));

app.post('/api/projects/:id/run', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const only = req.body?.only === 'unrun' ? 'unrun' : null;

  const active = await one(
    only === 'unrun'
      ? `SELECT COUNT(*)::int AS n FROM prompts p WHERE p.project_id = $1 AND p.active
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.prompt_id = p.id AND r.ok)`
      : 'SELECT COUNT(*)::int AS n FROM prompts WHERE project_id = $1 AND active',
    [project.id]
  );
  const budget = await budgetForCycle(req.session.orgId, {
    questions: active.n,
    engines: project.engines?.length ? project.engines : ['chatgpt'],
    runs: project.runs_per_cycle
  });

  if (!budget.ok) return res.status(402).json({ error: budget.reason, upgrade: true });

  if (cycles.get(project.id)?.phase === 'asking' || cycles.get(project.id)?.phase === 'thinking') {
    return res.status(409).json({ error: 'A cycle is already running for this site.' });
  }

  cycles.set(project.id, { phase: 'starting', done: 0, total: budget.maxCalls, startedAt: Date.now() });

  res.json({
    ok: true,
    started: true,
    mock: MOCK,
    calls: budget.maxCalls,
    estimateUsd: budget.estimateUsd,
    trimmed: budget.trimmed
  });

  runCycleForProject(project.id, {
    only,
    onProgress: (p) => {
      const prev = cycles.get(project.id) || {};
      cycles.set(project.id, { ...prev, ...p, total: p.total ?? prev.total });
    }
  })
    .then((summary) => {
      cycles.set(project.id, { phase: 'done', done: summary.runs, total: summary.runs, summary, finishedAt: Date.now() });
    })
    .catch((err) => {
      console.error('cycle failed:', err);
      cycles.set(project.id, { phase: 'failed', error: 'The cycle did not finish. Try again in a moment.' });
    });
}));

/**
 * Run every site on the account. Sites already mid-cycle are skipped rather
 * than queued twice, and each still passes its own plan and budget check.
 */
app.post('/api/run-all', requireAuth, wrap(async (req, res) => {
  const projects = await many('SELECT id, name FROM projects WHERE org_id = $1 ORDER BY id', [req.session.orgId]);
  const started = [];
  const skipped = [];

  for (const p of projects) {
    const phase = cycles.get(p.id)?.phase;
    if (phase === 'starting' || phase === 'asking' || phase === 'thinking') {
      skipped.push({ name: p.name, reason: 'already running' });
      continue;
    }

    const active = await one('SELECT COUNT(*)::int AS n FROM prompts WHERE project_id = $1 AND active', [p.id]);
    if (!active.n) {
      skipped.push({ name: p.name, reason: 'no active questions' });
      continue;
    }

    const project = await one('SELECT * FROM projects WHERE id = $1', [p.id]);
    const budget = await budgetForCycle(req.session.orgId, {
      questions: active.n,
      engines: project.engines?.length ? project.engines : ['chatgpt'],
      runs: project.runs_per_cycle
    });
    if (!budget.ok) {
      skipped.push({ name: p.name, reason: 'allowance used up' });
      continue;
    }

    cycles.set(p.id, { phase: 'starting', done: 0, total: budget.maxCalls, startedAt: Date.now() });
    started.push({ id: p.id, name: p.name, calls: budget.maxCalls });

    runCycleForProject(p.id, {
      onProgress: (pr) => {
        const prev = cycles.get(p.id) || {};
        cycles.set(p.id, { ...prev, ...pr, total: pr.total ?? prev.total });
      }
    })
      .then((summary) => cycles.set(p.id, { phase: 'done', done: summary.runs, total: summary.runs, summary, finishedAt: Date.now() }))
      .catch((err) => {
        console.error('cycle failed:', err);
        cycles.set(p.id, { phase: 'failed', error: 'The cycle did not finish.' });
      });
  }

  res.json({ ok: true, started, skipped });
}));

app.post('/api/projects/:id/rebuild', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const recs = await buildRecommendations(project.id);
  await persistRecommendations(project.id, recs);
  res.json({ ok: true, count: recs.length });
}));

/**
 * The answers behind one question's verdict.
 *
 * A percentage nobody can check is a claim. This returns what each engine
 * actually said, so a disputed "not named" can be settled by reading it.
 */
app.get('/api/prompts/:promptId/answers', requireAuth, wrap(async (req, res) => {
  const prompt = await one(
    `SELECT p.id, p.text, p.project_id FROM prompts p JOIN projects pr ON pr.id = p.project_id
     WHERE p.id = $1 AND pr.org_id = $2`,
    [Number(req.params.promptId), req.session.orgId]
  );
  if (!prompt) return res.status(404).json({ error: 'Not found' });

  const cycle = (await one('SELECT MAX(cycle_date) AS d FROM runs WHERE prompt_id = $1 AND ok', [prompt.id]))?.d;
  if (!cycle) return res.json({ prompt: prompt.text, runs: [] });

  const runs = await many(
    `SELECT r.id, r.engine, r.model, r.run_index, r.response_text, r.ok, r.error,
            m.mentioned, m.ordinal, e.name AS brand
     FROM runs r
     LEFT JOIN mentions m ON m.run_id = r.id
     LEFT JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.prompt_id = $1 AND r.cycle_date = $2
     ORDER BY r.engine, r.run_index`,
    [prompt.id, cycle]
  );

  const { looksTruncated } = await import('./lib/analyze.js');
  const ceiling = Number(process.env.MAX_OUTPUT_TOKENS || 2000);

  res.json({
    prompt: prompt.text,
    cycle,
    runs: runs.map((r) => ({
      ...r,
      // If the answer stopped at the ceiling, "not named" may only mean the
      // brand was in the part that never arrived.
      truncated: looksTruncated(r.response_text, ceiling)
    }))
  });
}));

/* ---------------- page checks ---------------- */

app.get('/api/projects/:id/page-checks', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const { readPageChecks } = await import('./lib/pagecheck.js');
  res.json((await readPageChecks(project.id)) || { total: 0 });
}));

/**
 * Cost is stated before anything runs. An AI Overview call is about a tenth
 * the price of a chat engine call, so this is cheap, but cheap is not free
 * and the person clicking should know the number.
 */
app.get('/api/projects/:id/page-checks/preview', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  /**
   * Both halves have to be there. Checking only for the property let a
   * project with a chosen property and no working token throw inside the
   * Google client, where it became a generic 500 with nothing to act on.
   */
  if (!project.ga4_refresh_token) {
    return res.status(400).json({ error: 'Google is not connected for this site yet.', fix: 'connect' });
  }
  if (!project.gsc_site_url) {
    return res.status(400).json({ error: 'Choose a Search Console property first.', fix: 'gsc' });
  }

  const { fetchPageQueries } = await import('./lib/pagecheck.js');
  let rows;
  try {
    rows = await fetchPageQueries(project, {
      limit: Math.min(Number(req.query.limit) || 5000, 5000),
      days: Math.min(Number(req.query.days) || 90, 480),
      // One impression is a real impression. Anything higher is the customer
      // saying they do not care about the tail, not us deciding for them.
      minImpressions: Math.max(Number(req.query.min) || 1, 1),
      path: String(req.query.path || '').slice(0, 200)
    });
  } catch (err) {
    // Google's own words are more use than ours, and the fix differs by cause.
    const msg = String(err.message || err);
    return res.status(400).json({
      error: /not connected/i.test(msg)
        ? 'The Google connection for this site is no longer valid. Reconnecting takes one screen.'
        : `Search Console would not return data: ${msg}`,
      fix: /not connected|invalid|401|403/i.test(msg) ? 'connect' : null
    });
  }
  // Everything, grouped by the page that earns it, with branded searches
  // flagged. The caller decides; the server does not pre-trim the list.
  const byPage = new Map();
  for (const r of rows) {
    const key = r.page || 'unknown';
    if (!byPage.has(key)) byPage.set(key, { page: key, impressions: 0, queries: [] });
    const g = byPage.get(key);
    g.impressions += r.impressions;
    g.queries.push(r);
  }

  const { sectionsFrom } = await import('./lib/pagecheck.js');

  res.json({
    queries: rows.length,
    branded: rows.filter((r) => r.branded).length,
    costPerQuery: 0.0025,
    // The site's own folders, so nobody has to guess at the shape of their
    // own URLs or work from an example taken from someone else's site.
    sections: sectionsFrom(rows),
    path: req.query.path || '',
    days: Number(req.query.days) || 90,
    minImpressions: Math.max(Number(req.query.min) || 1, 1),
    pages: [...byPage.values()].sort((a, b) => b.impressions - a.impressions)
  });
}));

app.post('/api/projects/:id/page-checks/run', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  if (!project.ga4_refresh_token) {
    return res.status(400).json({ error: 'Google is not connected for this site yet.', fix: 'connect' });
  }
  if (!project.gsc_site_url) {
    return res.status(400).json({ error: 'Choose a Search Console property first.', fix: 'gsc' });
  }

  const { runPageChecks } = await import('./lib/pagecheck.js');
  const limit = Math.min(Number(req.body?.limit) || 50, 250);
  const queries = Array.isArray(req.body?.queries) ? req.body.queries.slice(0, 250) : null;
  try {
    res.json(await runPageChecks(project.id, { limit, queries }));
  } catch (err) {
    const msg = String(err.message || err);
    res.status(400).json({
      error: /not connected/i.test(msg)
        ? 'The Google connection for this site is no longer valid. Reconnecting takes one screen.'
        : `The check could not run: ${msg}`,
      fix: /not connected|invalid|401|403/i.test(msg) ? 'connect' : null
    });
  }
}));

/* ---------------- aggregated report ---------------- */

app.get('/api/projects/:id/report', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const { buildReport } = await import('./lib/report.js');
  const report = await buildReport(project.id);
  const format = String(req.query.format || 'html');

  const stamp = new Date().toISOString().slice(0, 10);
  const slug = String(project.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  if (format === 'json') return res.json(report);

  if (format === 'csv') {
    const { reportCsv } = await import('./lib/report-html.js');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-actions-${stamp}.csv"`);
    return res.send(reportCsv(report));
  }

  const { reportHtml } = await import('./lib/report-html.js');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Opened in a tab so it can be read and printed to PDF, rather than
  // downloaded as a file nobody looks at.
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-ai-visibility-${stamp}.html"`);
  }
  res.send(reportHtml(report));
}));

/**
 * Questions from a topic. Returned for approval rather than saved: a generated
 * question is a suggestion until someone who knows the business agrees.
 */
app.post('/api/projects/:id/prompts/from-topic', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const topic = String(req.body?.topic || '').trim();
  if (topic.length < 3) return res.status(400).json({ error: 'Give it a topic to work from.' });

  const { questionsForTopic } = await import('./lib/prompts.js');
  const existing = new Set(
    (await many('SELECT lower(text) AS t FROM prompts WHERE project_id = $1', [project.id])).map((r) => r.t)
  );

  let questions = [];
  try {
    questions = await questionsForTopic({
      topic,
      brand: project.brand_name,
      domain: project.domain,
      category: project.category,
      market: project.market,
      qualifier: project.qualifier
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not generate questions: ${err.message}` });
  }

  if (!questions.length) {
    return res.status(502).json({ error: 'Nothing usable came back. Try a more specific topic, or write the question yourself.' });
  }

  res.json({
    topic,
    questions: questions.map((q) => ({ text: q, duplicate: existing.has(q.toLowerCase()) }))
  });
}));

/* ---------------- buyer personas ---------------- */

app.get('/api/projects/:id/personas', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const { listPersonas } = await import('./lib/personas.js');
  const personas = await listPersonas(project.id);

  /**
   * The questions each buyer type is actually asking.
   *
   * Without these the card looks identical whether it has no questions or
   * twenty, so "Add their questions" reads the same either way and the only
   * feedback is being told it is already done.
   */
  const rows = await many(
    `SELECT pr.persona_id, pr.id, pr.text, pr.active, pe.descriptor
     FROM prompts pr JOIN personas pe ON pe.id = pr.persona_id
     WHERE pr.project_id = $1 ORDER BY pr.id`,
    [project.id]
  );

  const byPersona = new Map();
  for (const r of rows) {
    if (!byPersona.has(r.persona_id)) byPersona.set(r.persona_id, []);
    // Stored with the descriptor prefixed, which is unreadable in a list.
    const prefix = String(r.descriptor || '').replace(/[.]+$/, '');
    byPersona.get(r.persona_id).push({
      id: r.id,
      text: r.text.startsWith(prefix) ? r.text.slice(prefix.length + 2) : r.text,
      active: r.active
    });
  }

  res.json({
    personas: personas.map((p) => ({ ...p, questions: byPersona.get(p.id) || [] }))
  });
}));

/** Remove one question from a buyer type without removing the buyer type. */
app.delete('/api/personas/:personaId/questions/:promptId', requireAuth, wrap(async (req, res) => {
  const row = await one(
    `DELETE FROM prompts pr USING personas pe, projects p
     WHERE pr.id = $1 AND pr.persona_id = $2 AND pe.id = pr.persona_id
       AND p.id = pr.project_id AND p.org_id = $3
     RETURNING pr.id`,
    [Number(req.params.promptId), Number(req.params.personaId), req.session.orgId]
  );
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

/**
 * Suggest personas from whatever evidence exists. Search Console first,
 * because those are questions real people typed on their way here.
 */
app.post('/api/projects/:id/personas/suggest', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const { suggestPersonas } = await import('./lib/personas.js');

  let gscQueries = [];
  try {
    if (project.gsc_site_url && project.ga4_refresh_token) {
      const { fetchQueries } = await import('./lib/gsc.js');
      gscQueries = await fetchQueries(project, { days: 90, limit: 200 });
    }
  } catch {
    // Personas are still worth suggesting without it; they are just weaker.
  }

  let pageText = '';
  try {
    const { fetchPage } = await import('./lib/discover.js');
    const page = await fetchPage(`https://${project.domain}`);
    pageText = page?.text || '';
  } catch {
    /* the site may be unreachable */
  }

  const personas = await suggestPersonas(project, { gscQueries, pageText });
  res.json({
    personas,
    evidence: {
      searchConsole: gscQueries.length,
      site: Boolean(pageText),
      // Said plainly, because a persona from a category name is a guess and
      // the customer should know which of these they are looking at.
      note: gscQueries.length
        ? `Derived from ${gscQueries.length} real search queries.`
        : pageText
          ? 'Derived from your site, since Search Console is not connected. Connecting it makes these considerably better.'
          : 'Derived from your category alone. These are guesses until Search Console is connected.'
    }
  });
}));

app.post('/api/projects/:id/personas', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const { savePersona } = await import('./lib/personas.js');

  const chosen = Array.isArray(req.body?.personas) ? req.body.personas : [];
  if (!chosen.length) return res.status(400).json({ error: 'Nothing to save' });

  const saved = [];
  for (const p of chosen.slice(0, 6)) {
    if (!p?.name || !p?.descriptor) continue;
    saved.push(await savePersona(project.id, p));
  }
  res.json({ saved: saved.length, personas: saved });
}));

app.patch('/api/personas/:personaId', requireAuth, wrap(async (req, res) => {
  const row = await one(
    `UPDATE personas pe SET
       active = COALESCE($3, pe.active),
       descriptor = COALESCE(NULLIF($4,''), pe.descriptor)
     FROM projects p
     WHERE pe.id = $1 AND p.id = pe.project_id AND p.org_id = $2
     RETURNING pe.*`,
    [Number(req.params.personaId), req.session.orgId, req.body?.active ?? null, req.body?.descriptor ?? '']
  );
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
}));

app.delete('/api/personas/:personaId', requireAuth, wrap(async (req, res) => {
  const row = await one(
    `DELETE FROM personas pe USING projects p
     WHERE pe.id = $1 AND p.id = pe.project_id AND p.org_id = $2 RETURNING pe.id`,
    [Number(req.params.personaId), req.session.orgId]
  );
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

/**
 * Add a persona's version of the questions already being tracked.
 *
 * Explicit rather than automatic: each one multiplies the question count and
 * therefore the bill, so the customer chooses and sees the cost first.
 */
/**
 * Show what would be added before adding it.
 *
 * Adding questions someone has not read, to something they are billed for,
 * is not a reasonable thing to ask of a single click. The Search Console
 * import already previews; this should have too.
 */
app.get('/api/personas/:personaId/preview', requireAuth, wrap(async (req, res) => {
  const persona = await one(
    `SELECT pe.*, p.id AS project_id FROM personas pe JOIN projects p ON p.id = pe.project_id
     WHERE pe.id = $1 AND p.org_id = $2`,
    [Number(req.params.personaId), req.session.orgId]
  );
  if (!persona) return res.status(404).json({ error: 'Not found' });

  const { asPersona } = await import('./lib/personas.js');
  const base = await many(
    `SELECT id, text, cluster, intent, ai_search_volume FROM prompts
     WHERE project_id = $1 AND persona_id IS NULL AND active
     ORDER BY ai_search_volume DESC NULLS LAST LIMIT 20`,
    [persona.project_id]
  );

  // Anything already added should be shown as such rather than offered twice.
  const existing = new Set(
    (await many('SELECT text FROM prompts WHERE project_id = $1 AND persona_id = $2', [persona.project_id, persona.id]))
      .map((r) => r.text)
  );

  res.json({
    persona: { id: persona.id, name: persona.name, descriptor: persona.descriptor },
    questions: base.map((q) => ({
      baseId: q.id,
      original: q.text,
      text: asPersona(q.text, persona),
      cluster: q.cluster,
      volume: q.ai_search_volume,
      alreadyAdded: existing.has(asPersona(q.text, persona))
    }))
  });
}));

app.post('/api/personas/:personaId/apply', requireAuth, wrap(async (req, res) => {
  const persona = await one(
    `SELECT pe.*, p.id AS project_id FROM personas pe JOIN projects p ON p.id = pe.project_id
     WHERE pe.id = $1 AND p.org_id = $2`,
    [Number(req.params.personaId), req.session.orgId]
  );
  if (!persona) return res.status(404).json({ error: 'Not found' });

  const { asPersona } = await import('./lib/personas.js');

  // Explicit ids where the customer has chosen; the old top-N behaviour only
  // as a fallback.
  const chosen = Array.isArray(req.body?.baseIds) ? req.body.baseIds.map(Number).filter(Boolean) : null;
  const base = chosen?.length
    ? await many(
        `SELECT text, cluster, intent, ai_search_volume FROM prompts
         WHERE project_id = $1 AND persona_id IS NULL AND id = ANY($2::int[])`,
        [persona.project_id, chosen]
      )
    : await many(
        `SELECT text, cluster, intent, ai_search_volume FROM prompts
         WHERE project_id = $1 AND persona_id IS NULL AND active
         ORDER BY ai_search_volume DESC NULLS LAST LIMIT $2`,
        [persona.project_id, Math.min(Number(req.body?.limit) || 5, 15)]
      );

  let added = 0;
  for (const q of base) {
    const r = await query(
      `INSERT INTO prompts (project_id, text, cluster, intent, ai_search_volume, source, persona_id, active)
       VALUES ($1,$2,$3,$4,$5,'persona',$6,true)
       ON CONFLICT (project_id, text) DO NOTHING`,
      [persona.project_id, asPersona(q.text, persona), q.cluster, q.intent, q.ai_search_volume, persona.id]
    );
    added += r.rowCount;
  }

  res.json({ added, persona: persona.name });
}));

/** Did the last assignment email actually send? */
app.get('/api/notifications/last-assignment', requireAuth, wrap(async (req, res) => {
  const row = await one(
    `SELECT emailed, email_error, title, created_at FROM notifications
     WHERE kind = 'assignment' ORDER BY created_at DESC LIMIT 1`
  );
  res.json(row || {});
}));

/** Whether each persona is actually changing the answer. */
app.get('/api/projects/:id/personas/lift', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const { personaLift } = await import('./lib/personas.js');
  const cycle = (await one('SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1', [project.id]))?.d;
  if (!cycle) return res.json({ lift: [], note: 'Nothing measured yet.' });
  res.json({ lift: await personaLift(project.id, cycle), cycle });
}));

/* ---------------- cross-account protection ---------------- */

/**
 * Google posts here when one of our users' Google accounts is compromised,
 * disabled, or has its grants revoked.
 *
 * Deliberately unauthenticated: the signature on the token is the
 * authentication, and anything that does not verify is recorded and
 * discarded. Always answers 202, because arguing with Google's delivery
 * retries helps nobody.
 */
app.post('/api/security/risc', express.text({ type: '*/*', limit: '256kb' }), wrap(async (req, res) => {
  const { verifyToken, applyEvent, logEvent } = await import('./lib/risc.js');
  const raw = typeof req.body === 'string' ? req.body : String(req.body || '');

  let claims = null;
  try {
    claims = await verifyToken(raw.trim(), { audience: process.env.GOOGLE_CLIENT_ID });
  } catch (err) {
    await logEvent({ verified: false, claims: null, actions: [], error: String(err.message), raw });
    // 202 even on rejection: a public endpoint should not tell a prober
    // whether its forgery was close.
    return res.status(202).end();
  }

  try {
    const actions = await applyEvent(claims);
    await logEvent({ verified: true, claims, actions, raw });

    // A dropped connection is something the customer will notice, so we
    // should know before they ask.
    const dropped = actions.filter((a) => /disconnected [1-9]/.test(a.action));
    if (dropped.length) {
      const { notify } = await import('./lib/notify.js');
      notify({
        kind: 'problem',
        title: 'Google security event: connections dropped',
        subject: 'Cited: a Google account event disconnected a customer',
        lead: 'Google reported a problem with a connected account, so we removed the stored credential. The customer will need to reconnect.',
        rows: dropped.map((d) => [d.email || 'unknown', d.action])
      });
    }
  } catch (err) {
    // A duplicate jti means we have already acted on this token.
    await logEvent({ verified: true, claims, actions: [], error: String(err.message), raw }).catch(() => {});
  }

  res.status(202).end();
}));

/**
 * A GET here is a person checking the endpoint exists, not Google. Answering
 * with an Express 404 page looks like the receiver is missing when it is not,
 * so say plainly what this is.
 */
app.get('/api/security/risc', (_req, res) => {
  res.json({
    endpoint: 'Cross-Account Protection receiver',
    accepts: 'POST application/secevent+jwt',
    status: 'ready',
    note: 'Security Event Tokens are verified against Google\'s published keys. Anything unsigned is recorded and discarded.'
  });
});

/** Proof the endpoint is live and what it has seen. */
app.get('/api/security/risc/status', requireAuth, wrap(async (_req, res) => {
  const { recentEvents, eventCounts } = await import('./lib/risc.js');
  res.json({ counts: await eventCounts(), recent: await recentEvents(20) });
}));

/* ---------------- assigned tasks ---------------- */

/**
 * A signed link to everything assigned to one address.
 *
 * The person given the work is often outside the account: a contractor, a
 * client's marketing lead. Sending them to a dashboard they cannot open is
 * the same as sending them nothing, so the token is the authorisation and it
 * is scoped to that address alone.
 */
function tasksLinkFor(email, orgId, req) {
  const token = signState({ a: String(email).toLowerCase(), o: orgId });
  return `${req.protocol}://${req.get('host')}/tasks?t=${encodeURIComponent(token)}`;
}

app.get('/tasks', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'tasks.html'));
});

app.get('/api/tasks', wrap(async (req, res) => {
  // Thirty days, because a task list is not a session and a link in an email
  // gets opened days later.
  const state = readState(req.query.t, 30 * 24 * 60 * 60 * 1000);
  if (!state?.a) return res.status(401).json({ error: 'That link has expired. Ask for a new one.' });

  const rows = await many(
    `SELECT r.id, r.title, r.action, r.status, r.due_date, r.notes, r.type, r.priority,
            r.target_url, r.evidence, p.name AS site, p.domain
     FROM recommendations r
     JOIN projects p ON p.id = r.project_id
     WHERE p.org_id = $1 AND lower(r.assignee) = $2
     ORDER BY
       CASE WHEN r.due_date IS NOT NULL AND r.due_date < CURRENT_DATE AND r.status IN ('open','doing') THEN 0 ELSE 1 END,
       r.due_date NULLS LAST, r.priority DESC`,
    [state.o, state.a]
  );

  res.json({ assignee: state.a, tasks: rows });
}));

/** The assignee can move their own tasks along, which is the point of sending it. */
app.patch('/api/tasks/:id', wrap(async (req, res) => {
  const state = readState(req.query.t, 30 * 24 * 60 * 60 * 1000);
  if (!state?.a) return res.status(401).json({ error: 'That link has expired.' });

  const status = String(req.body?.status || '');
  if (!['open', 'doing', 'done'].includes(status)) return res.status(400).json({ error: 'Unknown status' });

  const row = await one(
    `UPDATE recommendations r SET
       status = $3,
       started_at = CASE WHEN $3 = 'doing' AND r.started_at IS NULL THEN now() ELSE r.started_at END,
       completed_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END,
       overdue_notified_at = CASE WHEN $3 = 'done' THEN r.overdue_notified_at ELSE NULL END,
       updated_at = now()
     FROM projects p
     WHERE r.id = $1 AND p.id = r.project_id AND p.org_id = $2 AND lower(r.assignee) = $4
     RETURNING r.id, r.status`,
    [Number(req.params.id), state.o, status, state.a]
  );
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
}));

/** Everyone with work, across every site on the account. */
app.get('/api/assigned', requireAuth, wrap(async (req, res) => {
  const rows = await many(
    `SELECT r.id, r.title, r.status, r.due_date, r.assignee, r.priority, r.type,
            p.id AS project_id, p.name AS site,
            (r.due_date IS NOT NULL AND r.due_date < CURRENT_DATE AND r.status IN ('open','doing')) AS overdue
     FROM recommendations r
     JOIN projects p ON p.id = r.project_id
     WHERE p.org_id = $1 AND r.assignee IS NOT NULL AND r.assignee <> ''
     ORDER BY lower(r.assignee), r.due_date NULLS LAST, r.priority DESC`,
    [req.session.orgId]
  );

  const people = new Map();
  for (const r of rows) {
    const key = r.assignee.toLowerCase();
    if (!people.has(key)) {
      people.set(key, { assignee: r.assignee, open: 0, doing: 0, done: 0, overdue: 0, tasks: [] });
    }
    const p = people.get(key);
    if (p[r.status] !== undefined) p[r.status] += 1;
    if (r.overdue) p.overdue += 1;
    p.tasks.push(r);
  }

  res.json({
    people: [...people.values()].sort((a, b) => b.overdue - a.overdue || b.open + b.doing - (a.open + a.doing)),
    unassigned: (await one(
      `SELECT COUNT(*)::int AS n FROM recommendations r JOIN projects p ON p.id = r.project_id
       WHERE p.org_id = $1 AND (r.assignee IS NULL OR r.assignee = '') AND r.status IN ('open','doing')`,
      [req.session.orgId]
    )).n
  });
}));

/** A fresh link for an assignee, to paste or resend. */
app.get('/api/assigned/:email/link', requireAuth, wrap(async (req, res) => {
  res.json({ url: tasksLinkFor(req.params.email, req.session.orgId, req) });
}));

/* ---------------- feedback ---------------- */

const FEEDBACK_KINDS = ['bug', 'idea', 'confusing', 'praise', 'other'];

/**
 * Open to signed-out visitors as well, because the public demo is where the
 * first impression forms and that is exactly the feedback worth having.
 */
app.post('/api/feedback', wrap(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (message.length < 4) return res.status(400).json({ error: 'Tell us a little more than that' });
  if (message.length > 4000) return res.status(400).json({ error: 'That is longer than we can store. Trim it a little.' });

  const kind = FEEDBACK_KINDS.includes(req.body?.kind) ? req.body.kind : 'other';
  const email =
    String(req.body?.email || '').trim().toLowerCase() ||
    (req.session?.userId ? (await one('SELECT email FROM users WHERE id = $1', [req.session.userId]))?.email : null);

  // Whatever the browser can tell us, so a report is actionable without a
  // follow-up conversation.
  const context = {
    view: String(req.body?.view || '').slice(0, 40),
    projectId: Number(req.body?.projectId) || null,
    path: String(req.body?.path || '').slice(0, 200),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    viewport: String(req.body?.viewport || '').slice(0, 20),
    startedAt: STARTED_AT
  };

  const row = await one(
    'INSERT INTO feedback (org_id, user_email, kind, message, context) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [req.session?.orgId || null, email, kind, message, JSON.stringify(context)]
  );

  console.log(`Feedback #${row.id} [${kind}] from ${email || 'anonymous'}: ${message.slice(0, 120)}`);
  notifyFeedback({ kind, message, email, view: context.view });
  res.json({ ok: true, id: row.id });
}));

/** Read the queue from the shell: npm run feedback */
app.get('/api/feedback', requireAuth, wrap(async (req, res) => {
  // Only the org that owns the deployment should see everything, so this is
  // scoped to the caller's own organisation.
  const rows = await many(
    `SELECT id, kind, message, user_email, context, status, created_at
     FROM feedback WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.session.orgId]
  );
  res.json(rows);
}));

/* ---------------- category landscape ---------------- */

/**
 * Reads a pre-built corpus rather than asking questions live, so it costs
 * pennies and does not touch the customer's cycle allowance. Cached briefly
 * because the underlying data moves slowly and clicking about should be free.
 */
const landscapeCache = new Map();

app.get('/api/projects/:id/landscape', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  if (!mentionsConfigured) return res.status(503).json({ error: 'DataForSEO credentials are not set on this deployment' });

  const platform = PLATFORMS[req.query.platform] ? req.query.platform : 'google';
  const key = `${project.id}:${platform}`;
  const hit = landscapeCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return res.json({ ...hit.data, cached: true });

  // The category, not the brand. These fields hold prose written for a person,
  // and a thirty-word description is not a search term, so reduce it first.
  const { toKeyword } = await import('./lib/mentions.js');
  const keywords = [...new Set([
    toKeyword(project.category, { words: 4 }),
    toKeyword(project.category, { words: 2 }),
    toKeyword(`${project.category} ${project.market === 'AE' ? 'uae' : ''}`, { words: 5 })
  ])].filter((k) => k.length > 3).slice(0, 3);

  if (!keywords.length) {
    return res.status(400).json({ error: 'Fill in what the business does on the Setup tab first, in a few plain words.' });
  }

  const rivals = await many(
    "SELECT name, domain FROM entities WHERE project_id = $1 ORDER BY kind DESC, name",
    [project.id]
  );

  try {
    const data = await landscape({
      keywords,
      // Domains are more reliable targets than brand names, which collide.
      targets: [project.domain, ...rivals.map((r) => r.domain).filter(Boolean)].slice(0, 10),
      market: project.market,
      platform
    });
    const payload = { ...data, keywords, brand: project.brand_name, ownDomain: project.domain };
    landscapeCache.set(key, { at: Date.now(), data: payload });
    res.json(payload);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
}));

app.get('/api/landscape/platforms', (_req, res) => res.json(PLATFORMS));

/* ---------------- Search Console ---------------- */

app.get('/api/projects/:id/gsc', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  res.json({
    connected: Boolean(project.ga4_refresh_token) || Boolean(process.env.GOOGLE_REFRESH_TOKEN),
    email: project.ga4_account_email,
    siteUrl: project.gsc_site_url
  });
}));

app.get('/api/projects/:id/gsc/sites', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  // If we know what was granted, say so before spending a round trip.
  //
  // This is now the normal path rather than an edge case: Analytics and
  // Search Console are requested separately, so a fresh connection reaches
  // here too. Telling someone their connection is old would be wrong and
  // would contradict the instruction underneath it.
  const { hasSearchConsoleScope } = await import('./lib/ga4.js');
  if (hasSearchConsoleScope(project) === false) {
    return res.status(400).json({
      error: 'Search Console access has not been granted for this connection yet.',
      fix: 'reconnect'
    });
  }

  try {
    res.json({ sites: await listGscSites(project) });
  } catch (err) {
    res.status(400).json({
      error: String(err.message || err),
      fix: err.fix || null,
      link: err.link || null,
      detail: err.detail || null
    });
  }
}));

app.post('/api/projects/:id/gsc/site', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const url = String(req.body?.siteUrl || '').trim();
  if (!url) return res.status(400).json({ error: 'Choose a property' });
  await query('UPDATE projects SET gsc_site_url = $2 WHERE id = $1', [project.id, url]);
  res.json({ ok: true });
}));

app.get('/api/projects/:id/gsc/candidates', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  /**
   * No Google connection at all is a different situation from a connection
   * missing a scope, and it was falling through to a generic error with no
   * button. The one case where the fix is a single click had no way forward.
   */
  if (!project.ga4_refresh_token) {
    return res.status(400).json({
      error: 'Google is not connected for this site yet.',
      fix: 'connect'
    });
  }
  try {
    res.json(await gscCandidates(project.id, { days: Math.min(180, Number(req.query.days) || 90) }));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err), fix: err.fix || null, link: err.link || null });
  }
}));

app.post('/api/projects/:id/gsc/import', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const chosen = Array.isArray(req.body?.questions) ? req.body.questions : [];
  if (!chosen.length) return res.status(400).json({ error: 'Choose at least one question' });

  const ent = await getEntitlements(req.session.orgId);
  const active = await one('SELECT COUNT(*)::int AS n FROM prompts WHERE project_id = $1 AND active', [project.id]);
  const room = ent.plan.questions - active.n;
  if (room <= 0) {
    return res.status(402).json({
      error: `The ${ent.plan.name} plan allows ${ent.plan.questions} active questions per site. Pause one or upgrade to import more.`,
      upgrade: true
    });
  }

  const added = await importQuestions(project.id, chosen.slice(0, room));
  res.json({ ok: true, added, skipped: Math.max(0, chosen.length - room), room });
}));

/* ---------------- Google Analytics ---------------- */

const ga4Redirect = (req) => `${req.protocol}://${req.get('host')}/api/ga4/callback`;

app.get('/api/projects/:id/ga4', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  res.json({
    configured: oauthConfigured,
    connected: Boolean(project.ga4_refresh_token) || Boolean(process.env.GOOGLE_REFRESH_TOKEN),
    ownConnection: Boolean(project.ga4_refresh_token),
    email: project.ga4_account_email,
    propertyId: project.ga4_property_id || process.env.GA4_PROPERTY_ID || null,
    propertyName: project.ga4_property_name,
    connectedAt: project.ga4_connected_at,
    syncedAt: project.ga4_synced_at
  });
}));

app.get('/api/projects/:id/ga4/connect', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  if (!oauthConfigured) return res.status(503).json({ error: 'Google sign-in is not configured on this deployment' });
  // Ask only for what is being connected. "?what=gsc" requests Search
  // Console alone, and Google adds it to any grant already given.
  const what = ['ga4', 'gsc', 'both'].includes(String(req.query.what)) ? String(req.query.what) : 'ga4';
  res.json({
    url: authUrl({
      redirectUri: ga4Redirect(req),
      state: signState({ p: project.id, o: req.session.orgId, w: what }),
      what
    })
  });
}));

// Google sends the visitor back here after the consent screen.
/**
 * Google returns a bare code like "access_denied", which tells the person
 * nothing and tells us less. The most common cause is not the person at all:
 * analytics.readonly and webmasters.readonly are sensitive scopes, so until
 * the app is verified only listed test users can connect.
 */
const OAUTH_ERRORS = {
  access_denied:
    'Google would not allow that connection. Either consent was declined, or this account is not yet permitted to connect. If you did not decline, tell us and we will sort it out, since it is usually something we need to fix rather than you.',
  admin_policy_enforced:
    'Your Google Workspace administrator blocks third-party apps from accessing Analytics and Search Console. They can allow it for this app specifically.',
  disallowed_useragent: 'Google blocks sign-in from inside this browser. Open cited.ae in Chrome or Safari directly and try again.',
  org_internal: 'This Google account belongs to an organisation that only permits internal apps.',
  invalid_client: 'Our Google connection is misconfigured. That is on us, and it is already logged.',
  redirect_uri_mismatch: 'Our Google connection is misconfigured. That is on us, and it is already logged.'
};

app.get('/api/ga4/callback', wrap(async (req, res) => {
  // The project id rides along so the person lands back where they started
  // rather than on whichever site happens to be first.
  const early = readState(req.query.state);
  const site = early?.p ? `&site=${early.p}` : '';
  const fail = (msg) => res.redirect(`/app?ga4=error&message=${encodeURIComponent(msg)}${site}`);

  if (req.query.error) {
    const code = String(req.query.error);
    // Configuration faults are ours to know about, not the customer's to report.
    if (['invalid_client', 'redirect_uri_mismatch', 'access_denied'].includes(code)) {
      const { notify } = await import('./lib/notify.js');
      notify({
        kind: 'problem',
        title: `Google connection refused: ${code}`,
        subject: `Cited: a Google connection was refused (${code})`,
        lead:
          code === 'access_denied'
            ? 'Usually means the OAuth app is still in Testing, so only listed test users can connect. Check the consent screen publishing status.'
            : 'The OAuth client is misconfigured.',
        rows: [['Error', code], ['Project', String(early?.p || 'unknown')]]
      });
    }
    return fail(OAUTH_ERRORS[code] || `Google refused the connection (${code}).`);
  }
  const state = early;
  if (!state) return res.redirect(`/app?ga4=error&message=${encodeURIComponent('That authorisation link expired. Try connecting again.')}`);
  if (!req.session?.orgId || req.session.orgId !== state.o) return fail('Sign in and try connecting again.');

  const project = await one('SELECT id FROM projects WHERE id = $1 AND org_id = $2', [state.p, state.o]);
  if (!project) return fail('Site not found');

  try {
    const creds = await exchangeCode({ code: String(req.query.code || ''), redirectUri: ga4Redirect(req) });
    await storeConnection(project.id, creds);
    res.redirect(`/app?ga4=connected&site=${project.id}`);
  } catch (err) {
    fail(err.message);
  }
}));

/**
 * Google accounts already connected elsewhere on this org. An agency running
 * twenty clients off one Google login should not repeat OAuth twenty times.
 */
app.get('/api/ga4/connections', requireAuth, wrap(async (req, res) => {
  const rows = await many(
    `SELECT ga4_account_email AS email,
            COUNT(*)::int AS sites,
            MIN(id)::int AS source_project_id
     FROM projects
     WHERE org_id = $1 AND ga4_refresh_token IS NOT NULL AND ga4_account_email IS NOT NULL
     GROUP BY ga4_account_email
     ORDER BY sites DESC`,
    [req.session.orgId]
  );
  res.json({ connections: rows });
}));

/** Copy an existing authorisation onto another site in the same org. */
app.post('/api/projects/:id/ga4/reuse', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;

  const source = await one(
    `SELECT ga4_refresh_token, ga4_account_email FROM projects
     WHERE org_id = $1 AND ga4_account_email = $2 AND ga4_refresh_token IS NOT NULL
     LIMIT 1`,
    [req.session.orgId, String(req.body?.email || '')]
  );
  if (!source) return res.status(404).json({ error: 'That Google account is not connected on this account' });

  await query(
    `UPDATE projects SET ga4_refresh_token = $2, ga4_account_email = $3, ga4_connected_at = now(),
                         ga4_property_id = NULL, ga4_property_name = NULL
     WHERE id = $1`,
    [project.id, source.ga4_refresh_token, source.ga4_account_email]
  );
  res.json({ ok: true });
}));

app.get('/api/projects/:id/ga4/properties', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  try {
    res.json({ properties: await listProperties(project) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
}));

app.post('/api/projects/:id/ga4/property', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  const id = String(req.body?.propertyId || '').replace(/\D/g, '');
  if (!id) return res.status(400).json({ error: 'Choose a property' });
  await query('UPDATE projects SET ga4_property_id = $2, ga4_property_name = $3 WHERE id = $1', [
    project.id, id, String(req.body?.propertyName || '').slice(0, 200) || null
  ]);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/ga4/disconnect', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  await ga4Disconnect(project.id);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/sync-ga4', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  try {
    res.json(await syncGa4(project.id));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
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

// Legal pages. Google's OAuth verification requires both to be reachable at
// stable URLs on the same domain as the app.
// The public visibility index. Served from a stored snapshot, so promoting it
// costs nothing per visitor.
app.get('/uae', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'uae.html'));
});

// The regional index. Measured per home market, so it is a separate page
// rather than a filter on the UAE one.
app.get('/mena', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'mena.html'));
});

// Sector deep-dive. Served from the stored study, so no visitor triggers a
// measurement and the page costs nothing to promote.
app.get('/uae/property-developers', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'property-developers.html'));
});

app.get('/api/public/study/:slug', wrap(async (req, res) => {
  const { scoreStudy } = await import('./lib/score.js');
  try {
    const data = await scoreStudy(String(req.params.slug));

    // Named in the disclosure, taken from the data so it cannot drift.
    const clients = await many(
      `SELECT name FROM sector_companies
       WHERE study_id = (SELECT id FROM sector_studies WHERE slug = $1)
         AND active AND (notes->>'commercial_relationship')::boolean IS TRUE
       ORDER BY name`,
      [String(req.params.slug)]
    );

    const payload = { ...data, clients: clients.map((c) => c.name) };
    const tag = `"${new Date(data.cycle).getTime()}-${data.developers.length}"`;
    res.setHeader('ETag', tag);
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    if (req.headers['if-none-match'] === tag) return res.status(304).end();
    res.json(payload);
  } catch (err) {
    res.status(404).json({ error: String(err.message || err) });
  }
}));

app.get('/api/public/mena', wrap(async (req, res) => {
  const { readMena } = await import('./lib/mena.js');
  const data = await readMena();
  const tag = `"${data.updatedAt ? new Date(data.updatedAt).getTime() : 0}-${data.totals.named}"`;
  res.setHeader('ETag', tag);
  res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
  if (req.headers['if-none-match'] === tag) return res.status(304).end();
  res.json(data);
}));

app.get('/api/public/index', wrap(async (req, res) => {
  const { readIndex } = await import('./lib/sectors.js');
  const data = await readIndex({ market: 'AE' });

  // A long cache here served the previous, empty snapshot for half an hour
  // after a successful refresh. Revalidate against the capture time instead,
  // so a refresh is visible immediately while repeat views stay cheap.
  const tag = `"${data.updatedAt ? new Date(data.updatedAt).getTime() : 0}-${data.totals.brands}"`;
  res.setHeader('ETag', tag);
  res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
  if (req.headers['if-none-match'] === tag) return res.status(304).end();
  res.json(data);
}));

for (const page of ['privacy', 'terms']) {
  app.get(`/${page}`, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, `${page}.html`));
  });
}

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
    mockMode: MOCK,
    notifications: emailConfigured,
    // Whether a customer can connect Google at all. Without this the only
    // symptom is a yellow bar inside the app, which someone has to notice
    // and report.
    googleSignIn: oauthConfigured,
    canonicalHost: CANONICAL_HOST || null,
    dataforseo: Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD),
    stripe: stripeEnabled,
    features: ['landing-page', 'scan-site', 'country-dropdown', 'fanout-queries', 'project-delete',
      'billing', 'annual-plans', 'current-plan-display', 'stripe-mode-recovery', 'upgrade-ux', 'neutral-examples', 'instructional-placeholders', 'engine-picker', 'google-ai-surfaces', 'inline-toggles', 'cycle-report', 'bulk-controls', 'live-cost', 'spend-cap', 'per-site-scheduling', 'run-all', 'cited-ae', 'renamed-cited', 'cost-accuracy', 'failure-reporting', 'engine-field-fix', 'retries', 'mock-visibility', 'canonical-host', 'public-demo', 'model-resolution', 'trends', 'task-board', 'ga4-oauth', 'legal-pages', 'ga4-multi-account', 'scan-fallbacks', 'sticky-project', 'source-classification', 'page-teardown', 'teardown-fallbacks', 'gsc-import', 'gsc-panel', 'list-filters', 'hidden-fix', 'gsc-diagnostics', 'ai-overview-fix', 'landscape', 'landscape-target-fix', 'uae-index', 'mentions-probe', 'target-objects', 'mentions-live', 'beta-feedback', 'index-cache-fix', 'sectors-25-known', 'brands-vs-sources', 'named-vs-cited', 'trial-logging', 'snapshot-compat', 'platform-params', 'notifications', 'notification-log', 'share-images', 'citation-advice', 'rules-fix', 'public-feedback-widget', 'mobile', 'fintech-sector', 'mena-index', 'manual-only', 'coverage-guard', 'arabic-markets', 'locations-probe', 'language-sweep', 'locations-endpoint', 'verified-markets', 'sector-extraction', 'study-loader', 'domains-verified', 'alias-exclusions', 'study-runner', 'exclusion-scope', 'project-vs-corporate', 'ai-overview-async-on', 'study-scoring', 'developers-page', 'delete-actions', 'assignment-emails', 'overdue-chaser', 'email-page-urls', 'source-questions', 'openable-evidence', 'assignee-links', 'assigned-tab', 'live-cycle-feed', 'gemini-country-fix', 'oauth-errors', 'incremental-scopes', 'mobile-nav', 'developers-private', 'shared-footer', 'footer-feedback', 'footer-polish', 'structured-data', 'cross-account-protection', 'gsc-grant-copy', 'risc-probe', 'log-security-events', 'poster-generator', 'buyer-personas', 'persona-fallback', 'api-body-fix', 'persona-layout-grid', 'personas-narrative', 'persona-question-preview', 'questions-unrun', 'questions-by-persona', 'persona-card-questions', 'trademark-tm', 'ai-visibility-copy', 'gsc-connect-prompt', 'internal-accounts', 'aggregated-report', 'page-checks', 'question-filters', 'page-check-errors', 'page-check-picker', 'brand-filter', 'gsc-pagination', 'path-filter', 'site-sections', 'question-dropdowns', 'read-the-answer', 'longer-answers', 'questions-from-topic', 'run-unrun-only', 'run-menu', 'internal-no-limits', 'auto-teardown', 'report-visuals', 'resolve-redirects', 'resolve-retry', 'withdraw-stale-actions', 'source-filter', 'local-listings', 'sources-after-clean', 'prompt-events', 'csv-export', 'mail-diagnostics']
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
  console.log(`Cited listening on ${port}`);
  if (MOCK) {
    console.warn('MOCK_MODE is on. Answers are simulated and no engine is being called.');
  } else if (!process.env.DATAFORSEO_LOGIN) {
    console.warn('MOCK_MODE is off but DATAFORSEO_LOGIN is not set. Every cycle will fail.');
  }
});
