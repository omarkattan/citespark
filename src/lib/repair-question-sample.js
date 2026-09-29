/** Create a corrected sample without changing its source snapshot or raw evidence.
 * Only removes ancestors of revisions that existed when the source run began.
 * Current active flags must never rewrite historical membership.
 */
export async function repairQuestionSample(db, projectId, measurementId, {apply=false}={}) {
 await db.query('BEGIN');
 try {
  const {rows:[source]}=await db.query(`SELECT * FROM measurement_batches WHERE id=$1 AND project_id=$2 FOR UPDATE`,[measurementId,projectId]);
  if(!source || source.status!=='completed' || source.legacy) throw Error('Choose a completed, non-legacy measurement for this project.');
  if(!Array.isArray(source.collection_plan)) throw Error('This measurement has no recorded collection plan. Review its scope manually.');
  const {rows:obsolete}=await db.query(`WITH RECURSIVE replaced(id) AS (
    SELECT revises_prompt_id FROM prompts WHERE project_id=$1 AND revises_prompt_id IS NOT NULL AND created_at <= $2
    UNION
    SELECT p.revises_prompt_id FROM prompts p JOIN replaced x ON p.id=x.id
      WHERE p.project_id=$1 AND p.revises_prompt_id IS NOT NULL
  ) SELECT DISTINCT id FROM replaced`,[projectId,source.started_at]);
  const removed=new Set(obsolete.map(x=>Number(x.id)));
  const {rows:answers}=await db.query(`SELECT r.id,r.prompt_id,r.measurement_id FROM measurement_answers a JOIN runs r ON r.id=a.run_id
    WHERE a.measurement_id=$1 AND r.project_id=$2`,[source.id,projectId]);
  // Never hide answers actually collected by this run. This correction is for inherited scope only.
  if(answers.some(r=>removed.has(Number(r.prompt_id)) && Number(r.measurement_id)===Number(source.id))) throw Error('A replaced question was collected directly in this run. Review manually before changing scope.');
  const retained=answers.filter(r=>!removed.has(Number(r.prompt_id)));
  const plan=source.collection_plan.filter(p=>!removed.has(Number(p.prompt_id)));
  const result={sourceId:source.id,removedAnswers:answers.length-retained.length,removedChecks:source.collection_plan.length-plan.length,questions:new Set(plan.map(p=>p.prompt_id)).size,expected:plan.length,applied:false};
  if(!result.removedAnswers && !result.removedChecks) {await db.query('ROLLBACK');return result;}
  if(!retained.length || !plan.length) throw Error('Correction would leave an empty sample. Review manually.');
  if(!apply){await db.query('ROLLBACK');return result;}
  // Use the same lock as collection. Do not publish over a newer measurement.
  const {rows:[lock]}=await db.query('SELECT pg_try_advisory_xact_lock(290029,$1) AS locked',[projectId]);
  if(!lock.locked) throw Error('A measurement is running. Try again after it finishes.');
  const {rows:[latest]}=await db.query(`SELECT id FROM measurement_batches WHERE project_id=$1 AND status='completed'
    ORDER BY cycle_date DESC,completed_at DESC,id DESC LIMIT 1`,[projectId]);
  if(Number(latest?.id)!==Number(source.id)) throw Error('A newer completed snapshot exists. Nothing changed. Review it before repairing.');
  const {rows:[corrected]}=await db.query(`INSERT INTO measurement_batches(project_id,cycle_date,status,settings,collection_plan,started_at,completed_at)
    VALUES($1,$2,'completed',$3::jsonb,$4::jsonb,$5,now()) RETURNING id`,[projectId,source.cycle_date,JSON.stringify(source.settings),JSON.stringify(plan),source.started_at]);
  await db.query(`INSERT INTO measurement_members(measurement_id,run_id) SELECT $1,unnest($2::integer[])`,[corrected.id,retained.map(r=>r.id)]);
  await db.query(`INSERT INTO method_notes(project_id,note,detail) VALUES($1,$2,$3)`,[projectId,'Question sample corrected',`Measurement ${corrected.id} corrects inherited question scope from measurement ${source.id}. ${result.removedAnswers} inherited answers and ${result.removedChecks} planned checks for superseded wording were excluded. Original snapshot, answers and costs retained. No new engine calls. The original collection start time is retained.`]);
  await db.query('COMMIT');return {...result,applied:true,correctedId:corrected.id};
 } catch(error) {await db.query('ROLLBACK');throw error;}
}
