import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyseRun,looksTruncated} from '../src/lib/analyze.js';
import {NO_OVERVIEW,unmeasuredReason,measuredQuestionRates,retrySamples,possibleTruncation,collectionLimit} from '../src/lib/answer-quality.js';
import {summariseEvidence} from '../src/lib/report-evidence.js';
import {repairEmptyAnswers} from '../src/lib/repair-empty-answers.js';
const entities=[{id:1,name:'Acme',kind:'owned'}];
test('empty text produces no measurement; actual absence remains measured zero',async()=>{
 for(const text of ['',null,undefined,' \n\t '])assert.deepEqual(await analyseRun({text,entities,useModel:true}),[]);
 assert.equal((await analyseRun({text:'Other providers are available.',entities}))[0].mentioned,false);
});
test('question rates exclude missing verdicts and preserve measured zero',()=>{
 assert.deepEqual(measuredQuestionRates([{mentioned:null,cited:false}]),{measured:false,measuredAnswers:0,rate:null,citedRate:null,seenRate:null});
 const r=measuredQuestionRates([{mentioned:null},{mentioned:false,cited:true},{mentioned:true,cited:false}]);
 assert.equal(r.rate,.5);assert.equal(r.citedRate,.5);assert.equal(r.seenRate,1);assert.equal(r.measuredAnswers,2);
});
test('known no overview and unexplained legacy blank stay distinct',()=>{
 assert.equal(unmeasuredReason({ok:true,response_text:'',error:NO_OVERVIEW}),NO_OVERVIEW);
 assert.match(unmeasuredReason({ok:true,response_text:''}),/reason is not recorded/);
 const base={prompt_id:1,text:'Question',engine:'ai_overview',ok:true,mentioned:false,response_text:''};
 const e=summariseEvidence([base,{...base,error:NO_OVERVIEW}]);
 assert.equal(e.totals.measured,0);assert.equal(e.totals.unmeasured,2);assert.equal(e.totals.noOverview,1);assert.equal(e.totals.missingText,1);
});
test('heuristic does not mark a closed table as definitely unfinished',()=>{
 const prefix='x'.repeat(7500);
 assert.equal(looksTruncated(prefix+'\n| Acme | Dubai |'),false);
 assert.equal(looksTruncated(prefix+'\n| Acme | Dub'),true);
});
test('retry keeps all successful samples, including long and blank outcomes',()=>{
 const rows=[{id:1,ok:true,response_text:'x'.repeat(8000)},{id:2,ok:true,response_text:''},{id:3,ok:false}];
 const r=retrySamples(rows);assert.deepEqual(r.sound.map(x=>x.id),[1,2]);assert.deepEqual(r.broken.map(x=>x.id),[3]);
});
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
async function fixture(){const db=new PGlite();await db.exec(`
 CREATE TABLE projects(id int primary key,name text);CREATE TABLE runs(id int primary key,project_id int,engine text,cycle_date date,ok boolean,response_text text,max_output_tokens int,quality_review jsonb);
 CREATE TABLE mentions(id int,run_id int,entity_id int,mentioned boolean,ordinal int,sentiment text,snippet text);
 CREATE TABLE method_notes(project_id int,note text,detail text);CREATE TABLE citations(run_id int,domain text);
 INSERT INTO projects VALUES(27,'TFO'),(28,'Other');
 INSERT INTO runs VALUES(1,27,'ai_overview','2026-09-28',true,'',NULL,NULL),(2,27,'chatgpt','2026-09-28',true,'Other providers.',NULL,NULL),(3,28,'ai_overview','2026-09-28',true,'',NULL,NULL),(4,27,'gemini','2026-09-28',false,NULL,NULL,NULL);
 INSERT INTO mentions VALUES(1,1,1,false,NULL,NULL,NULL),(2,1,2,false,NULL,NULL,NULL),(3,2,1,false,NULL,NULL,NULL),(4,3,3,false,NULL,NULL,NULL);
 INSERT INTO citations VALUES(1,'example.com');`);return db;}
test('repair is scoped, archived, idempotent and has a read-only preview',async()=>{
 const db=await fixture();try{
 const before=(await db.query('SELECT * FROM mentions ORDER BY id')).rows;
 const preview=await repairEmptyAnswers(db,27);assert.equal(preview.runs,1);assert.equal(preview.rows,2);
 assert.deepEqual((await db.query('SELECT * FROM mentions ORDER BY id')).rows,before);
 await repairEmptyAnswers(db,27,{apply:true});
 assert.deepEqual((await db.query('SELECT id FROM mentions ORDER BY id')).rows.map(x=>x.id),[3,4]);
 assert.equal((await db.query('SELECT * FROM runs')).rows.length,4);assert.equal((await db.query('SELECT * FROM citations')).rows.length,1);
 assert.deepEqual((await db.query('SELECT before_rows FROM measurement_repairs')).rows[0].before_rows.map(x=>x.id),[1,2]);
 assert.equal((await repairEmptyAnswers(db,27,{apply:true})).rows,0);assert.equal((await db.query('SELECT * FROM method_notes')).rows.length,1);
 }finally{await db.close();}
});
test('an audit-write failure rolls back the removal',async()=>{
 const db=await fixture();try{
 const fail={query:(sql,args)=>{if(sql.startsWith('INSERT INTO method_notes'))throw Error('audit unavailable');return db.query(sql,args);}};
 await assert.rejects(()=>repairEmptyAnswers(fail,27,{apply:true}),/audit unavailable/);
 assert.equal((await db.query('SELECT * FROM mentions')).rows.length,4);
 }finally{await db.close();}
});

test('recorded and reviewed completeness survive a runtime limit change',()=>{
 const text='x'.repeat(3000);
 assert.equal(possibleTruncation({response_text:text,max_output_tokens:700},2000),true);
 assert.equal(possibleTruncation({response_text:text,quality_review:{possibleTruncation:true}},2000),true);
 assert.equal(possibleTruncation({response_text:text,max_output_tokens:2000},700),false);
});

test('Google SERP answers are not evaluated against the assistant token limit',()=>{
 for(const engine of ['ai_mode','ai_overview']) {
  assert.equal(collectionLimit(engine,700),null);
  assert.equal(possibleTruncation({engine,response_text:'x'.repeat(4000)},700),false);
 }
 assert.equal(collectionLimit('gemini',700),700);
});
