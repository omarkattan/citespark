import {randomUUID} from 'node:crypto';
import {one,query} from '../db/index.js';
import {complete} from './anthropic.js';

// Public standard API rates, USD per million tokens; not the customer's invoice.
// https://platform.claude.com/docs/en/about-claude/models/overview (29 Oct 2026)
export function draftingCost(model,usage) {
  if(!/^claude-sonnet-4-5(?:-|$)/.test(String(model)) || !usage)return null;
  const keys=['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'];
  if(keys.some(k=>usage[k]!=null&&(!Number.isFinite(Number(usage[k]))||Number(usage[k])<0)))return null;
  if(usage.input_tokens==null||usage.output_tokens==null)return null;
  const cache=usage.cache_creation || {}, hour=Number(cache.ephemeral_1h_input_tokens||0), total=Number(usage.cache_creation_input_tokens||0);
  if(hour>total)return null;
  // Nonstandard geography/service pricing is intentionally not guessed.
  if(usage.inference_geo && !['global','not_available'].includes(usage.inference_geo))return null;
  return (Number(usage.input_tokens)*3+Number(usage.output_tokens)*15+Number(usage.cache_read_input_tokens||0)*0.3+(total-hour)*3.75+hour*6)/1e6;
}
export const workflowError=(message,status=400)=>Object.assign(new Error(message),{status});
export async function onceContentJob(projectId,kind,key,work) {
  if(typeof key!=='string'||!key.length||key.length>160)throw workflowError('Reload this step and try again.');
  await query("UPDATE content_jobs SET status='failed',error='Interrupted request; inspect saved work before retrying',finished_at=now() WHERE project_id=$1 AND kind=$2 AND status='running' AND started_at < now()-interval '10 minutes'",[projectId,kind]);
  const job=await one(`INSERT INTO content_jobs(project_id,kind,request_key) VALUES($1,$2,$3)
    ON CONFLICT(project_id,kind,request_key) DO NOTHING RETURNING *`,[projectId,kind,key]);
  if(!job){const prior=await one('SELECT * FROM content_jobs WHERE project_id=$1 AND kind=$2 AND request_key=$3',[projectId,kind,key]);
    if(prior?.status==='completed')return prior.result;
    if(prior?.status==='running')throw workflowError('This request is already running. Reopen this step shortly to see the saved result. If it was interrupted, use Try again after ten minutes.',409);
    throw workflowError('The previous request did not finish. Click the same button again to start a new request.',422);
  }
  try{const result=await work(job.id);await query("UPDATE content_jobs SET status='completed',result=$2::jsonb,finished_at=now() WHERE id=$1",[job.id,JSON.stringify(result)]);return result;}
  catch(error){await query("UPDATE content_jobs SET status='failed',error=$2,finished_at=now() WHERE id=$1",[job.id,String(error.message).slice(0,500)]);throw error;}
}
export async function recordedCompletion(projectId,kind,prompt,options={},jobId=null) {
  const ownJob=!jobId;
  if(ownJob)jobId=(await one('INSERT INTO content_jobs(project_id,kind,request_key) VALUES($1,$2,$3) RETURNING id',[projectId,kind,randomUUID()])).id;
  let provider=null,reason=null,result=null;
  try{result=await complete(prompt,{...options,onResponse:value=>{provider=value;},onFailure:value=>{reason=value;options.onFailure?.(value);}});}
  finally{
    const cost=draftingCost(provider?.model,provider?.usage);
    await query(`UPDATE content_jobs SET model=$2,usage=$3::jsonb,estimated_cost_usd=$4,
      status=CASE WHEN $5 THEN $6 ELSE status END,finished_at=CASE WHEN $5 THEN now() ELSE finished_at END,
      error=$7 WHERE id=$1`,[jobId,provider?.model||null,JSON.stringify(provider?.usage||null),cost,ownJob,result?'completed':'failed',reason]);
    if(provider)options.onResponse?.({...provider,estimated_cost_usd:cost,cost_record_id:jobId});
  }
  return result;
}
