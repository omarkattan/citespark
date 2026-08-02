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
import { MOCK } from './lib/dataforseo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);
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
        citations: []
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
  await query(
    `UPDATE recommendations SET status = $1, updated_at = now()
     WHERE id = $2 AND project_id IN (SELECT id FROM projects WHERE org_id = $3)`,
    [status, Number(req.params.recId), req.session.orgId]
  );
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

/* ---------------- actions ---------------- */

app.post('/api/projects/:id/run', requireAuth, wrap(async (req, res) => {
  const project = await assertProject(req, res);
  if (!project) return;
  res.json({ ok: true, started: true, mock: MOCK });
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
app.use(express.static(publicDir, { index: false }));

app.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get('/', (req, res) => {
  if (!req.session?.userId) return res.redirect('/login');
  res.sendFile(path.join(publicDir, 'index.html'));
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
  console.log(`Cited listening on ${port}${MOCK ? ' [MOCK MODE]' : ''}`);
});
