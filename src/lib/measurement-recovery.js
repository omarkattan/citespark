import {answerFromPayload} from './dataforseo.js';
import { isDeepStrictEqual } from 'node:util';
import { introductionOnly } from './answer-eligibility.js';

const key = r => `${Number(r.prompt_id)}:${r.engine}:${Number(r.run_index)}`;

/** A recovery creates a new snapshot. Original answers and charges stay intact. */
export function recoveryPlan({ source, projectId, prompts, settings, rows }) {
  if (!source || Number(source.project_id) !== Number(projectId) || !['failed','partial','interrupted'].includes(source.status) || source.legacy || source.purpose !== 'monitoring') {
    throw new Error('Recovery requires an incomplete, non-legacy monitoring measurement for this project.');
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
    let reason = !row ? 'missing' : !row.ok ? 'failed' : ['incomplete','interrupted','cancelled','unsupported'].includes(row.check_state)?'incomplete':null;
    if (row?.ok) {
      const text = String(row.response_text || '').trim();
      if((!text&&!row.no_overview)||introductionOnly(text))reason='incomplete';
      const expected = text && !introductionOnly(text) ? settings.entities.map(e => Number(e.id)) : [];
      const measured = new Set((row.entity_ids || []).map(Number));
      if (expected.some(id => !measured.has(id))) reason = 'incomplete';
    }
    if (reason) {
      reasons[reason]++;
      jobs.push({ prompt: active.get(Number(item.prompt_id)), engine: item.engine, runIndex: item.run_index });
    } else inheritIds.push(Number(row.id));
  }
  return { sourceId: source.id, plan, inheritIds, retainedRows:rows.filter(r=>inheritIds.includes(Number(r.id))), jobs, reasons };
}

export async function loadRecovery(db, projectId, sourceId, prompts, settings) {
  const source = (await db.query('SELECT * FROM measurement_batches WHERE id=$1 AND project_id=$2', [sourceId, projectId])).rows[0];
  const rows = (await db.query(`SELECT r.*, (SELECT c.state FROM measurement_checks c WHERE c.measurement_id=$1 AND c.selected_run_id=r.id) AS check_state, ARRAY(SELECT m.entity_id FROM mentions m WHERE m.run_id=r.id) AS entity_ids
    FROM measurement_answers a JOIN runs r ON r.id=a.run_id WHERE a.measurement_id=$1 AND r.project_id=$2`, [sourceId, projectId])).rows;
  const recovery=recoveryPlan({ source, projectId, prompts, settings, rows });
  const attempts=(await db.query('SELECT * FROM provider_attempts WHERE measurement_id=$1 AND response IS NOT NULL ORDER BY started_at DESC',[sourceId])).rows;
  for(const job of recovery.jobs) {
   const a=attempts.find(a=>Number(a.prompt_id)===Number(job.prompt.id)&&a.engine===job.engine&&Number(a.run_index)===job.runIndex&&answerFromPayload(job.engine,a.response));
   if(a)job.savedAnswer={...answerFromPayload(job.engine,a.response),collectedAt:a.completed_at,replayedAttempt:a.id};
  }
  recovery.replay=recovery.jobs.filter(j=>j.savedAnswer).length;
  return recovery;
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
    `${recovery.inheritIds.length} saved records retained with their original timestamps. ${recovery.jobs.length-recovery.replay} unresolved slots requested again; ${recovery.replay||0} reconstructed from saved provider responses. The original failed measurement and all charges remain in the archive. This is a recovered sample, not a new independent full scan.`]);
}

/** Recover the recorded cohort, independent of today's project settings. */
export async function recoveryConfiguration(db,project,sourceId) {
 const source=(await db.query('SELECT * FROM measurement_batches WHERE id=$1 AND project_id=$2',[sourceId,project.id])).rows[0];
 if(!source || source.legacy || source.purpose!=='monitoring' || !['failed','partial','interrupted'].includes(source.status))throw new Error('Choose an incomplete monitoring measurement with recorded settings.');
 const s=source.settings;
 if(!Array.isArray(source.collection_plan)||!source.collection_plan.length||!s?.engines?.length||!Number.isInteger(s.runs)||!s.maxTokens||!s.entities?.length)throw new Error('This measurement is missing its recorded questions, entities, engines or output limit. A new baseline is required.');
 if(!['visible-text-v2','visible-text-v3-ar'].includes(s.detection))throw new Error(`Scoring policy ${s.detection||'unknown'} cannot be reproduced. Start a new baseline.`);
 const prompts=[...new Map(source.collection_plan.map(p=>[Number(p.prompt_id),{id:Number(p.prompt_id),text:p.text,source:p.source}])).values()];
 const actual=(await db.query('SELECT id FROM prompts WHERE project_id=$1 AND id=ANY($2::int[])',[project.id,prompts.map(p=>p.id)])).rows;
 if(actual.length!==prompts.length)throw new Error('An original question was deleted. Its identity cannot be restored safely. Start a new baseline.');
 const entities=(await db.query('SELECT id FROM entities WHERE project_id=$1 AND id=ANY($2::int[])',[project.id,s.entities.map(e=>e.id)])).rows;
 if(entities.length!==s.entities.length)throw new Error('An original measured entity was deleted. Start a new baseline.');
 const child=(await db.query('SELECT id,status FROM measurement_batches WHERE recovery_of=$1',[source.id])).rows[0];
 return {source,child,prompts,settings:s,entities:s.entities,project:{...project,market:s.market,location_name:s.locationName,engines:s.engines,models:s.models,runs_per_cycle:s.runs}};
}
