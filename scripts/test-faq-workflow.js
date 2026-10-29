import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as core from '../src/lib/faq-content.js';
import {draftingCost,workflowError} from '../src/lib/content-cost.js';
import {ownPageUrl} from '../src/lib/action-pages.js';
import {sampleSummary,comparableSamples} from '../src/lib/faq-recheck.js';
const {PGlite}=await import(process.env.PGLITE_MODULE);
const {JSDOM}=await import(process.env.JSDOM_MODULE);
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const stripped=s=>s.replace(/^import .*;\n/gm,'').replace(/export /g,'');
const db=new PGlite();
await db.exec(read('../src/db/schema.sql'));
const one=async(sql,p)=>(await db.query(sql,p)).rows[0]||null,many=async(sql,p)=>(await db.query(sql,p)).rows,query=(sql,p)=>db.query(sql,p);
await db.exec(`INSERT INTO orgs(id,name) VALUES(1,'UX test'),(2,'Other');
 INSERT INTO users(id,org_id,email,password_hash) VALUES(1,1,'test@example.org','test');
 INSERT INTO projects(id,org_id,name,domain,brand_name,engines) VALUES(39,1,'Example','example.org','Example',ARRAY['chatgpt']),(40,2,'Other','other.org','Other',ARRAY['chatgpt']);
 INSERT INTO entities(id,project_id,name,kind,domain) VALUES(1,39,'Example','owned','example.org');
 INSERT INTO prompts(id,project_id,text) VALUES(1,39,'What is included in the serum pack?');
 INSERT INTO measurement_batches(id,project_id,cycle_date,status,settings) VALUES(61,39,'2026-10-29','completed','{}');
 INSERT INTO runs(id,prompt_id,project_id,engine,cycle_date,response_text,measurement_id) VALUES(1,1,39,'chatgpt','2026-10-29','Compare the serum packs.',61);
 INSERT INTO mentions(run_id,entity_id,mentioned) VALUES(1,1,false);
 INSERT INTO recommendations(id,project_id,fingerprint,type,title,action,impact,effort,priority,evidence)
 VALUES(99,39,'content_gap:1','content_gap','Review serum pack','Check',10,1,10,'{"prompt_id":1,"action_plan":{"question":"What is included in the serum pack?","page":"https://example.org/products/serum","measurement_id":61,"evidence":{"answer_url":"/api/projects/39/measurements/61#run-1"}}}');`);
let modelCalls=0,rechecks=0,hold=null;
const completion=async(prompt,options)=>{
 modelCalls++;options.onResponse?.({model:'claude-sonnet-4-5-20250929',usage:{input_tokens:1000,output_tokens:100},stop_reason:'end_turn'});
 if(hold)await hold;
 const packet=JSON.parse(prompt);
 return JSON.stringify(packet.pages?{facts:[{page_id:'page-1',quote:'The Example serum comes in a 30 ml bottle.'}]}:{answer:'The Example serum comes in a 30 ml bottle. [MISSING: Confirm what else is included in the pack.]',fact_ids:[packet.approved_facts[0].id],missing_facts:['Confirm what else is included in the pack.']});
};
const costs=vm.runInNewContext(`(()=>{${stripped(read('../src/lib/content-cost.js'))};return {onceContentJob,recordedCompletion};})()`,{one,query,complete:completion,randomUUID:()=>crypto.randomUUID(),console});
const routes=new Map(),app={};for(const method of ['get','post','put'])app[method]=(path,...handlers)=>routes.set(method.toUpperCase()+' '+path,handlers);
const ctx={...core,...costs,many,one,query,ownPageUrl,workflowError,draftingCost,console,verifiedEnough:async()=>true,
 readActionPages:async()=>[{id:'page-1',url:'https://example.org/products/serum',text:'The Example serum comes in a 30 ml bottle.',read_at:'2026-10-29'}],readOwnPage:async()=>null,
 matchedRecheckScope:async(_p,_d,id)=>id?{comparable:true,before:[{engine:'chatgpt',usable:1,named:0,cited:0}],after:[{engine:'chatgpt',usable:1,named:1,cited:1}]}:{eligible:true,calls:1,estimated_usd:.03,counts:{chatgpt:1}},
 reaskPrompt:async()=>{rechecks++;return {measurementId:62,spend:.02,results:[]};}};
const mount=vm.runInNewContext(`(()=>{${stripped(read('../src/lib/content-workflow.js'))};return mountContentWorkflow;})()`,ctx);
mount(app,{requireAuth:(_req,_res,next)=>next(),assertProject:async(req,res)=>{const p=await one('SELECT * FROM projects WHERE id=$1 AND org_id=$2',[Number(req.params.id),req.session.orgId]);if(!p)res.status(404).json({error:'Not found'});return p;}});
async function request(method,path,body,project=39){
 const pathname=path.replace('/api/projects/39','/api/projects/'+project).split('?')[0];
 let matched;
 for(const [key,handlers] of routes){const [m,template]=key.split(' '),names=[...template.matchAll(/:([A-Za-z]+)/g)].map(m=>m[1]);const match=pathname.match(new RegExp('^'+template.replace(/:[A-Za-z]+/g,'([^/]+)')+'$'));if(m===method&&match){matched={handlers,params:Object.fromEntries(names.map((name,i)=>[name,match[i+1]]))};break;}}
 assert.ok(matched,'Route exists: '+method+' '+path);
 const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
 await matched.handlers.at(-1)({params:matched.params,session:{orgId:1,userId:1},query:Object.fromEntries(new URL(path,'https://cited.test').searchParams),body:body||{}},res);return res;
}
function dummyStyle(w){const style=w.document.createElement('style');style.textContent='input {width:100%;padding:9px 11px}'+read('../src/public/faq-workflow.css');w.document.head.appendChild(style);return style;}
const base='/api/projects/39';let draft;
test('facts preserve exact source passages, reject invented excerpts and require explicit approval',()=>{
 const pages=[{id:'p',url:'https://example.org',text:'The serum has a clear pack label.',read_at:'today'}];
 assert.equal(core.extractedFacts({facts:[{page_id:'p',quote:'This serum cures acne.'}]},pages).length,0);
 const facts=core.extractedFacts({facts:[{page_id:'p',quote:pages[0].text}]},pages);assert.equal(facts[0].approved,false);
 const reviewed=core.reviewedFacts([{...facts[0],statement:'Corrected owner fact',approved:true,source_quote:'forged'}],facts,'example.org');assert.equal(reviewed[0].source_quote,pages[0].text);assert.notEqual(core.factsHash(facts),core.factsHash(reviewed));
 assert.throws(()=>core.reviewedFacts([{statement:'Fact',source_url:'https://evil.org',approved:true}],[],'example.org'));
});
test('cost estimates count input/output and cache use, unknown models are unknown',()=>{
 assert.equal(draftingCost('claude-sonnet-4-5-20250929',{input_tokens:1000,output_tokens:100}),.0045);
 assert.equal(draftingCost('claude-sonnet-4-5-20250929',{input_tokens:1000,output_tokens:100,inference_geo:'not_available'}),.0045);
 assert.equal(draftingCost('unknown',{input_tokens:1000,output_tokens:100}),null);
 assert.equal(draftingCost('claude-sonnet-4-5',{input_tokens:-1,output_tokens:100}),null);
 assert.equal(draftingCost('claude-sonnet-4-5',{input_tokens:0,output_tokens:0,cache_read_input_tokens:1000}),.0003);
});
test('new workflow persists reviewed facts, exact-question draft, edits, costs and owner scoping',async()=>{
 const state=await request('GET',base+'/content-workflow?recommendation=99');assert.equal(state.body.draft,null);
 assert.equal((await request('GET',base+'/content-workflow?recommendation=99',null,40)).code,404);
 assert.equal((await request('POST',base+'/faq/99/draft',{request_key:'no-facts'})).code,400);
 const result=await request('POST',base+'/brand-facts/extract',{recommendation_id:99,request_key:'facts-1'});assert.equal(result.code,200);assert.equal(result.body.facts[0].approved,false);
 await request('POST',base+'/brand-facts/extract',{recommendation_id:99,request_key:'facts-1'});assert.equal(modelCalls,1,'same request reuses result');
 const facts=result.body.facts.map(f=>({...f,approved:true}));assert.equal((await request('PUT',base+'/brand-facts',{revision:result.body.revision,facts})).code,200);
 assert.equal((await request('PUT',base+'/brand-facts',{revision:0,facts})).code,409);
 const created=await request('POST',base+'/faq/99/draft',{request_key:'draft-1'});assert.equal(created.code,200);draft=created.body;
 assert.equal(draft.question,'What is included in the serum pack?');assert.equal(draft.status,'draft');
 await request('POST',base+'/faq/99/draft',{request_key:'different'});assert.equal(modelCalls,2,'reopening a draft does not call AI');
 assert.equal((await request('POST',base+'/faq/99/implemented',{revision:draft.revision,url:draft.target_url,date:'2026-10-29',confirmed:true})).code,400);
 assert.equal((await request('PUT',base+'/faq/99',{revision:draft.revision,answer:draft.content.answer,target_url:draft.target_url,status:'ready',approved:true,missing_resolved:true})).code,400,'placeholder cannot be approved');
 const saved=await request('PUT',base+'/faq/99',{revision:draft.revision,answer:'The Example serum comes in a 30 ml bottle. Check the product page for current packaging details.',target_url:draft.target_url,status:'ready',approved:true,missing_resolved:true});assert.equal(saved.code,200);draft=saved.body;
 assert.equal((await request('PUT',base+'/faq/99',{revision:1,answer:draft.content.answer,target_url:draft.target_url,status:'draft'})).code,409,'stale editor cannot overwrite');
 const costs=(await request('GET',base+'/content-workflow?recommendation=99')).body.costs;assert.equal(costs.recorded_calls,2);assert.equal(costs.estimated_usd,.009);
 assert.ok((await one('SELECT COUNT(*)::int AS n FROM faq_workflow_history')).n>=1);
});
test('new-user UI resumes saved draft and exposes report, publication and separate paid repeat',async()=>{
 const dom=new JSDOM('<button data-draft-faq="99" data-project-id="39">Draft this FAQ</button>',{url:'https://cited.test/app',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.confirm=()=>true;
 w.fetch=async(path,options={})=>{const res=await request(options.method||'GET',path,options.body?JSON.parse(options.body):undefined);return {ok:res.code<300,status:res.code,json:async()=>res.body};};
 const css=dummyStyle(w);w.eval(read('../src/public/faq-workflow.js'));await w.CitedFaq.open(39,99);
 const d=w.document;assert.equal(w.getComputedStyle(d.querySelector('[data-faq-approved]')).width,'18px','checkbox overrides full-width global inputs');assert.match(d.querySelector('#faqTitle').textContent,/Review your FAQ/);assert.equal(d.querySelector('[data-faq-answer]').value,draft.content.answer);assert.ok(d.querySelector('[data-faq-report]'));assert.equal(modelCalls,2);
 d.querySelector('[data-faq-step="publish"]').click();assert.ok(d.querySelector('[data-implemented-confirm]'));assert.match(d.querySelector('.faq-costs').textContent,/recorded drafting/);assert.equal(rechecks,0,'publication and paid recheck remain separate');
 dom.window.close();
});
test('implementation is explicit and recheck result is idempotent',async()=>{
 assert.throws(()=>core.validateImplementation({url:'https://example.org/p',date:'2026-02-30',confirmed:true},'example.org'));
 assert.throws(()=>core.validateImplementation({url:'https://example.org/p',date:'2026-10-29',confirmed:false},'example.org'));
 const pub=await request('POST',base+'/faq/99/implemented',{revision:draft.revision,url:draft.target_url,date:'2026-10-29',confirmed:true});assert.equal(pub.code,200);
 await request('POST',base+'/faq/99/recheck',{request_key:'repeat-1'});await request('POST',base+'/faq/99/recheck',{request_key:'repeat-2'});assert.equal(rechecks,1);
 assert.equal((await request('PUT',base+'/faq/99',{revision:pub.body.revision,answer:'Changed after publication.'})).code,409);
});
test('failed or incomplete samples cannot imply improvement',()=>{
 const rows=[{engine:'chatgpt',ok:true,response_text:'Here are options:',named:false,domains:[]},{engine:'chatgpt',ok:false,named:null,domains:[]}];
 const s=sampleSummary(rows,'example.org');assert.equal(s[0].usable,0);
 assert.equal(comparableSamples([{engine:'chatgpt',attempted:1,usable:1}],s,true),false);
 assert.equal(comparableSamples([{engine:'chatgpt',attempted:1,usable:1}],[{engine:'chatgpt',attempted:1,usable:1}],false),false);
});
test('approved-fact changes invalidate readiness and generated unsupported numbers are rejected',()=>{
 const facts=[{id:'one',statement:'A 30 ml bottle',approved:true,source_url:'https://example.org/p'}];
 assert.equal(core.validateGeneratedFaq({answer:'The listed serum price is £165 GBP.',fact_ids:['price'],missing_facts:[]},[{id:'price',statement:'Serum £165.00 GBP'}]).answer,'The listed serum price is £165 GBP.');
 assert.throws(()=>core.validateGeneratedFaq({answer:'It costs £99 for a 30 ml bottle.',fact_ids:['one'],missing_facts:[]},core.approvedFacts(facts)));
 assert.throws(()=>core.validateGeneratedFaq({answer:'A 30 ml bottle of serum is included.',fact_ids:['foreign'],missing_facts:[]},core.approvedFacts(facts)));
 assert.throws(()=>core.validateFaqEdit({answer:'A 30 ml bottle of serum is included.',target_url:'https://example.org/p',status:'ready',approved:true},{facts_hash:'old',content:{missing_facts:[]}},'example.org',facts));
});
test('duplicate in-flight generation is rejected and failed requests retain cost records',async()=>{
 let release;hold=new Promise(r=>release=r);
 const a=costs.onceContentJob(39,'brand_facts','concurrent',async id=>costs.recordedCompletion(39,'brand_facts','{"pages":[]}',{onResponse:()=>{}},id));
 while(modelCalls<3)await new Promise(r=>setTimeout(r,5));
 await assert.rejects(()=>costs.onceContentJob(39,'brand_facts','concurrent',()=>{}),/already running/);release();hold=null;await a;
 await assert.rejects(()=>costs.onceContentJob(39,'faq_draft','failed',async id=>{await costs.recordedCompletion(39,'faq_draft',JSON.stringify({approved_facts:[{id:'x'}]}),{},id);throw Error('invalid response');}),/invalid response/);
 const row=await one("SELECT * FROM content_jobs WHERE request_key='failed'");assert.equal(row.status,'failed');assert.equal(Number(row.estimated_cost_usd),.0045);
});
test('a fresh workflow guides a user through facts, draft, publication and matched-repeat controls',async()=>{
 await db.exec(`INSERT INTO projects(id,org_id,name,domain,brand_name,engines) VALUES(41,1,'New brand','example.org','Example',ARRAY['chatgpt']);
 INSERT INTO prompts(id,project_id,text) VALUES(2,41,'What is included in the serum pack?');
 INSERT INTO recommendations(id,project_id,fingerprint,type,title,action,impact,effort,priority,evidence)
 VALUES(100,41,'content_gap:2','content_gap','Review pack','Check',10,1,10,'{"prompt_id":2,"action_plan":{"question":"What is included in the serum pack?","page":"https://example.org/products/serum","evidence":{"answer_url":"/api/projects/41/measurements/62#run-2"}}}');`);
 const dom=new JSDOM('<p>Fresh workspace</p>',{url:'https://cited.test/app',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,d=w.document;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.confirm=()=>true;
 w.fetch=async(path,options={})=>{const r=await request(options.method||'GET',path,options.body?JSON.parse(options.body):undefined);return {ok:r.code<300,status:r.code,json:async()=>r.body};};
 w.eval(read('../src/public/faq-workflow.js'));await w.CitedFaq.open(41,100);
 const wait=async selector=>{for(let i=0;i<200;i++){const el=d.querySelector(selector);if(el&&!d.querySelector('dialog').getAttribute('aria-busy')?.includes('true'))return el;await new Promise(r=>setTimeout(r,5));}throw Error('UI did not reach '+selector+': '+d.body.textContent);};
 d.querySelector('[data-faq-extract]').click();await wait('[data-fact-approved]');d.querySelector('[data-fact-approved]').checked=true;
 d.querySelector('[data-faq-save-facts]').click();await wait('[data-faq-answer]');
 assert.match(d.querySelector('[data-faq-answer]').value,/MISSING/);assert.equal(d.querySelector('[data-faq-copy]').disabled,true);
 d.querySelector('[data-faq-answer]').value='The Example serum comes in a 30 ml bottle. See the product page for current packaging details.';d.querySelector('[data-faq-approved]').checked=true;d.querySelector('[data-faq-save]').click();await wait('[data-faq-report]');
 d.querySelector('[data-faq-step="publish"]').click();d.querySelector('[data-implemented-confirm]').checked=true;d.querySelector('[data-faq-implemented]').click();await wait('[data-faq-scope]');
 d.querySelector('[data-faq-scope]').click();await wait('[data-faq-recheck]');assert.match(d.querySelector('[data-faq-scope-result]').textContent,/1 answer check/);assert.match(d.querySelector('[data-faq-scope-result]').textContent,/estimated/);
 d.querySelector('[data-faq-recheck]').click();await wait('.faq-success table');assert.match(d.querySelector('.faq-success').textContent,/Matched repeat complete/);dom.window.close();
});
test('schema replay archives unverified volumes once and preserves explicit provenance and workflow history',async()=>{
 await db.exec(`INSERT INTO prompts(id,project_id,text,ai_search_volume,origin_details) VALUES(100,39,'Unverified question?',5000,'{}'),(101,39,'Measured source question?',120,'{"aiVolumeEvidence":{"provider":"example","retrievedAt":"2026-10-29"}}');`);
 const before=await one('SELECT COUNT(*)::int AS n FROM faq_workflow_history');
 await db.exec(read('../src/db/schema.sql'));await db.exec(read('../src/db/schema.sql'));
 const old=await one("SELECT * FROM prompts WHERE text='Unverified question?'");assert.equal(old.ai_search_volume,null);assert.equal(old.origin_details.legacyUnverifiedVolume,5000);
 assert.equal((await one("SELECT ai_search_volume FROM prompts WHERE text='Measured source question?'" )).ai_search_volume,120);
 assert.equal((await one('SELECT COUNT(*)::int AS n FROM faq_workflow_history')).n,before.n);
});
test.after(()=>db.close());
