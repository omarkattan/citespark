import 'dotenv/config';
import { many, one, query, pool } from '../db/index.js';
import { askEngine, MOCK } from '../lib/dataforseo.js';
import { analyseRun } from '../lib/analyze.js';
import { buildRecommendations, persistRecommendations } from '../lib/recommend.js';
import { hasAnthropic } from '../lib/anthropic.js';
import { budgetForCycle, recordUsage } from '../lib/billing.js';

import { ENGINE_IDS } from '../lib/dataforseo.js';

/** Engines are chosen per project. The env var is only a fallback for old rows. */
function enginesFor(project) {
  const chosen = (project.engines?.length ? project.engines : (process.env.ENGINES || 'chatgpt').split(','))
    .map((e) => e.trim())
    .filter((e) => ENGINE_IDS.includes(e));
  return chosen.length ? chosen : ['chatgpt'];
}
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);

async function pooled(items, worker, limit = CONCURRENCY) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (err) {
        console.error('task failed:', err.message);
      }
    }
  });
  await Promise.all(workers);
}

export async function runCycleForProject(projectId, { cycleDate, onProgress } = {}) {
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new Error(`No project ${projectId}`);

  const cycle = cycleDate || new Date().toISOString().slice(0, 10);
  const prompts = await many('SELECT * FROM prompts WHERE project_id = $1 AND active', [projectId]);
  const entities = await many('SELECT * FROM entities WHERE project_id = $1', [projectId]);

  // A plan is a call budget. Trim the cycle to fit rather than overspending,
  // and stop entirely when the month's allowance is gone.
  const budget = await budgetForCycle(project.org_id, {
    questions: prompts.length,
    engines: enginesFor(project),
    runs: project.runs_per_cycle
  });

  if (!budget.ok) {
    console.log(`Cycle skipped for ${project.brand_name}: ${budget.reason}`);
    return { runs: 0, spend: 0, recommendations: 0, cycle, blocked: true, reason: budget.reason };
  }

  const jobs = [];
  for (const prompt of prompts) {
    for (const engine of budget.engines) {
      for (let i = 0; i < budget.runs; i++) {
        jobs.push({ prompt, engine, runIndex: i });
      }
    }
  }
  if (jobs.length > budget.maxCalls) jobs.length = budget.maxCalls;

  console.log(
    `Cycle ${cycle} for ${project.brand_name}: ${prompts.length} prompts x ${budget.engines.length} engines x ${budget.runs} runs = ${jobs.length} calls` +
      (budget.trimmed ? ' (trimmed to the remaining monthly allowance)' : '') +
      (MOCK ? ' (MOCK MODE, no spend)' : '')
  );

  let spend = 0;
  let done = 0;
  const report = (extra = {}) => onProgress?.({ done, total: jobs.length, spend, ...extra });
  report({ phase: 'asking' });

  await pooled(jobs, async ({ prompt, engine, runIndex }) => {
    const answer = await askEngine({
      engine,
      prompt: prompt.text,
      market: project.market,
      maxTokens: Number(process.env.MAX_OUTPUT_TOKENS || 700)
    });

    spend += answer.costUsd || 0;

    const run = await one(
      `INSERT INTO runs (prompt_id, project_id, engine, model, cycle_date, run_index, response_text, ok, error, cost_usd, fan_out_queries)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        prompt.id,
        projectId,
        engine,
        answer.model,
        cycle,
        runIndex,
        answer.text,
        answer.ok,
        answer.error,
        answer.costUsd || 0,
        answer.fanOut || []
      ]
    );

    if (!answer.ok) return;

    const results = await analyseRun({
      text: answer.text,
      entities,
      useModel: hasAnthropic && runIndex === 0
    });

    for (const r of results) {
      await query(
        `INSERT INTO mentions (run_id, entity_id, mentioned, ordinal, sentiment, snippet)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id, entity_id) DO NOTHING`,
        [run.id, r.entity_id, r.mentioned, r.ordinal, r.sentiment, r.snippet]
      );
    }

    for (const c of answer.citations) {
      await query('INSERT INTO citations (run_id, domain, url, position) VALUES ($1,$2,$3,$4)', [
        run.id,
        c.domain,
        c.url,
        c.position
      ]);
    }

    done++;
    report({ phase: 'asking' });
    if (done % 20 === 0) console.log(`  ${done}/${jobs.length} runs complete`);
  });

  await recordUsage(project.org_id, jobs.length, spend);

  report({ phase: 'thinking' });
  const recs = await buildRecommendations(projectId);
  await persistRecommendations(projectId, recs);

  const summary = await summarise(projectId, cycle, { runs: done, spend, recs, trimmed: budget.trimmed });
  console.log(`Done. ${done}/${jobs.length} usable runs, $${spend.toFixed(4)} spent, ${recs.length} recommendations.`);
  report({ phase: 'done', summary });
  return summary;
}

/**
 * What actually changed this cycle, in the terms a person cares about:
 * did visibility move, what is new to do, and what did it cost.
 */
async function summarise(projectId, cycle, { runs, spend, recs, trimmed }) {
  const rate = async (cycleDate) => {
    if (!cycleDate) return null;
    const row = await one(
      `SELECT SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS r
       FROM runs cr
       JOIN mentions m ON m.run_id = cr.id
       JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
       WHERE cr.project_id = $1 AND cr.cycle_date = $2 AND cr.ok`,
      [projectId, cycleDate]
    );
    return row?.r === null || row?.r === undefined ? null : Number(row.r);
  };

  const prev = await one(
    'SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok AND cycle_date < $2',
    [projectId, cycle]
  );

  const now = await rate(cycle);
  const before = await rate(prev?.d);

  const topSources = await many(
    `SELECT c.domain, COUNT(*)::int AS n
     FROM citations c JOIN runs r ON r.id = c.run_id
     WHERE r.project_id = $1 AND r.cycle_date = $2
     GROUP BY c.domain ORDER BY n DESC LIMIT 3`,
    [projectId, cycle]
  );

  const rivals = await many(
    `SELECT e.name, SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS rate
     FROM runs r JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'competitor'
     WHERE r.project_id = $1 AND r.cycle_date = $2 AND r.ok
     GROUP BY e.id ORDER BY rate DESC LIMIT 1`,
    [projectId, cycle]
  );

  const openCount = await one(
    "SELECT COUNT(*)::int AS n FROM recommendations WHERE project_id = $1 AND status = 'open'",
    [projectId]
  );

  return {
    cycle,
    runs,
    spend: Math.round(spend * 1000) / 1000,
    trimmed,
    recommendations: recs.length,
    openActions: openCount.n,
    visibility: now,
    visibilityBefore: before,
    delta: now !== null && before !== null ? now - before : null,
    topActions: recs.slice(0, 3).map((r) => ({ type: r.type, title: r.title, priority: r.priority })),
    topSources,
    topRival: rivals[0] ? { name: rivals[0].name, rate: Number(rivals[0].rate) } : null
  };
}

// Allow: npm run cycle  (all projects)  or  npm run cycle -- 1
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  const ids = arg ? [Number(arg)] : (await many('SELECT id FROM projects')).map((r) => r.id);
  for (const id of ids) await runCycleForProject(id);
  await pool.end();
}
