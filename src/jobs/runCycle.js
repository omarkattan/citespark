import 'dotenv/config';
import { many, one, query, pool } from '../db/index.js';
import { askEngine, MOCK } from '../lib/dataforseo.js';
import { analyseRun } from '../lib/analyze.js';
import { buildRecommendations, persistRecommendations } from '../lib/recommend.js';
import { hasAnthropic } from '../lib/anthropic.js';

const ENGINE_LIST = (process.env.ENGINES || 'chatgpt,gemini,perplexity').split(',').map((s) => s.trim());
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

export async function runCycleForProject(projectId, { cycleDate } = {}) {
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new Error(`No project ${projectId}`);

  const cycle = cycleDate || new Date().toISOString().slice(0, 10);
  const prompts = await many('SELECT * FROM prompts WHERE project_id = $1 AND active', [projectId]);
  const entities = await many('SELECT * FROM entities WHERE project_id = $1', [projectId]);

  const jobs = [];
  for (const prompt of prompts) {
    for (const engine of ENGINE_LIST) {
      for (let i = 0; i < project.runs_per_cycle; i++) {
        jobs.push({ prompt, engine, runIndex: i });
      }
    }
  }

  console.log(
    `Cycle ${cycle} for ${project.brand_name}: ${prompts.length} prompts x ${ENGINE_LIST.length} engines x ${project.runs_per_cycle} runs = ${jobs.length} calls${MOCK ? ' (MOCK MODE, no spend)' : ''}`
  );

  let spend = 0;
  let done = 0;

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
    if (done % 20 === 0) console.log(`  ${done}/${jobs.length} runs complete`);
  });

  const recs = await buildRecommendations(projectId);
  await persistRecommendations(projectId, recs);

  console.log(`Done. ${done}/${jobs.length} usable runs, $${spend.toFixed(4)} spent, ${recs.length} recommendations.`);
  return { runs: done, spend, recommendations: recs.length, cycle };
}

// Allow: npm run cycle  (all projects)  or  npm run cycle -- 1
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  const ids = arg ? [Number(arg)] : (await many('SELECT id FROM projects')).map((r) => r.id);
  for (const id of ids) await runCycleForProject(id);
  await pool.end();
}
