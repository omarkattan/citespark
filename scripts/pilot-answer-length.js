import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { pool, one, many, query } from '../src/db/index.js';
import { ENGINES, resolveModel, askEngine, MOCK } from '../src/lib/dataforseo.js';
import { budgetForCycle, recordUsage } from '../src/lib/billing.js';
import { selectPilot, runPilotPair } from '../src/lib/answer-pilot.js';

async function main() {
  const args = process.argv.slice(2);
  if (!/^\d+$/.test(args[0] || '') || args.slice(1).some(a => a !== '--apply') || args.length > 2)
    throw new Error('Usage: node scripts/pilot-answer-length.js PROJECT_ID [--apply]');
  const project = await one('SELECT * FROM projects WHERE id=$1', [Number(args[0])]);
  if (!project) throw new Error('Project not found');
  const rows = await many(`SELECT DISTINCT ON (r.prompt_id,r.engine) r.*,p.text
    FROM runs r JOIN prompts p ON p.id=r.prompt_id
    WHERE r.project_id=$1 AND r.ok AND p.active AND r.engine=ANY($2::text[])
    ORDER BY r.prompt_id,r.engine,r.cycle_date DESC,r.id DESC`,
    [project.id, (project.engines || []).filter(e => ENGINES[e]?.kind === 'llm')]);
  const selected = selectPilot(rows);
  if (!selected.length) throw new Error('No flagged active assistant answers found. No calls made.');
  console.log(`${project.name}: ${selected.length} paired tests, ${selected.length * 2} answer requests. Provider transient retries may add attempts.`);
  console.log('700 versus 2000 tokens. Same resolved model within each pair. Results are stored separately from visibility measurements.');
  for (const row of selected) console.log(`${row.engine}: ${row.text}`);
  if (!args.includes('--apply')) { console.log('Preview only. Add --apply to run. No engine calls made.'); return; }
  if (MOCK) throw new Error('Pilot requires real provider credentials, not mock mode');
  // The connection lock prevents overlapping pilots for this project.
  const lock = await pool.connect();
  try {
    const { rows: locks } = await lock.query('SELECT pg_try_advisory_lock(280028,$1) AS locked', [project.id]);
    if (!locks[0].locked) throw new Error('A pilot is already running for this project');
    await query(`CREATE TABLE IF NOT EXISTS answer_length_pilots (
      id BIGSERIAL PRIMARY KEY, batch_id UUID NOT NULL, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      prompt_id INTEGER NOT NULL, source_run_id INTEGER NOT NULL, engine TEXT NOT NULL,
      question TEXT NOT NULL, market TEXT, location_name TEXT, result JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const batch = randomUUID(); let spend = 0;
    console.log(`Pilot batch: ${batch}`);
    for (const row of selected) {
      const model = await resolveModel(row.engine, ENGINES[row.engine], project.models?.[row.engine] || null);
      const results = await runPilotPair({ row, model,
        checkBudget: async () => {
          if (spend >= 1) throw new Error('Pilot stopped after reaching $1 in recorded charges. The last call can exceed this stop threshold.');
          const b = await budgetForCycle(project.org_id, { questions: 1, engines: [row.engine], runs: 1 });
          if (!b.ok || b.maxCalls < 1) throw new Error(b.reason || 'No checks available');
        },
        ask: opts => askEngine({ ...opts, market: project.market, locationName: project.location_name }),
        account: async cost => { spend += cost; await recordUsage(project.org_id, 1, cost); },
        save: result => query(`INSERT INTO answer_length_pilots
          (batch_id,project_id,prompt_id,source_run_id,engine,question,market,location_name,result)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [batch,project.id,row.prompt_id,row.id,row.engine,row.text,project.market,project.location_name,JSON.stringify(result)])
      });
      for (const r of results) console.log(JSON.stringify({engine:row.engine,limit:r.maxTokens,
        requestedModel:r.requestedModel,returnedModel:r.answer.model,ok:r.answer.ok,
        characters:r.answer.text?.length || 0,possiblyShort:r.possiblyShort,
        ending:r.answer.text?.slice(-240) || null,
        costUsd:r.answer.costUsd || 0,error:r.answer.error || null}));
    }
    console.log(`Recorded pilot cost: $${spend.toFixed(4)}. Global limit unchanged. No visibility runs or recommendations changed.`);
    console.log('Length flags are a heuristic. Review the stored answers before declaring them complete. A single pair is not a reliable cost forecast.');
  } finally {
    await lock.query('SELECT pg_advisory_unlock(280028,$1)', [project.id]);
    lock.release();
  }
}
try { await main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
finally { await pool.end(); }
