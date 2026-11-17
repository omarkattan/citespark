import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {seedChecks,checkState,terminalizeChecks,ledgerSummary,attemptRecorder,outcomeFor} from '../src/lib/measurement-ledger.js';
import {recoveryConfiguration,loadRecovery,inheritRecovery,recoveryPlan} from '../src/lib/measurement-recovery.js';
import {citationFacts,citationHost} from '../src/lib/citation-evidence.js';
import {analyseRun} from '../src/lib/analyze.js';
import {reviewedEntityNames,JORDAN_BANK_NAMES} from '../src/lib/entity-names.js';
import {configuredRunScope,runScopeProblem} from '../src/lib/run-scope.js';
import {selectedEntities} from '../src/lib/quick-start-selection.js';
import {ANSWER_ELIGIBILITY_POLICY} from '../src/lib/answer-eligibility.js';
import {estimateEngineCosts} from '../src/lib/measurement-cost.js';
import {requestCounts} from '../src/lib/measurement-coverage.js';
import {collectionLimit} from '../src/lib/answer-quality.js';
import {ENGINES} from '../src/lib/dataforseo.js';
import {reportEvidence} from '../src/lib/report-evidence.js';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8');
async function fixture(){
 const db=new PGlite();await db.exec(schema);
 await db.exec(`INSERT INTO orgs(id,name) VALUES(1,'Test');
 INSERT INTO projects(id,org_id,name,brand_name,domain,market,engines,runs_per_cycle) VALUES(28,1,'Etihad','Bank al Etihad','bankaletihad.com','JO','{chatgpt,claude,gemini,perplexity,ai_mode,ai_overview}',1);
 INSERT INTO entities(id,project_id,name,domain,kind,aliases) VALUES(1,28,'Bank al Etihad','bankaletihad.com','owned','{بنك الاتحاد}');`);
 for(let i=1;i<=60;i++)await db.query('INSERT INTO prompts(id,project_id,text) VALUES($1,28,$2)',[i,i<=30?`Which bank in Jordan ${i}?`:`ما أفضل بنك في الأردن ${i}؟`]);
 return db;
}
function worker(db,ask){
 const query=(s,p)=>db.query(s,p),one=async(s,p)=>(await query(s,p)).rows[0]||null,many=async(s,p)=>(await query(s,p)).rows;
 const helpers=readFileSync(new URL('../src/lib/measurement-batches.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replaceAll('export ','');
 const batch=new Function('reviewedEntityNames','ANSWER_ELIGIBILITY_POLICY','one','query','pool',`${helpers};return {measurementSettings,startMeasurement,finishMeasurement,inheritMeasurement,comparableSettings};`)(reviewedEntityNames,ANSWER_ELIGIBILITY_POLICY,one,query,db);
 let source=readFileSync(new URL('../src/jobs/runCycle.js',import.meta.url),'utf8');
 source=source.slice(source.indexOf('async function pooled'),source.indexOf('/**\n * What actually changed'));
 source=source.replaceAll('export ','').replaceAll("await import('../lib/notify.js')","({notify:async()=>{}})").replaceAll("await import('../lib/teardown.js')","({teardownTopCited:async()=>({torn:0})})");
 const deps={...batch,one,many,query,pool:db,CONCURRENCY:4,MOCK:true,ENGINE_CFG:ENGINES,hasAnthropic:false,enginesFor:p=>p.engines,
  lockMeasurements:async()=>async()=>{},assertMeasurementLocation:async()=>{},resolveModel:async(e,c,o)=>o||`${e}-pinned`,
  budgetForCycle:async(o,s)=>({ok:true,engines:s.engines,runs:s.runs,maxCalls:s.questions*s.engines.length*s.runs,entitlements:{advanced:true}}),
  configuredRunScope,runScopeProblem,selectedEntities,estimateEngineCosts,requestCounts,collectionLimit,analyseRun,
  seedChecks,checkState,attemptRecorder,terminalizeChecks,ledgerSummary,outcomeFor,recoveryConfiguration,loadRecovery,inheritRecovery,
  askEngine:ask,isWrapper:()=>false,resolveAll:async()=>new Map(),domainOf:()=>null,recordUsage:async()=>{},
  buildRecommendations:async()=>[],persistRecommendations:async()=>{},summarise:async()=>({})};
 return new Function(...Object.keys(deps),`${source};return runCycleForProject;`)(...Object.values(deps));
}
test('actual 360-check collector isolates five gaps, saves every outcome, recovers only five under its own snapshot, and duplicate recovery buys nothing',async()=>{
 const db=await fixture();try{
  const calls=[];let inject=true;
  const run=worker(db,async o=>{
   calls.push(o);const id=`a-${calls.length}`;
   await o.onAttempt({phase:'dispatch',id,request:{prompt:o.prompt,model:o.model}});
   if(inject&&o.prompt==='Which bank in Jordan 15?'&&['chatgpt','claude','perplexity','ai_overview'].includes(o.engine))throw Error('simulated interruption');
   if(inject&&o.prompt==='ما أفضل بنك في الأردن 40؟'&&o.engine==='ai_overview')return {ok:false,text:'',citations:[],error:'Internal SE Server Error.',costUsd:0};
   const answer={ok:true,text:'Bank al Etihad is one option.',citations:[],model:o.model,costUsd:0,evidence:{citationCollection:'recorded'}};
   await o.onAttempt({phase:'response',id,response:{tasks:[{id,status_code:20000,result:[{items:[{type:'message',sections:[{text:answer.text,annotations:[]}]}]}]}]},httpStatus:200,costUsd:0});
   return answer;
  });
  const result=await run(28);assert.equal(result.partial,true);assert.equal(calls.length,360);
  const first=result.measurementId,c=await ledgerSummary(db,first);
  assert.equal(c.planned,360);assert.equal(c.usable,355);assert.equal(c.unresolved,5);assert.equal(c.pending,0);
  assert.equal((await db.query('SELECT * FROM runs')).rows.length,356);
  assert.equal((await db.query('SELECT * FROM reporting_runs')).rows.length,356);
  const report=await reportEvidence(28,{from:null,to:null},async(s,p)=>(await db.query(s,p)).rows);
  assert.equal(Number(report.measurement.id),Number(first));assert.equal(report.provisional,true);assert.equal(report.totals.measured,355);assert.equal(report.totals.missingChecks,4);
  await db.exec("UPDATE projects SET engines='{chatgpt}',runs_per_cycle=3,market='AE'; UPDATE prompts SET active=false WHERE id>30");
  const preview=await run(28,{recoverFrom:first,previewRecovery:true});assert.equal(preview.retry,5);assert.equal(preview.retained,355);assert.equal(calls.length,360);
  inject=false;const recovered=await run(28,{recoverFrom:first});assert.equal(calls.length,365);assert.notEqual(recovered.measurementId,first);
  assert.ok(calls.slice(360).every(c=>c.market==='JO'&&c.maxTokens===2000));
  const resolved=await ledgerSummary(db,recovered.measurementId);assert.equal(resolved.usable,360);assert.equal(resolved.status,'completed');
  assert.equal((await db.query('SELECT * FROM measurement_answers WHERE measurement_id=$1',[first])).rows.length,356);
  assert.equal((await db.query('SELECT * FROM measurement_answers WHERE measurement_id=$1',[recovered.measurementId])).rows.length,360);
  await run(28,{recoverFrom:first});assert.equal(calls.length,365);
 }finally{await db.close();}
});
test('ledger selects only one result and repeated attempt callbacks cannot duplicate evidence',async()=>{
 const db=await fixture();try{
  const b=(await db.query("INSERT INTO measurement_batches(project_id,cycle_date,status) VALUES(28,CURRENT_DATE,'running') RETURNING *")).rows[0];
  const plan=[{prompt_id:1,text:'Q',engine:'chatgpt',run_index:0}];await seedChecks(db,b,plan);await seedChecks(db,b,plan);
  const job={prompt:{id:1},engine:'chatgpt',runIndex:0},record=attemptRecorder(db,b.id,job);
  await record({phase:'dispatch',id:'same',request:{prompt:'Q'}});await record({phase:'dispatch',id:'same',request:{prompt:'Q'}});
  await record({phase:'response',id:'same',response:{tasks:[{id:'provider-id'}]},httpStatus:200});
  await record({phase:'response',id:'same',response:{tasks:[{id:'provider-id'}]},httpStatus:200});
  for(let i=0;i<2;i++){const r=(await db.query("INSERT INTO runs(project_id,prompt_id,engine,measurement_id,response_text) VALUES(28,1,'chatgpt',$1,'Answer') RETURNING id",[b.id])).rows[0];await checkState(db,b.id,job,'collected',null,r.id);}
  assert.equal((await db.query('SELECT * FROM measurement_answers WHERE measurement_id=$1',[b.id])).rows.length,1);
  assert.equal((await db.query('SELECT * FROM runs')).rows.length,2);assert.equal((await db.query('SELECT * FROM provider_attempts')).rows.length,1);
 }finally{await db.close();}
});
test('citation destinations distinguish main/blog, missing instrumentation, and opaque URLs',()=>{
 const rows=[{id:1,engine:'claude',ok:true,response_text:'Answer',citations:[]},
 {id:2,engine:'perplexity',ok:true,response_text:'Answer',citation_evidence:{citationCollection:'recorded'},citations:[]},
 {id:3,engine:'gemini',ok:true,response_text:'Answer',citation_evidence:{citationCollection:'recorded'},citations:[{url:'https://www.bankaletihad.com/a'},{url:'https://blog.bankaletihad.com/a'},{url:'https://bankaletihad.com.evil.test/'},{url:'https://other.test/?q=bankaletihad.com'}]},
 {id:4,engine:'ai_overview',ok:true,response_text:'Answer',citations:[{url:'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc'}]}];
 const f=citationFacts(rows,'bankaletihad.com');assert.equal(f.complete,false);assert.equal(f.ownedAnswers,1);assert.equal(f.ownedHosts.length,2);assert.equal(f.engines.find(e=>e.engine==='claude').citationRate,null);assert.equal(f.engines.find(e=>e.engine==='perplexity').noCitationReturned,1);assert.equal(f.engines.find(e=>e.engine==='ai_overview').unresolved,1);
 assert.equal(citationHost('https://evil.test/bankaletihad.com'),'evil.test');
});
test('all nine bilingual entities, Arabic normalisation and lookalike exclusions preserve URL/name separation',async()=>{
 let i=0;for(const [domain,names] of Object.entries(JORDAN_BANK_NAMES)){
  const e=reviewedEntityNames({id:++i,name:names[0],domain,aliases:[]});
  for(const text of names){const r=await analyseRun({text:text+'.',entities:[e]});assert.equal(r[0].mentioned,true,`${domain}: ${text}`);}
 }
 const entities=[reviewedEntityNames({id:1,name:'Bank of Jordan',domain:'bankofjordan.com',aliases:[]}),reviewedEntityNames({id:2,name:'Arab Bank',domain:'arabbank.jo',aliases:[]})];
 for(const text of ['Central Bank of Jordan and Islamic International Arab Bank.','البنك المركزي الأردني والبنك العربي الإسلامي الدولي.'])assert.ok((await analyseRun({text,entities})).every(r=>!r.mentioned));
 assert.equal((await analyseRun({text:'بَنْك الأُرْدُنّ.',entities}))[0].mentioned,true);
 assert.equal((await analyseRun({text:'[source](https://bankofjordan.com)',entities}))[0].mentioned,false);
 assert.equal((await analyseRun({text:'xبنك الأردنx',entities}))[0].mentioned,false);
});

test('saved provider payload restores a processing failure without repeating the paid request',async()=>{
 const db=await fixture();try {
  await db.exec("UPDATE prompts SET active=false WHERE id>1; UPDATE projects SET engines='{chatgpt}'");
  let calls=0,fail=true;
  const proxy={query:async(s,p)=>{if(fail&&s.includes('INSERT INTO runs')){fail=false;throw Error('simulated run insert outage');}return db.query(s,p);}};
  const run=worker(proxy,async o=>{calls++;await o.onAttempt({phase:'dispatch',id:'saved',request:{model:o.model}});
   const response={tasks:[{id:'paid-provider-id',status_code:20000,result:[{model_name:o.model,items:[{type:'message',sections:[{text:'Bank al Etihad is an option.',annotations:[{url:'https://blog.bankaletihad.com/article',title:'Article',start_index:0,end_index:13}]}]}]}]}]};
   await o.onAttempt({phase:'response',id:'saved',response,httpStatus:200,costUsd:.02});
   return {ok:true,text:'Bank al Etihad is an option.',model:o.model,citations:[],costUsd:.02};
  });
  await assert.rejects(run(28),/No answer records completed/);
  const original=(await db.query('SELECT * FROM measurement_batches ORDER BY id DESC LIMIT 1')).rows[0];
  assert.equal(original.status,'failed');assert.equal((await ledgerSummary(db,original.id)).counts.interrupted,1);
  const preview=await run(28,{recoverFrom:original.id,previewRecovery:true});assert.equal(preview.retry,0);assert.equal(preview.replay,1);assert.equal(calls,1);
  const restored=await run(28,{recoverFrom:original.id});assert.equal(calls,1);assert.equal((await ledgerSummary(db,restored.measurementId)).status,'completed');
  const citation=(await db.query('SELECT * FROM citations')).rows[0];assert.equal(citation.title,'Article');assert.equal(citation.original_url,'https://blog.bankaletihad.com/article');
  assert.equal((await db.query('SELECT * FROM provider_attempts')).rows.length,1);
 }finally{await db.close();}
});
test('worker interruption gives every pending slot an explicit terminal outcome and retains successful selections',async()=>{
 const db=await fixture();try{
  const batch=(await db.query("INSERT INTO measurement_batches(project_id,cycle_date,status) VALUES(28,CURRENT_DATE,'running') RETURNING *")).rows[0];
  const plan=[1,2,3].map(i=>({prompt_id:i,text:'Q',engine:'chatgpt',run_index:0}));await seedChecks(db,batch,plan);
  await checkState(db,batch.id,{prompt:{id:1},engine:'chatgpt',runIndex:0},'collected');
  await checkState(db,batch.id,{prompt:{id:2},engine:'chatgpt',runIndex:0},'running');
  await terminalizeChecks(db,batch.id);const c=await ledgerSummary(db,batch.id);
  assert.equal(c.pending,0);assert.equal(c.usable,1);assert.equal(c.counts.interrupted,2);assert.equal(c.status,'partial');
  assert.equal(outcomeFor({ok:true,text:'',noOverview:true}),'no_answer');assert.equal(outcomeFor({ok:true,text:''}),'incomplete');assert.equal(outcomeFor({ok:false,text:''}),'failed');
 }finally{await db.close();}
});
test('safe wrapper matching rejects lookalike hosts and private redirect destinations',async()=>{
 const {isWrapper,publicDestination}=await import('../src/lib/citation-wrapper.js');
 assert.equal(isWrapper('https://vertexaisearch.cloud.google.com/grounding-api-redirect/a'),true);
 assert.equal(isWrapper('https://vertexaisearch.cloud.google.com.attacker.example/a'),false);
 assert.equal(isWrapper('https://google.com/url-invented'),false);
 assert.equal(isWrapper('https://google.com/goto?url=opaque-token'),true);
 assert.equal(citationFacts([{id:1,ok:true,response_text:'Answer.',engine:'ai_overview',citations:[{url:'https://google.com/goto?url=opaque-token'}]}],'bankaletihad.com').engines[0].attributable,0);
 for(const url of ['http://127.0.0.1/','http://169.254.169.254/','http://[::1]/','http://localhost/','file:///etc/passwd','https://user:pass@bankaletihad.com/'])assert.equal(publicDestination(url),false,url);
 assert.equal(publicDestination('https://blog.bankaletihad.com/a'),true);
});
test('historical v2 recovery keeps its original Arabic matching policy',async()=>{
 const entity={id:1,name:'Test bank',aliases:['بنك الأردن'],kind:'owned'};
 assert.equal((await analyseRun({text:'بَنْك الأُرْدُنّ.',entities:[entity],policy:'visible-text-v2'}))[0].mentioned,false);
 assert.equal((await analyseRun({text:'بَنْك الأُرْدُنّ.',entities:[entity],policy:'visible-text-v3-ar'}))[0].mentioned,true);
});
