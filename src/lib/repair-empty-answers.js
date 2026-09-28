import { possibleTruncation } from './answer-quality.js';
/** Remove derived verdicts where no answer text exists. Raw runs, cost and
 * citations remain untouched. A transaction records the exact removed rows in
 * an audit table so this correction can be reversed independently of code. */
export async function repairEmptyAnswers(db, projectId, {apply=false,maxTokens=2000}={}) {
 await db.query('BEGIN');
 try {
  const {rows:projects}=await db.query('SELECT id,name FROM projects WHERE id=$1 FOR UPDATE',[projectId]);
  if(!projects.length) throw new Error('Project not found');
  const {rows}=await db.query(`SELECT m.*,r.engine,r.cycle_date FROM mentions m JOIN runs r ON r.id=m.run_id
    WHERE r.project_id=$1 AND r.ok AND (r.response_text IS NULL OR length(trim(r.response_text))=0)
    ORDER BY m.run_id,m.entity_id FOR UPDATE OF m`,[projectId]);
  const runs=new Set(rows.map(r=>r.run_id));
  const {rows: retained}=await db.query(`SELECT id,engine,response_text, max_output_tokens,quality_review FROM runs
    WHERE project_id=$1 AND ok AND length(trim(response_text))>0 AND max_output_tokens IS NULL AND quality_review IS NULL AND engine NOT IN ('ai_mode','ai_overview') FOR UPDATE`,[projectId]);
  if(apply) for(const run of retained) await db.query('UPDATE runs SET quality_review=$2::jsonb WHERE id=$1',[run.id,JSON.stringify({possibleTruncation:possibleTruncation(run,maxTokens),limitUsed:maxTokens,limitSource:'runtime-at-review, historical collection limit unknown',method:'text-heuristic-v2',reviewedAt:new Date().toISOString()})]);
  if(apply && (rows.length || retained.length)){
   await db.query(`CREATE TABLE IF NOT EXISTS measurement_repairs (
    id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, method TEXT NOT NULL,
    before_rows JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
   await db.query('INSERT INTO measurement_repairs(project_id,method,before_rows) VALUES($1,$2,$3::jsonb)',[projectId,'empty-answer-v1',JSON.stringify(rows)]);
   await db.query(`DELETE FROM mentions WHERE run_id=ANY($1::int[])`,[[...runs]]);
   await db.query('INSERT INTO method_notes(project_id,note,detail) VALUES($1,$2,$3)',[projectId,
    'Empty answers excluded from brand measurement',
    `${runs.size} successful collection records had no retained answer text. ${rows.length} derived brand verdicts were removed from naming denominators, with original rows archived in measurement_repairs. The cause of legacy empty text is unknown and was not inferred. Original runs, citations and costs remain unchanged. ${retained.length} retained answers received a dated heuristic review using the runtime limit of ${maxTokens}, not a claimed historical collection limit. No engines were called. This is a method correction, not a visibility change.`]);
  }
  await db.query(apply?'COMMIT':'ROLLBACK');
  return {name:projects[0].name,runs:runs.size,rows:rows.length,reviewed:retained.length,engines:[...new Set(rows.map(r=>r.engine))]};
 }catch(e){await db.query('ROLLBACK');throw e;}
}
