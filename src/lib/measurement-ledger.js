import { introductionOnly } from './answer-eligibility.js';
export const slotKey = r => `${Number(r.prompt_id)}:${r.engine}:${Number(r.run_index)}`;
export function outcomeFor(answer) {
 if (!answer.ok) return 'failed';
 if (answer.noOverview || answer.absent && !String(answer.text||'').trim()) return 'no_answer';
 if (!String(answer.text||'').trim() || introductionOnly(answer.text)) return 'incomplete';
 return 'collected';
}
export async function seedChecks(db,batch,plan,retained=[]) {
 const selected=new Map(retained.map(r=>[slotKey(r),r]));
 for(const p of plan) {
  const r=selected.get(slotKey(p));
  await db.query(`INSERT INTO measurement_checks(measurement_id,prompt_id,engine,run_index,question_text,state,selected_run_id)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[batch.id,p.prompt_id,p.engine,p.run_index,p.text,
   r?outcomeFor({ok:r.ok,text:r.response_text,noOverview:r.no_overview}):'pending',r?.id||null]);
 }
}
export async function checkState(db,batchId,job,state,error=null,runId=null) {
 await db.query(`UPDATE measurement_checks SET state=$5,error=$6,selected_run_id=COALESCE($7,selected_run_id),updated_at=now()
  WHERE measurement_id=$1 AND prompt_id=$2 AND engine=$3 AND run_index=$4`,[batchId,job.prompt.id,job.engine,job.runIndex,state,error,runId]);
 await db.query('UPDATE measurement_batches SET heartbeat_at=now() WHERE id=$1',[batchId]);
}
export function attemptRecorder(db,batchId,job) {
 return async event => {
  try {
   if(event.phase==='dispatch') await db.query(`INSERT INTO provider_attempts(id,measurement_id,prompt_id,engine,run_index,request)
    VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,[event.id,batchId,job.prompt.id,job.engine,job.runIndex,JSON.stringify(event.request)]);
   else await db.query(`UPDATE provider_attempts SET completed_at=now(),response=$2::jsonb,provider_request_id=$3,http_status=$4,error=$5,cost_usd=$6 WHERE id=$1`,
    [event.id,JSON.stringify(event.response??null),event.response?.tasks?.[0]?.id||null,event.httpStatus||null,event.error||null,event.costUsd||0]);
  } catch(err) {err.persistence=true;throw err;}
 };
}
export async function terminalizeChecks(db,batchId,reason='Worker interrupted before this check reached a saved outcome.') {
 await db.query(`UPDATE measurement_checks SET state='interrupted',error=$2,updated_at=now()
  WHERE measurement_id=$1 AND state IN ('pending','running')`,[batchId,reason]);
}
export async function ledgerSummary(db,batchId) {
 const {rows}=await db.query(`SELECT state,COUNT(*)::int AS n FROM measurement_checks WHERE measurement_id=$1 GROUP BY state`,[batchId]);
 const counts=Object.fromEntries(rows.map(r=>[r.state,Number(r.n)]));
 const planned=Object.values(counts).reduce((a,b)=>a+b,0),pending=(counts.pending||0)+(counts.running||0);
 const unresolved=['failed','interrupted','cancelled','unsupported','incomplete'].reduce((n,k)=>n+(counts[k]||0),0);
 return {planned,usable:counts.collected||0,noAnswer:counts.no_answer||0,pending,unresolved,counts,status:pending?'running':unresolved?'partial':'completed'};
}
