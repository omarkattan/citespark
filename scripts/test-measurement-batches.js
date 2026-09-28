import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {requestCounts} from '../src/lib/measurement-coverage.js';
import {archiveHtml,measurementHtml} from '../src/lib/measurement-archive.js';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const migration=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8').split('-- Batch 29:')[1];
async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE TABLE projects(id integer primary key);
 CREATE TABLE runs(id serial primary key,project_id integer,cycle_date date,created_at timestamptz default now(),ok boolean,response_text text,cost_usd numeric);
 INSERT INTO projects VALUES(27),(28);
 INSERT INTO runs(project_id,cycle_date,ok,response_text,cost_usd) VALUES(27,'2026-09-28',true,'Old answer',.03),(28,'2026-09-28',true,'Other site',.02);`);
 await db.exec('-- Batch 29:'+migration);return db;
}
test('migration backfills legacy groups once and retains all raw evidence and costs',async()=>{
 const db=await fixture();try{
 await db.exec('-- Batch 29:'+migration);
 assert.equal((await db.query('SELECT * FROM measurement_batches')).rows.length,2);
 assert.equal((await db.query('SELECT * FROM reporting_runs')).rows.length,2);
 assert.equal(Number((await db.query('SELECT SUM(cost_usd) AS cost FROM runs')).rows[0].cost),.05);
 }finally{await db.close();}
});
test('same-day runs remain separate and unfinished or failed batches do not replace completed results',async()=>{
 const db=await fixture();try{
 const old=(await db.query('SELECT id FROM measurement_batches WHERE project_id=27')).rows[0].id;
 const b=(await db.query(`INSERT INTO measurement_batches(project_id,cycle_date,status,settings) VALUES(27,'2026-09-28','running','{"maxTokens":2000}') RETURNING id`)).rows[0].id;
 await db.query(`INSERT INTO runs(project_id,cycle_date,ok,response_text,measurement_id) VALUES(27,'2026-09-28',true,'New answer',$1)`,[b]);
 const shown=async()=> (await db.query('SELECT response_text FROM reporting_runs WHERE project_id=27')).rows.map(r=>r.response_text);
 assert.deepEqual(await shown(),['Old answer']);
 await db.query("UPDATE measurement_batches SET status='failed' WHERE id=$1",[b]);assert.deepEqual(await shown(),['Old answer']);
 await db.query("UPDATE measurement_batches SET status='completed',completed_at=now() WHERE id=$1",[b]);assert.deepEqual(await shown(),['New answer']);
 assert.equal((await db.query('SELECT * FROM measurement_answers WHERE measurement_id=$1',[old])).rows.length,1);
 assert.equal((await db.query('SELECT * FROM runs WHERE project_id=27')).rows.length,2);
 assert.equal((await db.query('SELECT * FROM reporting_runs WHERE project_id=28')).rows.length,1);
 }finally{await db.close();}
});
test('retry snapshots inherit evidence without duplicating provider charges or changing the prior snapshot',async()=>{
 const db=await fixture();try{
 const old=(await db.query('SELECT id FROM measurement_batches WHERE project_id=27')).rows[0].id;
 const b=(await db.query("INSERT INTO measurement_batches(project_id,cycle_date,status) VALUES(27,'2026-09-28','running') RETURNING id")).rows[0].id;
 await db.query('INSERT INTO measurement_members SELECT $1,run_id FROM measurement_answers WHERE measurement_id=$2',[b,old]);
 await db.query(`INSERT INTO runs(project_id,cycle_date,ok,response_text,cost_usd,measurement_id) VALUES(27,'2026-09-28',true,'Retry',.04,$1)`,[b]);
 await db.query("UPDATE measurement_batches SET status='completed',completed_at=now() WHERE id=$1",[b]);
 assert.equal((await db.query('SELECT * FROM reporting_runs WHERE project_id=27')).rows.length,2);
 assert.equal((await db.query('SELECT * FROM measurement_answers WHERE measurement_id=$1',[old])).rows.length,1);
 assert.equal(Number((await db.query('SELECT SUM(cost_usd) AS cost FROM runs WHERE project_id=27')).rows[0].cost),.07);
 }finally{await db.close();}
});
test('archive escapes untrusted questions, answers and settings',()=>{
 const project={id:27,name:'<script>alert(1)</script>'};
 const batch={id:1,status:'completed',settings:{maxTokens:2000},started_at:'2026-09-28T12:00:00Z'};
 const html=measurementHtml(project,batch,[{text:'<img onerror=x>',response_text:'<script>x</script>',citations:[]}]);
 assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
 assert.match(archiveHtml(project,[batch]),/measurements\/1/);
});
const helperSource=readFileSync(new URL('../src/lib/measurement-batches.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').replaceAll('export ','');
function helper(db){return new Function('one','query','pool',`${helperSource};return {startMeasurement,finishMeasurement,inheritMeasurement,comparableSettings,measurementSettings};`)(async(s,p)=>(await db.query(s,p)).rows[0],(s,p)=>db.query(s,p),{});}
test('changed limits and unknown legacy methods refuse partial merges before any provider call',async()=>{
 const db=await fixture();try{
 await db.exec('CREATE TABLE method_notes(project_id integer,note text,detail text)');
 const h=helper(db),settings={maxTokens:2000,models:{gemini:'pin'}};
 const first=await h.startMeasurement(27,'2026-09-28',settings);
 await assert.rejects(h.inheritMeasurement(first,settings),/historical settings are unknown/);
 await h.finishMeasurement(first.id,'completed');
 const retry=await h.startMeasurement(27,'2026-09-28',settings);
 await h.inheritMeasurement(retry,settings);
 await h.finishMeasurement(retry.id,'completed');
 const different=await h.startMeasurement(27,'2026-09-28',{...settings,maxTokens:700});
 await assert.rejects(h.inheritMeasurement(different,{...settings,maxTokens:700}),/Settings changed/);
 assert.equal((await db.query('SELECT * FROM method_notes')).rows.length,2);
 }finally{await db.close();}
});
test('comparison gating rejects unknown or changed settings but permits identical known settings',async()=>{
 const db=await fixture();try{
 await db.exec('CREATE TABLE method_notes(project_id integer,note text,detail text)');
 const h=helper(db),settings={maxTokens:2000,models:{gemini:'pin'}};
 const first=await h.startMeasurement(27,'2026-09-29',settings);await h.finishMeasurement(first.id,'completed');
 assert.equal(await h.comparableSettings(27),false);
 const next=await h.startMeasurement(27,'2026-09-30',settings);await h.finishMeasurement(next.id,'completed');
 assert.equal(await h.comparableSettings(27,{from:'2026-09-29'}),true);
 const diff=await h.startMeasurement(27,'2026-09-30',{...settings,maxTokens:700});await h.finishMeasurement(diff.id,'completed');
 assert.equal(await h.comparableSettings(27,{from:'2026-09-29'}),false);
 }finally{await db.close();}
});
test('full schema installs twice and native report selects only latest completed same-day answers',async()=>{
 const db=new PGlite();try{
 const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8');
 await db.exec(schema);await db.exec(schema);
 await db.exec(`INSERT INTO orgs(id,name) VALUES(1,'Test');
 INSERT INTO projects(id,org_id,name,domain,brand_name) VALUES(27,1,'Acme','acme.test','Acme');
 INSERT INTO prompts(id,project_id,text) VALUES(1,27,'Question');
 INSERT INTO entities(id,project_id,name,domain,kind) VALUES(1,27,'Acme','acme.test','owned');
 INSERT INTO measurement_batches(id,project_id,cycle_date,status,completed_at,settings) VALUES(100,27,'2026-09-28','completed','2026-09-28T10:00Z','{"maxTokens":700}'),(101,27,'2026-09-28','running',NULL,'{"maxTokens":2000}');
 INSERT INTO runs(id,project_id,prompt_id,engine,cycle_date,ok,response_text,measurement_id) VALUES(100,27,1,'gemini','2026-09-28',true,'Old Acme',100),(101,27,1,'gemini','2026-09-28',true,'New other brand',101);
 INSERT INTO mentions(run_id,entity_id,mentioned) VALUES(100,1,true),(101,1,false);`);
 const {reportEvidence}=await import('../src/lib/report-evidence.js');
 const read=()=>reportEvidence(27,{from:null,to:null},async(s,p)=>(await db.query(s,p)).rows);
 let result=await read();assert.equal(result.totals.named,1);assert.equal(result.totals.measured,1);assert.equal(Number(result.measurement.id),100);
 await db.exec("UPDATE measurement_batches SET status='completed',completed_at='2026-09-28T11:00Z' WHERE id=101");
 result=await read();assert.equal(result.totals.named,0);assert.equal(result.totals.measured,1);assert.equal(Number(result.measurement.id),101);
 }finally{await db.close();}
});
const jobSource=readFileSync(new URL('../src/jobs/runCycle.js',import.meta.url),'utf8');
const collectSource=jobSource.slice(jobSource.indexOf('async function collectProject'),jobSource.indexOf('/**\n * What actually changed'))
 .replace("  const { resolveModel, ENGINES: ENGINE_CFG } = await import('../lib/dataforseo.js');",'')
 .replace("const { teardownTopCited } = await import('../lib/teardown.js');",'const teardownTopCited=async()=>({torn:0});');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function collectionFixture(failSave=false){
 const events=[],inserts=[];let registered;
 const deps={requestCounts,one:async(sql,params)=>{
  if(sql.includes('FROM projects'))return {id:27,org_id:1,brand_name:'Acme',engines:['gemini'],runs_per_cycle:1};
  if(sql.includes('INSERT INTO runs')){inserts.push(params);if(failSave)throw Error('write failed');return {id:1};}
  return null;
 },many:async sql=>sql.includes('SELECT * FROM prompts')?[{id:1,text:'Q'}]:sql.includes('SELECT * FROM entities')?[{id:1,kind:'owned',name:'Acme'}]:[],
 query:async()=>{},enginesFor:p=>p.engines,budgetForCycle:async()=>({ok:true,engines:['gemini'],runs:1,maxCalls:1}),MOCK:true,
 resolveModel:async()=> 'selected-model',ENGINE_CFG:{gemini:{kind:'llm'}},
 startMeasurement:async()=>{events.push('start');return {id:123,settings:{}};},measurementSettings:()=>({}),inheritMeasurement:async()=>{},
 pooled:async(items,worker,limit,onError)=>{for(const item of items)try{await worker(item);}catch(e){onError(e);}},CONCURRENCY:1,
 askEngine:async()=>{events.push('ask');return {ok:true,text:'Acme.',model:'selected-model',costUsd:.01,citations:[]};},collectionLimit:(e,n)=>n,
 analyseRun:async()=>[{entity_id:1,mentioned:true}],hasAnthropic:false,isWrapper:()=>false,resolveAll:async()=>new Map(),domainOf:()=>null,
 recordUsage:async()=>events.push('usage'),finishMeasurement:async(id,status)=>events.push(status),
 buildRecommendations:async()=>[],persistRecommendations:async()=>{},summarise:async()=>({}),comparableSettings:async()=>false};
 const run=new AsyncFunction(...Object.keys(deps),'register',`${collectSource}; return collectProject(27,{},register);`);
 let error;try{await run(...Object.values(deps),b=>{registered=b;});}catch(e){error=e;}
 return {events,inserts,error,registered};
}
test('full collector attaches each answer to its batch and publishes only after saved evidence and accounting',async()=>{
 const r=await collectionFixture();assert.equal(r.error,undefined);
 assert.equal(r.inserts[0].at(-1),123);assert.deepEqual(r.events,['start','ask','usage','completed']);assert.equal(r.registered,null);
});
test('a persistence failure leaves the batch unpublished and accounts for provider spend',async()=>{
 const r=await collectionFixture(true);assert.match(r.error.message,/could not be saved/);
 assert.deepEqual(r.events,['start','ask','usage']);assert.equal(r.registered.id,123);
});
