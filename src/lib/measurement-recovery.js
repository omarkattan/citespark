import { isDeepStrictEqual } from 'node:util';
import { introductionOnly } from './answer-eligibility.js';

const key = r => `${Number(r.prompt_id)}:${r.engine}:${Number(r.run_index)}`;

/** A recovery creates a new snapshot. Original answers and charges stay intact. */
export function recoveryPlan({ source, projectId, prompts, settings, rows }) {
  if (!source || Number(source.project_id) !== Number(projectId) || source.status !== 'failed' || source.legacy || source.purpose !== 'monitoring') {
    throw new Error('Recovery requires a failed, non-legacy monitoring measurement for this project.');
  }
  if (!isDeepStrictEqual(source.settings, settings)) throw new Error('Measurement settings changed. Recovery cannot mix different settings.');
  const plan = source.collection_plan;
  if (!Array.isArray(plan) || !plan.length) throw new Error('Recovery requires a recorded collection plan.');
  const active = new Map(prompts.map(p => [Number(p.id), p]));
  const planned = new Map();
  for (const item of plan) {
    if (!active.has(Number(item.prompt_id)) || active.get(Number(item.prompt_id)).text !== item.text) throw new Error('Question cohort changed. Restore the original questions before recovery.');
    if (!settings.engines.includes(item.engine) || !Number.isInteger(item.run_index) || item.run_index < 0 || item.run_index >= settings.runs || planned.has(key(item))) throw new Error('Invalid or duplicate collection plan slot.');
    planned.set(key(item), item);
  }
  if (new Set(plan.map(p => Number(p.prompt_id))).size !== active.size) throw new Error('Question cohort changed. Recovery cannot include new questions.');
  const stored = new Map();
  for (const row of rows) {
    if (Number(row.project_id) !== Number(projectId) || !planned.has(key(row)) || stored.has(key(row))) throw new Error('Stored answers do not match the recovery plan.');
    stored.set(key(row), row);
  }
  const inheritIds = [], jobs = [], reasons = { missing: 0, failed: 0, incomplete: 0 };
  for (const item of plan) {
    const row = stored.get(key(item));
    let reason = !row ? 'missing' : !row.ok ? 'failed' : null;
    if (row?.ok) {
      const text = String(row.response_text || '').trim();
      const expected = text && !introductionOnly(text) ? settings.entities.map(e => Number(e.id)) : [];
      const measured = new Set((row.entity_ids || []).map(Number));
      if (expected.some(id => !measured.has(id))) reason = 'incomplete';
    }
    if (reason) {
      reasons[reason]++;
      jobs.push({ prompt: active.get(Number(item.prompt_id)), engine: item.engine, runIndex: item.run_index });
    } else inheritIds.push(Number(row.id));
  }
  return { sourceId: source.id, plan, inheritIds, jobs, reasons };
}

export async function loadRecovery(db, projectId, sourceId, prompts, settings) {
  const source = (await db.query('SELECT * FROM measurement_batches WHERE id=$1 AND project_id=$2', [sourceId, projectId])).rows[0];
  const rows = (await db.query(`SELECT r.*, ARRAY(SELECT m.entity_id FROM mentions m WHERE m.run_id=r.id) AS entity_ids
    FROM measurement_answers a JOIN runs r ON r.id=a.run_id WHERE a.measurement_id=$1 AND r.project_id=$2`, [sourceId, projectId])).rows;
  return recoveryPlan({ source, projectId, prompts, settings, rows });
}

export async function inheritRecovery(db, batch, recovery) {
  // Validate membership again in SQL; never copy a row from another project.
  const result = await db.query(`INSERT INTO measurement_members(measurement_id,run_id)
    SELECT $1,r.id FROM runs r JOIN measurement_answers a ON a.run_id=r.id
    WHERE a.measurement_id=$2 AND r.project_id=$3 AND r.id=ANY($4::int[]) RETURNING run_id`,
    [batch.id, recovery.sourceId, batch.project_id, recovery.inheritIds]);
  if (result.rows.length !== recovery.inheritIds.length) throw new Error('Recovery evidence changed before inheritance.');
  await db.query('INSERT INTO method_notes(project_id,note,detail) VALUES ($1,$2,$3)', [batch.project_id,
    `Measurement ${batch.id} recovers interrupted measurement ${recovery.sourceId}`,
    `${recovery.inheritIds.length} saved records retained with their original timestamps. ${recovery.jobs.length} missing, failed or incomplete slots requested again. The original failed measurement and all charges remain in the archive. This is a recovered sample, not a new independent full scan.`]);
}
