import {verifiedEnough} from './billing.js';
import {many,one,query} from '../db/index.js';
import {readActionPages,readOwnPage,ownPageUrl} from './action-pages.js';
import {onceContentJob,recordedCompletion,workflowError,draftingCost} from './content-cost.js';
import {approvedFacts,factsHash,FACT_SCHEMA,FAQ_SCHEMA,extractedFacts,reviewedFacts,validateGeneratedFaq,validateFaqEdit,validateImplementation,FACT_SYSTEM,FAQ_SYSTEM} from './faq-content.js';
import {matchedRecheckScope} from './faq-recheck.js';
import {reaskPrompt} from '../jobs/runCycle.js';

async function requireDraftingAccess(project){
 const org=await one('SELECT internal FROM orgs WHERE id=$1',[project.org_id]);
 if(!org?.internal&&!(await verifiedEnough(project.org_id)))throw workflowError('Confirm your email before using AI drafting. Your facts can still be saved manually.',403);
}
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const reviewFor=id=>one('SELECT * FROM brand_fact_reviews WHERE project_id=$1',[id]);
const draftFor=(projectId,recId)=>one('SELECT * FROM faq_workflows WHERE project_id=$1 AND recommendation_id=$2',[projectId,recId]);
async function costsFor(id){
 const records=await many("SELECT kind,status,model,usage,estimated_cost_usd,started_at FROM content_jobs WHERE project_id=$1 AND kind IN ('brand_facts','faq_draft','immediate_actions') ORDER BY id DESC",[id]);
 const calls=records.map(r=>({...r,estimated_cost_usd:r.estimated_cost_usd==null?draftingCost(r.model,r.usage):Number(r.estimated_cost_usd)}));
 const row={estimated_usd:calls.reduce((n,r)=>n+(r.estimated_cost_usd||0),0),recorded_calls:calls.filter(r=>r.usage).length,unknown_cost_calls:calls.filter(r=>r.estimated_cost_usd==null).length};
 const answer=await one('SELECT COALESCE(SUM(cost_usd),0)::float AS usd FROM runs WHERE project_id=$1',[id]);
 return {...row,calls:calls.slice(0,20),answer_usd:answer.usd,note:'Drafting: estimated API cost from recorded tokens since this feature was released, not an invoice. Earlier drafting and other AI analysis are not included. Unknown costs are not counted as zero.'};
}
async function saveHistory(row,userId){await query(`INSERT INTO faq_workflow_history(workflow_id,revision,snapshot,saved_by)
 VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(workflow_id,revision) DO NOTHING`,[row.id,row.revision,JSON.stringify(row),userId]);}
async function recommendation(projectId,id){
 if(!Number.isSafeInteger(Number(id))||Number(id)<1)throw workflowError('Choose an action first.');
 const rec=await one('SELECT * FROM recommendations WHERE project_id=$1 AND id=$2',[projectId,Number(id)]);
 if(!rec?.evidence?.action_plan)throw workflowError('This action has no measured question to draft from.',404);
 const prompt=await one('SELECT * FROM prompts WHERE project_id=$1 AND id=$2',[projectId,rec.evidence.prompt_id]);
 if(!prompt)throw workflowError('The measured question is no longer available.',404);
 return {rec,prompt,plan:rec.evidence.action_plan};
}
export function mountContentWorkflow(app,{requireAuth,assertProject}) {
 const route=fn=>[requireAuth,async(req,res)=>{try{const project=await assertProject(req,res);if(!project)return;res.json(await fn(req,project));}
 catch(error){console.warn('Content workflow:',error.message);res.status(error.code==='23505'?409:error.status||500).json({error:error.code==='23505'?'Another request for this step is running. Reopen it shortly.':error.status?error.message:'This step could not be saved. Your existing work is safe. Try again.'});}}];
 app.get('/api/projects/:id/content-workflow',...route(async(req,p)=>{
   const {rec,prompt,plan}=await recommendation(p.id,req.query.recommendation);
   const [review,draft,costs]=await Promise.all([reviewFor(p.id),draftFor(p.id,rec.id),costsFor(p.id)]);
   return {project:{id:p.id,domain:p.domain,name:p.brand_name||p.name},action:{id:rec.id,prompt_id:prompt.id,question:plan.question,target_url:rec.review_decision?.page||plan.page||'',evidence:plan.evidence},review:review||{revision:0,facts:[]},draft:draft?{...draft,stale:draft.facts_hash!==factsHash(review?.facts||[])}:null,costs};
 }));
 app.post('/api/projects/:id/brand-facts/extract',...route(async(req,p)=>{
   const {rec,plan}=await recommendation(p.id,req.body?.recommendation_id);
   const initial=await reviewFor(p.id);
   await requireDraftingAccess(p);
   return onceContentJob(p.id,'brand_facts',req.body?.request_key,async jobId=>{
     let pages=await readActionPages(p.domain,[plan.question]);
     const target=ownPageUrl(rec.review_decision?.page||plan.page,p.domain);
     if(target&&!pages.some(x=>x.url===target)){const page=await readOwnPage(target,p.domain);if(page)pages=[...pages.slice(0,3),{...page,id:'page-target'}];}
     if(!pages.length)throw workflowError('Your site could not be read. Add the facts and their page links manually below.',422);
     const raw=await recordedCompletion(p.id,'brand_facts',JSON.stringify({question:plan.question,pages:pages.map(({id,url,text})=>({id,url,text:text.slice(0,7000)}))}),{system:FACT_SYSTEM,maxTokens:1600,timeoutMs:60000,outputSchema:FACT_SCHEMA},jobId);
     const fresh=extractedFacts(parse(raw),pages);if(!fresh.length)throw workflowError('No reliable fact excerpts were returned. Add the facts manually, or try again.',422);
     const prior=initial?.facts||[],facts=[...prior,...fresh.filter(f=>!prior.some(x=>x.id===f.id))].slice(0,15);
     const saved=await one(`INSERT INTO brand_fact_reviews(project_id,facts) VALUES($1,$2::jsonb)
       ON CONFLICT(project_id) DO UPDATE SET facts=EXCLUDED.facts,revision=brand_fact_reviews.revision+1,updated_at=now()
       WHERE brand_fact_reviews.revision=$3 RETURNING *`,[p.id,JSON.stringify(facts),initial?.revision||0]);
     if(!saved)throw workflowError('Facts changed while the site was being read. Reopen the review; your saved edits were kept.',409);
     return saved;
   });
 }));
 app.put('/api/projects/:id/brand-facts',...route(async(req,p)=>{
   const current=await reviewFor(p.id);if(Number(req.body?.revision)!==Number(current?.revision||0))throw workflowError('Facts changed in another tab. Reopen this step before saving.',409);
   const facts=reviewedFacts(req.body?.facts,current?.facts||[],p.domain);
   const saved=await one(`INSERT INTO brand_fact_reviews(project_id,facts,reviewed_by) VALUES($1,$2::jsonb,$3)
     ON CONFLICT(project_id) DO UPDATE SET facts=EXCLUDED.facts,reviewed_by=$3,revision=brand_fact_reviews.revision+1,updated_at=now()
     WHERE brand_fact_reviews.revision=$4 RETURNING *`,[p.id,JSON.stringify(facts),req.session.userId,Number(req.body.revision)]);
   if(!saved)throw workflowError('Facts changed in another tab. Reopen this step.',409);return saved;
 }));
 app.post('/api/projects/:id/faq/:recId/draft',...route(async(req,p)=>{
   const {rec,prompt,plan}=await recommendation(p.id,req.params.recId),existing=await draftFor(p.id,rec.id);
   if(existing&&!req.body?.regenerate)return existing;
   if(existing?.status==='implemented')throw workflowError('This draft records a published change. Keep it as evidence; create a new action for another change.',409);
   if(existing&&Number(req.body?.revision)!==existing.revision)throw workflowError('The draft changed in another tab. Reopen it before regenerating.',409);
   const review=await reviewFor(p.id),facts=approvedFacts(review?.facts||[]),hash=factsHash(review?.facts||[]);
   if(!facts.length)throw workflowError('Approve at least one fact before drafting.');
   await requireDraftingAccess(p);
   return onceContentJob(p.id,'faq_draft',req.body?.request_key,async jobId=>{
     const raw=await recordedCompletion(p.id,'faq_draft',JSON.stringify({question:plan.question,brand:p.brand_name,market:p.market,approved_facts:facts}),{system:FAQ_SYSTEM,maxTokens:2200,timeoutMs:60000,outputSchema:FAQ_SCHEMA},jobId);
     const content=validateGeneratedFaq(parse(raw),facts);
     const current=await reviewFor(p.id);if(factsHash(current?.facts||[])!==hash)throw workflowError('Facts changed during drafting. Reopen this step and use the updated facts.',409);
     if(existing)await saveHistory(existing,req.session.userId);
     const saved=await one(`INSERT INTO faq_workflows(project_id,recommendation_id,prompt_id,question,target_url,content,facts_snapshot,facts_hash,baseline_measurement_id)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)
       ON CONFLICT(recommendation_id) DO UPDATE SET content=EXCLUDED.content,facts_snapshot=EXCLUDED.facts_snapshot,facts_hash=EXCLUDED.facts_hash,
       revision=faq_workflows.revision+1,status='draft',reviewed_by=NULL,reviewed_at=NULL,updated_at=now()
       WHERE faq_workflows.revision=$10 AND faq_workflows.status<>'implemented' RETURNING *`,
       [p.id,rec.id,prompt.id,plan.question,ownPageUrl(rec.review_decision?.page||plan.page,p.domain)||'',JSON.stringify(content),JSON.stringify(facts),hash,plan.measurement_id||null,existing?.revision||0]);
     if(!saved)throw workflowError('A draft was saved while this request ran. Reopen it; existing edits were kept.',409);
     return saved;
   });
 }));
 app.put('/api/projects/:id/faq/:recId',...route(async(req,p)=>{
   const current=await draftFor(p.id,Number(req.params.recId));if(!current)throw workflowError('Draft not found.',404);
   if(current.status==='implemented')throw workflowError('Published changes are kept as evidence. Create a new action for another change.',409);
   const review=await reviewFor(p.id),edit=validateFaqEdit(req.body,current,p.domain,review?.facts||[]);await saveHistory(current,req.session.userId);
   const saved=await one(`UPDATE faq_workflows SET content=$4::jsonb,target_url=$5,status=$6,revision=revision+1,
      reviewed_by=CASE WHEN $6='ready' THEN $7::integer ELSE NULL END,reviewed_at=CASE WHEN $6='ready' THEN now() ELSE NULL END,updated_at=now()
      WHERE id=$1 AND project_id=$2 AND revision=$3 RETURNING *`,[current.id,p.id,Number(req.body.revision),JSON.stringify({...current.content,answer:edit.answer,missing_facts:edit.missing_facts}),edit.target_url,edit.status,req.session.userId]);
   if(!saved)throw workflowError('The draft changed in another tab. Reopen it before saving.',409);return saved;
 }));
 app.post('/api/projects/:id/faq/:recId/implemented',...route(async(req,p)=>{
   const current=await draftFor(p.id,Number(req.params.recId));if(!current)throw workflowError('Draft not found.',404);
   if(current.status==='implemented')return current;
   const review=await reviewFor(p.id);if(current.status!=='ready'||current.facts_hash!==factsHash(review?.facts||[]))throw workflowError('Review and approve the current draft before recording publication.');
   const value=validateImplementation(req.body,p.domain);await saveHistory(current,req.session.userId);
   const saved=await one(`UPDATE faq_workflows SET status='implemented',implemented_url=$4,implemented_on=$5,revision=revision+1,updated_at=now()
      WHERE id=$1 AND project_id=$2 AND revision=$3 RETURNING *`,[current.id,p.id,Number(req.body.revision),value.url,value.date]);
   if(!saved)throw workflowError('The draft changed. Reopen it before recording publication.',409);return saved;
 }));
 app.get('/api/projects/:id/faq/:recId/recheck',...route(async(req,p)=>{
   const draft=await draftFor(p.id,Number(req.params.recId));if(!draft||draft.status!=='implemented')throw workflowError('Record the published URL and date first.');
   return matchedRecheckScope(p,draft);
 }));
 app.post('/api/projects/:id/faq/:recId/recheck',...route(async(req,p)=>{
   const draft=await draftFor(p.id,Number(req.params.recId));if(!draft||draft.status!=='implemented')throw workflowError('Record the published URL and date first.');
   if(draft.recheck&&!req.body?.retry)return draft.recheck;
   if(draft.recheck&&Number(req.body?.revision)!==draft.revision)throw workflowError('A newer repeat is saved. Reopen this step before repeating again.',409);
   const scope=await matchedRecheckScope(p,draft);if(!scope.eligible)throw workflowError(scope.reason,409);
   return onceContentJob(p.id,'faq_recheck',req.body?.request_key,async()=>{
     const latest=await draftFor(p.id,draft.recommendation_id);
     if(latest.recheck&&!req.body?.retry)return latest.recheck;
     if(latest.revision!==draft.revision)throw workflowError('This action changed. Reopen it before repeating again.',409);
     await saveHistory(latest,req.session.userId);
     let result;try{result=await reaskPrompt(draft.prompt_id,{matched:{baselineId:draft.baseline_measurement_id,question:draft.question,counts:scope.counts}});}catch(error){if(/already running|baseline|settings|question|checks|budget/i.test(error.message))throw workflowError(error.message,409);throw error;}
     const comparison=await matchedRecheckScope(p,draft,result.measurementId);
     const saved={...result,comparison,recorded_at:new Date().toISOString(),note:'New answers only, compared with the saved baseline. This observation does not establish that the page change caused a difference.'};
     await query('UPDATE faq_workflows SET recheck=$3::jsonb,revision=revision+1,updated_at=now() WHERE id=$1 AND project_id=$2',[draft.id,p.id,JSON.stringify(saved)]);return saved;
   });
 }));
}
