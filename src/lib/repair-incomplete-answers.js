import {introductionOnly} from './answer-eligibility.js';
export async function repairIncompleteAnswers(db,projectId,runIds,{apply=false}={}) {
 await db.query('BEGIN');
 try {
  const {rows:projects}=await db.query('SELECT id,name FROM projects WHERE id=$1 FOR UPDATE',[projectId]);
  if(!projects.length)throw Error('Project not found');
  const {rows:runs}=await db.query('SELECT id,response_text,ok FROM runs WHERE project_id=$1 AND id=ANY($2::int[]) FOR UPDATE',[projectId,runIds]);
  if(runs.length!==new Set(runIds).size || runs.some(r=>!r.ok||!introductionOnly(r.response_text)))throw Error('Every requested answer must belong to this project and still match the introduction-only rule.');
  const {rows:mentions}=await db.query('SELECT m.* FROM mentions m WHERE run_id=ANY($1::int[]) ORDER BY run_id,entity_id FOR UPDATE',[runIds]);
  const {rows:batches}=await db.query(`SELECT b.id,b.settings FROM measurement_batches b WHERE b.project_id=$1 AND EXISTS
   (SELECT 1 FROM measurement_answers a WHERE a.measurement_id=b.id AND a.run_id=ANY($2::int[])) FOR UPDATE`,[projectId,runIds]);
  if(apply&&mentions.length){
   await db.query(`CREATE TABLE IF NOT EXISTS measurement_repairs(id SERIAL PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,method TEXT NOT NULL,before_rows JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
   await db.query('INSERT INTO measurement_repairs(project_id,method,before_rows) VALUES($1,$2,$3::jsonb)',[projectId,'intro-only-targeted-v1',JSON.stringify({mentions,batches})]);
   await db.query('DELETE FROM mentions WHERE run_id=ANY($1::int[])',[runIds]);
   // Distinct repaired-batch markers prevent automatic before/after claims.
   for(const b of batches) await db.query(`UPDATE measurement_batches SET settings=settings||$2::jsonb WHERE id=$1`,[b.id,JSON.stringify({answerEligibilityRepair:`intro-only-targeted-v1:batch-${b.id}`})]);
   await db.query('INSERT INTO method_notes(project_id,note,detail) VALUES($1,$2,$3)',[projectId,'Introduction-only answers excluded from scoring',`${runIds.join(', ')}: derived verdicts withheld under a short-list-introduction review rule. Original answers, citations and costs retained. Prior verdicts and batch settings archived in measurement_repairs. This is a measurement correction, not a visibility trend. Fixed report snapshots remain unchanged. No engine calls.`]);
  }
  await db.query(apply?'COMMIT':'ROLLBACK');
  return {project:projects[0].name,runIds,verdicts:mentions.length,affectedMeasurements:batches.map(b=>b.id),applied:apply};
 }catch(e){await db.query('ROLLBACK');throw e;}
}
