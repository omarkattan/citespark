import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {measurementSettings} from '../src/lib/measurement-batches.js';
import {introductionOnly,ANSWER_ELIGIBILITY_POLICY} from '../src/lib/answer-eligibility.js';
import {retrySamples,collectionLimit,possibleTruncation} from '../src/lib/answer-quality.js';
const {PGlite}=await import(process.env.PGLITE_MODULE);
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const db=new PGlite();await db.exec(read('../src/db/schema.sql'));
const one=async(sql,p)=>(await db.query(sql,p)).rows[0]||null,many=async(sql,p)=>(await db.query(sql,p)).rows,query=(sql,p)=>db.query(sql,p);
await db.exec(`INSERT INTO orgs(id,name) VALUES(1,'Test');INSERT INTO projects(id,org_id,name,domain,brand_name,engines,runs_per_cycle) VALUES(1,1,'Example','example.org','Example',ARRAY['chatgpt'],3);
 INSERT INTO entities(id,project_id,name,kind,domain) VALUES(1,1,'Example','owned','example.org');
 INSERT INTO prompts(id,project_id,text) VALUES(1,1,'What does this serum cost?'),(2,1,'Which serum should I choose?');`);
const project=await one('SELECT * FROM projects WHERE id=1'),entities=await many('SELECT id,name,aliases,domain,kind,ambiguous_name FROM entities WHERE project_id=1');
const settings=measurementSettings(project,{chatgpt:'gpt-test'},['chatgpt'],3,2000,entities);
await query("INSERT INTO measurement_batches(id,project_id,cycle_date,status,settings,collection_plan) VALUES(1,1,'2026-10-28','completed',$1::jsonb,$2::jsonb)",[JSON.stringify(settings),JSON.stringify([1,2].flatMap(prompt_id=>[0,1,2].map(run_index=>({prompt_id,engine:'chatgpt',run_index}))))]);
await db.exec("SELECT setval('measurement_batches_id_seq',1);INSERT INTO runs(prompt_id,project_id,engine,model,cycle_date,run_index,response_text,measurement_id) SELECT p,1,'chatgpt','gpt-test','2026-10-28',i,'A complete answer about serum choices.',1 FROM generate_series(1,2) p CROSS JOIN generate_series(0,2) i;INSERT INTO mentions(run_id,entity_id,mentioned) SELECT id,1,false FROM runs;");
const budgetForCycle=async()=>({ok:true,maxCalls:99,estimateUsd:.09});
const configs={chatgpt:{kind:'llm',model:'gpt-test'}},resolveModel=async(_eng,_cfg,override)=>override||'gpt-test';
const strip=s=>s.replace(/^import .*;\n/gm,'').replace(/export /g,'');
const helpers=vm.runInNewContext(`(()=>{${strip(read('../src/lib/measurement-batches.js'))};return {startMeasurement,inheritMeasurement,finishMeasurement};})()`,{one,query,ANSWER_ELIGIBILITY_POLICY,console});
const scope=vm.runInNewContext(`(()=>{${strip(read('../src/lib/faq-recheck.js'))};return matchedRecheckScope;})()`,{one,many,measurementSettings,resolveModel,ENGINES:configs,ENGINE_IDS:['chatgpt'],budgetForCycle,introductionOnly,process});
let calls=0,billed=0,failAt=0,providerModel='gpt-test',locked=false;
const cycleSource=read('../src/jobs/runCycle.js');
const reask=vm.runInNewContext(`(()=>{${cycleSource.slice(cycleSource.indexOf('async function collectRetry')).replace(/export /g,'')};return reaskPrompt;})()`,{...helpers,one,many,query,measurementSettings,matchedRecheckScope:scope,
 lockMeasurements:async()=>{if(locked)throw Error('Already running');locked=true;return async()=>{locked=false;};},
 enginesFor:p=>p.engines,ENGINE_CFG:configs,resolveModel,process,assertMeasurementLocation:async()=>{},budgetForCycle,retrySamples,collectionLimit,possibleTruncation,
 askEngine:async()=>{calls++;return {ok:calls!==failAt,model:providerModel,text:'Example offers a labelled serum. Read the website for details.',citations:[{url:'https://example.org/p',domain:'example.org',position:1}],costUsd:.01,error:calls===failAt?'Provider unavailable':null};},
 recordUsage:async(_org,n)=>{billed+=n;},analyseRun:async()=>[{entity_id:1,mentioned:true,ordinal:1,sentiment:'neutral',snippet:'Example offers'}],hasAnthropic:false,isWrapper:()=>false,console});
const draft={prompt_id:1,question:'What does this serum cost?',baseline_measurement_id:1};let first;
test('matched repeat preserves original cohort and collects exactly the original three samples',async()=>{
 const ready=await scope(project,draft);assert.equal(ready.eligible,true);assert.equal(ready.calls,3);
 first=await reask(1,{matched:{baselineId:1,question:draft.question}});assert.equal(calls,3);assert.equal(billed,3);
 const comparison=await scope(project,draft,first.measurementId);assert.equal(comparison.comparable,true);assert.equal(comparison.before[0].usable,3);assert.equal(comparison.after[0].usable,3);assert.equal(comparison.after[0].named,3);
 assert.equal((await one('SELECT COUNT(*)::int AS n FROM measurement_answers WHERE measurement_id=$1',[first.measurementId])).n,3,'targeted repeat contains only its new answers');
 assert.equal((await one('SELECT COUNT(*)::int AS n FROM measurement_answers WHERE measurement_id=1')).n,6,'original baseline immutable');
 assert.equal((await one('SELECT COUNT(*)::int AS n FROM published_measurements')).n,1,'targeted repeat cannot replace daily monitoring');
});
test('changed question or model selection stops the paid request inside the measurement lock',async()=>{
 await query("UPDATE prompts SET text='Changed question?' WHERE id=1");await assert.rejects(()=>reask(1,{matched:{baselineId:1,question:draft.question}}),/question changed/i);assert.equal(calls,3);
 await query('UPDATE prompts SET text=$1 WHERE id=1',[draft.question]);await db.exec(`UPDATE projects SET models='{"chatgpt":"new-model"}' WHERE id=1`);
 await assert.rejects(()=>reask(1,{matched:{baselineId:1,question:draft.question}}),/settings changed/i);assert.equal(calls,3);await db.exec("UPDATE projects SET models='{}' WHERE id=1");
});
test('provider model drift is reported as noncomparable even when requests match',async()=>{
 providerModel='unexpected-model';const r=await reask(1,{matched:{baselineId:1,question:draft.question}});const c=await scope(project,draft,r.measurementId);assert.equal(c.comparable,false);providerModel='gpt-test';
});
test('partial failures keep cost and original evidence without publishing a partial improvement',async()=>{
 failAt=calls+2;const result=await reask(1,{matched:{baselineId:1,question:draft.question}});assert.equal(result.results.filter(r=>r.ok).length,2);
 const batch=await one('SELECT status FROM measurement_batches WHERE id=$1',[result.measurementId]);assert.equal(batch.status,'failed');assert.equal((await scope(project,draft,result.measurementId)).comparable,false);assert.equal(billed,9);
});
test.after(()=>db.close());
