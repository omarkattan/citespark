import { one, query, pool } from '../db/index.js';

export async function lockMeasurements(projectId) {
 const client = await pool.connect();
 try {
   const { rows } = await client.query('SELECT pg_try_advisory_lock(290029,$1) AS locked',[projectId]);
   if (!rows[0].locked) throw new Error('A measurement is already running for this site.');
   // If we own the lock, any earlier running batch was interrupted.
   await client.query("UPDATE measurement_batches SET status='failed',completed_at=now() WHERE project_id=$1 AND status='running'",[projectId]);
 } catch (err) {
   try { await client.query('SELECT pg_advisory_unlock(290029,$1)',[projectId]); } finally { client.release(); }
   throw err;
 }
 return async () => { try { await client.query('SELECT pg_advisory_unlock(290029,$1)',[projectId]); } finally { client.release(); } };
}
export function measurementSettings(project, models, engines, runs, maxTokens, entities = []) {
 return {version:1,market:project.market,locationName:project.location_name || null,models,
   engines:[...engines].sort(),runs,maxTokens,
   ...(engines.some(e=>e==='ai_mode'||e==='ai_overview') ? {googleLocalePolicy:'country-map-v2-question-script-ar-en-v1'} : {}),
   detection:'visible-text-v2',
   entities:entities.map(e=>({id:e.id,name:e.name,aliases:e.aliases,domain:e.domain,kind:e.kind,ambiguous_name:e.ambiguous_name})).sort((a,b)=>a.id-b.id)};
}
export async function startMeasurement(projectId, day, settings) {
 const prior=await one('SELECT * FROM measurement_batches WHERE project_id=$1 AND status=\'completed\' ORDER BY cycle_date DESC,completed_at DESC,id DESC LIMIT 1',[projectId]);
 const batch=await one(`INSERT INTO measurement_batches(project_id,cycle_date,status,settings)
 VALUES ($1,$2,'running',$3::jsonb) RETURNING *`,[projectId,day,JSON.stringify(settings)]);
 if (prior && !(await one('SELECT settings=$2::jsonb AS same FROM measurement_batches WHERE id=$1',[prior.id,JSON.stringify(settings)]))?.same) {
   await query('INSERT INTO method_notes(project_id,note,detail) VALUES ($1,$2,$3)',[projectId,
    'Measurement settings changed',`Measurement ${batch.id} records a new settings snapshot. Previous settings may be different or unknown. Do not interpret differences as marketing impact. Assistant output limit: ${settings.maxTokens} tokens.`]);
 }
 return batch;
}
export async function finishMeasurement(id,status) {
 await query('UPDATE measurement_batches SET status=$2,completed_at=now() WHERE id=$1',[id,status]);
}
// Conservative: unknown legacy settings cannot support a like-for-like claim.
export async function comparableSettings(projectId, period={}) {
 const row=await one(`SELECT COUNT(*)::int AS n, BOOL_AND(NOT legacy) AS known,
 COUNT(DISTINCT settings)::int AS variants FROM published_measurements
 WHERE project_id=$1 AND ($2::date IS NULL OR cycle_date >= $2) AND ($3::date IS NULL OR cycle_date <= $3)`,
 [projectId,period.from || null,period.to || null]);
 return Boolean(row?.n >= 2 && row.known && row.variants===1);
}
export async function inheritMeasurement(batch, settings) {
 const prior=await one(`SELECT * FROM measurement_batches WHERE project_id=$1 AND status='completed'
 ORDER BY cycle_date DESC,completed_at DESC,id DESC LIMIT 1`,[batch.project_id]);
 if (!prior) return;
 // JSONB equality ignores object key order, unlike JSON.stringify.
 const match=await one('SELECT settings=$2::jsonb AND NOT legacy AS same FROM measurement_batches WHERE id=$1',[prior.id,JSON.stringify(settings)]);
 if (!match?.same) throw new Error('Settings changed or historical settings are unknown. Run all active questions to start a clean measurement.');
 const current=await one('SELECT collection_plan FROM measurement_batches WHERE id=$1',[batch.id]);
 if (Array.isArray(prior.collection_plan)) {
   const merged=new Map();
   for(const item of [...prior.collection_plan,...(current?.collection_plan || [])]) merged.set(`${item.prompt_id}:${item.engine}:${item.run_index}`,item);
   await query('UPDATE measurement_batches SET collection_plan=$2::jsonb WHERE id=$1',[batch.id,JSON.stringify([...merged.values()])]);
 } else {
   // Do not pretend a partial new plan describes an older full snapshot.
   await query('UPDATE measurement_batches SET collection_plan=NULL WHERE id=$1',[batch.id]);
 }
 await query(`INSERT INTO measurement_members(measurement_id,run_id)
 SELECT $1,run_id FROM measurement_answers WHERE measurement_id=$2`,[batch.id,prior.id]);
}
