/** Offline PostgreSQL regression suite. Install @electric-sql/pglite in a separate test directory. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
process.env.DATABASE_URL='postgres://test:test@127.0.0.1:1/test';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const {reviseQuestion}=await import('../src/lib/question-revisions.js');
const db=new PGlite();
const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8');
await db.exec(schema);await db.exec(schema);
const database={connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
const org=await one("INSERT INTO orgs(name) VALUES ('Test') RETURNING id");
const other=await one("INSERT INTO orgs(name) VALUES ('Other') RETURNING id");
const project=await one("INSERT INTO projects(org_id,name,domain,brand_name,market,gsc_site_url) VALUES ($1,'Test','example.com','Brand','AE','sc-domain:example.com') RETURNING id",[org.id]);
async function add(text,source='gsc',active=true){return one(`INSERT INTO prompts(project_id,text,source,ai_search_volume,active,origin_details) VALUES($1,$2,$3,450,$4,'{"queryExamples":["original query"]}') RETURNING *`,[project.id,text,source,active]);}
test('measured GSC question preserves its wording, runs and provenance when revised',async()=>{
 const old=await add('Which agency should our business choose?');
 await db.query("INSERT INTO runs(prompt_id,project_id,engine,cycle_date,response_text,ok) VALUES($1,$2,'chatgpt','2026-09-26','An old answer',true)",[old.id,project.id]);
 const result=await reviseQuestion({orgId:org.id,promptId:old.id,expectedText:old.text,text:'Which agency serves UAE enterprise businesses?'},database);
 const prior=await one('SELECT * FROM prompts WHERE id=$1',[old.id]);
 assert.equal(prior.text,old.text);assert.equal(prior.active,false);assert.equal(prior.ai_search_volume,450);
 assert.equal(result.question.source,'gsc');assert.equal(result.question.revises_prompt_id,old.id);assert.equal(result.question.active,true);assert.equal(result.question.ai_search_volume,null);
 assert.deepEqual(result.question.origin_details,old.origin_details);
 assert.equal((await one('SELECT COUNT(*)::int AS n FROM runs WHERE prompt_id=$1',[old.id])).n,1);
 assert.equal((await one('SELECT COUNT(*)::int AS n FROM runs WHERE prompt_id=$1',[result.question.id])).n,0);
 assert.equal((await one("SELECT COUNT(*)::int AS n FROM prompt_events WHERE prompt_id=$1 AND event='reworded'",[result.question.id])).n,1);
});
test('unmeasured and in-flight identities are never reused for new wording',async()=>{
 const old=await add('Which software can track my brand?', 'custom');
 const r=await reviseQuestion({orgId:org.id,promptId:old.id,expectedText:old.text,text:'Which software tracks brands in AI answers?'},database);
 assert.notEqual(r.question.id,old.id);
 // An already-running job can still write its old response against the old identity.
 await db.query("INSERT INTO runs(prompt_id,project_id,engine,cycle_date,response_text,ok) VALUES($1,$2,'chatgpt','2026-09-26','Old wording answer',true)",[old.id,project.id]);
 assert.equal((await one('SELECT COUNT(*)::int AS n FROM runs WHERE prompt_id=$1',[r.question.id])).n,0);
});
test('cross-account, stale and duplicate edits do not mutate originals',async()=>{
 const old=await add('What services should a marketing agency provide?','generated');
 await add('What services should a digital agency provide?');
 for(const args of [
  {orgId:other.id,expectedText:old.text,text:'Can another account change this question?'},
  {orgId:org.id,expectedText:'stale',text:'Can this wording be changed after refresh?'},
  {orgId:org.id,expectedText:old.text,text:'What services should a digital agency provide?'}
 ])await assert.rejects(reviseQuestion({...args,promptId:old.id},database));
 assert.equal((await one('SELECT active FROM prompts WHERE id=$1',[old.id])).active,true);
 assert.equal((await one('SELECT COUNT(*)::int AS n FROM prompts WHERE revises_prompt_id=$1',[old.id])).n,0);
});
test('paused revisions stay paused and repeated revisions of the old version are rejected',async()=>{
 const old=await add('How do buyers select a trusted supplier?','topic',false);
 const r=await reviseQuestion({orgId:org.id,promptId:old.id,expectedText:old.text,text:'How do UAE buyers select a trusted supplier?'},database);
 assert.equal(r.question.active,false);
 await assert.rejects(reviseQuestion({orgId:org.id,promptId:old.id,expectedText:old.text,text:'How do Dubai buyers select a supplier?'},database),e=>e.status===409);
});
test('failed audit write rolls back the replacement and old active state',async()=>{
 const old=await add('Which agencies help with ecommerce growth?');
 const failing={connect:async()=>({query:async(sql,args)=>{if(sql.includes('INSERT INTO prompt_events'))throw Error('Injected failure');return db.query(sql,args);},release(){}})};
 await assert.rejects(reviseQuestion({orgId:org.id,promptId:old.id,expectedText:old.text,text:'Which agencies support UAE ecommerce growth?'},failing));
 assert.equal((await one('SELECT active FROM prompts WHERE id=$1',[old.id])).active,true);
 assert.equal((await one('SELECT COUNT(*)::int AS n FROM prompts WHERE revises_prompt_id=$1',[old.id])).n,0);
});
test('GSC imports retain original-query versus model-rewritten provenance',async()=>{
 const code=readFileSync(new URL('../src/lib/gsc.js',import.meta.url),'utf8');
 const start=code.indexOf('export async function importQuestions(');
 const h=vm.createContext({one,Date});vm.runInContext(code.slice(start).replace('export ',''),h);
 await h.importQuestions(project.id,[{text:'Which agencies serve buyers in Dubai?',source:'gsc+model',impressions:150,cluster:'agency',examples:['digital agency dubai']},{text:'How do digital agencies set their fees?',source:'gsc',impressions:0,examples:['How do digital agencies set their fees?']}]);
 const rows=(await db.query("SELECT source,origin_details,ai_search_volume FROM prompts WHERE source IN ('gsc+model','gsc-query') ORDER BY id")).rows;
 assert.equal(rows.length,2);assert.equal(rows[0].source,'gsc+model');assert.equal(rows[1].source,'gsc-query');assert.equal(rows[1].ai_search_volume,0);
 assert.equal(rows[0].origin_details.property,'sc-domain:example.com');assert.deepEqual(rows[0].origin_details.queryExamples,['digital agency dubai']);
});
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('all entry points are available even before the first question exists',async()=>{
 const h=vm.createContext({esc,helpDot:()=>'',state:{projectId:1,overview:{project:{}}},api:async(path)=>path.endsWith('/prompts')?[]:path.endsWith('/run-scope')?{all:0,checksAll:0,costAll:0}:{},searchBox:()=>'',pct:x=>x});
 const a=app.indexOf('function questionSourceLabel('),b=app.indexOf('async function viewRivals(',a);vm.runInContext(app.slice(a,b),h);
 const html=await h.viewQuestions();
 for(const id of ['q_add','q_topic','q_generate','gscLoad','gscBody','suggestPersonas','personaList','promptList'])assert.match(html,new RegExp(`id="${id}"`));
 assert.match(html,/connect an account/);assert.doesNotMatch(html,/Add some in Setup/);
});
test('source badges and paused revisions retain visible provenance without promising a run',async()=>{
 const rows=[{id:1,text:'Which supplier should I choose?',source:'gsc+model',active:false,replacedBy:2,originDetails:{property:'sc-domain:example.com',queryExamples:['supplier <choice>']},citations:[]},
 {id:2,text:'Which UAE supplier should I choose?',source:'persona',active:true,revisesPromptId:1,originDetails:{baseSource:'gsc+model'},citations:[]}];
 const h=vm.createContext({esc,helpDot:()=>'',state:{projectId:1,overview:{project:{}}},api:async(path)=>path.endsWith('/prompts')?rows:path.endsWith('/run-scope')?{all:1,checksAll:6,costAll:0.08}:{},searchBox:()=>'',pct:x=>x});
 const a=app.indexOf('function questionSourceLabel('),b=app.indexOf('async function viewRivals(',a);vm.runInContext(app.slice(a,b),h);
 const html=await h.viewQuestions();
 assert.match(html,/GSC-derived, AI rephrased/);assert.match(html,/based on GSC-derived, AI rephrased/);
 assert.match(html,/supplier &lt;choice&gt;/);assert.match(html,/Paused and excluded from the next cycle/);
 assert.match(html,/data-question-edit="2"/);assert.doesNotMatch(html,/data-question-edit="1"/);
 assert.match(html,/1 active questions &middot; 6 answer checks/);
});
test.after(async()=>{await db.close();});
