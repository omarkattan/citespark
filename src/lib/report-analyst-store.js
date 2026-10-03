import {pool,many,one,query} from '../db/index.js';
import {analystPacket,packetHash,analystModel,requestAnalysis,validateAnalysis,analystCost} from './report-analyst.js';
export async function reportPacket(report){
 const mid=report.executive.measurement?.id;
 const answers=mid?await many(`SELECT id,engine,question,response_text FROM (
 SELECT r.id,r.engine,p.text AS question,r.response_text,
 row_number() OVER(PARTITION BY r.prompt_id ORDER BY r.engine,r.id) AS position
 FROM measurement_answers a JOIN runs r ON r.id=a.run_id JOIN prompts p ON p.id=r.prompt_id AND p.project_id=r.project_id
 WHERE a.measurement_id=$1 AND r.project_id=$2 AND r.ok AND length(trim(r.response_text))>0
 ) s ORDER BY position,id LIMIT 24`,[mid,report.project.id]):[];
 return analystPacket(report,answers);
}
export async function currentAnalysis(report){
 // Avoid additional evidence queries for projects without any approved draft.
 const rows=await many('SELECT * FROM report_analyst_drafts WHERE project_id=$1 AND approved_at IS NOT NULL ORDER BY approved_at DESC LIMIT 10',[report.project.id]);
 if(!rows.length)return null;
 const packet=await reportPacket(report),hash=packetHash(packet);
 const row=rows.find(r=>r.evidence_hash===hash);
 return row?{...row,packet,analysis:validateAnalysis(row.analysis,packet)}:{stale:true};
}
export async function generateAnalysis(report,userId,{regenerate=false}={}){
 if(!process.env.ANTHROPIC_API_KEY)throw new Error('Report analyst is not configured. Add the Anthropic API key in Render.');
 if(!report.executive.totals.measured)throw new Error('Collect a measured baseline before requesting analysis.');
 if(report.executive.localeWarnings?.length)throw new Error('Correct the measurement settings before requesting management analysis.');
 const packet=await reportPacket(report),hash=packetHash(packet),model=analystModel();
 const db=await pool.connect();let row;
 try{
  await db.query('BEGIN');
  // Short reservation lock across analyst jobs. No lock is held during the provider request.
  await db.query('SELECT pg_advisory_xact_lock(853001)');
  const existing=await db.query("SELECT * FROM report_analyst_drafts WHERE project_id=$1 AND evidence_hash=$2 AND requested_model=$3 AND status='draft' ORDER BY id DESC LIMIT 1",[report.project.id,hash,model]);
  if(existing.rows.length && !regenerate){await db.query('COMMIT');return existing.rows[0];}
  const pending=await db.query("SELECT 1 FROM report_analyst_drafts WHERE project_id=$1 AND status='generating' AND created_at>now()-interval '3 minutes'",[report.project.id]);
  if(pending.rows.length)throw new Error('An analysis is already running. Wait a moment, then refresh this page.');
  const count=await db.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE project_id=$1)::int AS project FROM report_analyst_drafts WHERE created_at>now()-interval '24 hours'",[report.project.id]);
  if(count.rows[0].total>=50||count.rows[0].project>=5)throw new Error('Daily analysis limit reached. Up to five drafts per project and 50 across Cited in 24 hours.');
  const inserted=await db.query("INSERT INTO report_analyst_drafts(project_id,evidence_hash,packet,status,requested_model,created_by) VALUES($1,$2,$3,'generating',$4,$5) RETURNING *",[report.project.id,hash,JSON.stringify(packet),model,userId]);
  row=inserted.rows[0];await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 try{
  const result=await requestAnalysis(packet,{model});
  await query('UPDATE report_analyst_drafts SET returned_model=$2,usage=$3,provider_id=$4,stop_reason=$5,raw_response=$6,cost_estimate=$7 WHERE id=$1',[row.id,result.model,result.usage,result.provider_id,result.stop_reason,result.raw,analystCost(result.model,result.usage)]);
  if(result.stop_reason!=='end_turn')throw new Error(result.stop_reason==='max_tokens'?'The AI draft reached its output limit before finishing. The incomplete response and usage were saved, but nothing was published. Review the latest attempt before making another paid request.':`The AI response stopped before completion (${result.stop_reason||'unknown reason'}). Usage was recorded, but the draft was withheld.`);
  let value;try{value=JSON.parse(result.raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new Error('AI response was not valid JSON. Usage was recorded, but the draft was withheld.');}
  const analysis=validateAnalysis(value,packet);
  return await one("UPDATE report_analyst_drafts SET analysis=$2,status='draft' WHERE id=$1 RETURNING *",[row.id,analysis]);
 }catch(error){await query("UPDATE report_analyst_drafts SET status='failed',error=$2 WHERE id=$1",[row.id,error.name==='TimeoutError'?'Analysis timed out. Provider usage may be unknown.':error.message]);throw error;}
}
export async function approveAnalysis(report,id,userId,revision=0){
 const row=await one("SELECT * FROM report_analyst_drafts WHERE id=$1 AND project_id=$2 AND status='draft'",[id,report.project.id]);
 if(!row)throw new Error('Draft not found for this project.');
 const packet=await reportPacket(report);
 if(row.evidence_hash!==packetHash(packet))throw new Error('The evidence has changed. Generate and review a current draft before including it.');
 if(!Number.isInteger(revision)||revision!==(row.edit_revision||0))throw Error('The draft has changed. Refresh and review the latest wording before inclusion.');
 validateAnalysis(row.analysis,packet);
 const updated=await query('UPDATE report_analyst_drafts SET approved_at=now(),approved_by=$2 WHERE id=$1 AND project_id=$3 AND edit_revision=$4',[row.id,userId,report.project.id,revision]);
 if(updated?.rowCount===0)throw Error('The draft changed while you were reviewing it. Refresh before inclusion.');
}

// Revalidate the retained response. Never make a provider call or approve the result here.
export async function recoverAnalysis(report,id){
 const row=await one("SELECT * FROM report_analyst_drafts WHERE id=$1 AND project_id=$2 AND status='failed'",[id,report.project.id]);
 if(!row)throw new Error('A failed saved response was not found for this project.');
 if(row.stop_reason!=='end_turn'||!row.raw_response)throw new Error('This response is incomplete and cannot be recovered.');
 const packet=await reportPacket(report);
 if(row.evidence_hash!==packetHash(packet))throw new Error('The evidence has changed. The saved response cannot be reused for the current report.');
 let value;try{value=JSON.parse(row.raw_response.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new Error('The saved response is not valid JSON.');}
 // References must pass against both the original evidence and the current identical packet.
 validateAnalysis(value,row.packet);
 const analysis=validateAnalysis(value,packet);
 return await one("UPDATE report_analyst_drafts SET analysis=$3,status='draft',error=NULL WHERE id=$1 AND project_id=$2 AND status='failed' RETURNING *",[id,report.project.id,analysis]);
}

export async function editAnalysis(report,id,userId,revision,changes){
 if(!Number.isInteger(revision)||revision<0)throw Error('Refresh the draft before editing.');
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const {rows}=await db.query("SELECT * FROM report_analyst_drafts WHERE id=$1 AND project_id=$2 AND status='draft' FOR UPDATE",[id,report.project.id]);
  const row=rows[0];
  if(!row)throw Error('Draft not found for this project.');
  if(row.edit_revision!==revision)throw Error('Someone edited this draft. Copy your changes before refreshing.');
  // Editorial saves retain the original evidence and never make an older draft current.
  const packet=row.packet;
  if(!packet?.records)throw Error('The original evidence is unavailable. This draft cannot be edited safely.');
  if(!Array.isArray(changes?.findings)||changes.findings.length!==row.analysis.findings.length)throw Error('Keep the existing findings and their evidence references.');
  const fields=['title','observation','implication','action','done_when','follow_up'];
  const candidate={findings:row.analysis.findings.map((f,i)=>({...f,...Object.fromEntries(fields.map(k=>[k,changes.findings[i]?.[k]]))})),limitations:changes.limitations};
  const analysis=validateAnalysis(candidate,packet);
  const history=[{revision:row.edit_revision,analysis:row.analysis,edited_at:row.edited_at,edited_by:row.edited_by,approved_at:row.approved_at,approved_by:row.approved_by}];
  await db.query(`UPDATE report_analyst_drafts SET analysis=$3,edit_revision=edit_revision+1,
   edit_history=edit_history || $4::jsonb,edited_at=now(),edited_by=$5,approved_at=NULL,approved_by=NULL
   WHERE id=$1 AND project_id=$2`,[id,report.project.id,analysis,JSON.stringify(history),userId]);
  await db.query('UPDATE report_analyst_drafts SET approved_at=NULL,approved_by=NULL WHERE project_id=$1 AND evidence_hash=$2 AND approved_at IS NOT NULL',[report.project.id,row.evidence_hash]);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
