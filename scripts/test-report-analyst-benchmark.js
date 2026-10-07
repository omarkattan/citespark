import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {benchmarkArm,benchmarkPlan} from '../src/lib/report-analyst-benchmark.js';
import {analysisReviewWarnings,analysisRequestPacket} from '../src/lib/report-analyst.js';
const packet={records:[{id:'scope',text:'165 measured answers on one day'}]};
const finding={kind:'investigate',title:'Review attribution',observation:'One day of evidence.',implication:'Scope remains limited.',action:'Inspect the answers.',done_when:'Review recorded.',follow_up:'Repeat the same questions.',evidence:[{id:'scope',quote:'165 measured answers'}]};
const value={findings:[finding],limitations:['One cycle only.']};
function mock(body,inspect=()=>{}){return async(url,options)=>{inspect(JSON.parse(options.body));return {ok:true,json:async()=>body};};}
const response={model:'claude-sonnet-5-5',stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:200},content:[{type:'thinking',thinking:''},{type:'text',text:JSON.stringify(value)}]};
test('candidate uses explicit effort, identical packet and extracts only text',async()=>{
 const result=await benchmarkArm(packet,'claude-sonnet-5-5',{key:'test',fetcher:mock(response,b=>{assert.deepEqual(JSON.parse(b.messages[0].content),analysisRequestPacket(packet));assert.equal(b.output_config.effort,'medium');assert.equal(b.output_config.format.type,'json_schema');assert.equal(b.max_tokens,6000);assert.equal(b.thinking,undefined);})});
 assert.equal(result.status,'complete');assert.equal(result.cost,null);assert.equal(result.analysis.findings[0].title,finding.title);
});
test('baseline request has no unsupported effort configuration',async()=>{
 const r=await benchmarkArm(packet,'claude-sonnet-4-5-20250929',{key:'test',fetcher:mock({...response,model:'claude-sonnet-4-5-20250929'},b=>{assert.equal(b.output_config.effort,undefined);assert.equal(b.output_config.format.type,'json_schema');})});assert.equal(r.status,'complete');assert.ok(r.cost.usd>0);
});
test('truncation retains raw response and usage but withholds analysis',async()=>{
 const r=await benchmarkArm(packet,'claude-sonnet-5-5',{key:'test',fetcher:mock({...response,stop_reason:'max_tokens'})});assert.equal(r.status,'failed');assert.equal(r.response.usage.output_tokens,200);assert.equal(r.analysis,undefined);
});
test('unverified quotations fail without losing provider accounting',async()=>{
 const bad=structuredClone(value);bad.findings[0].evidence[0].quote='invented evidence text';
 const r=await benchmarkArm(packet,'claude-sonnet-5-5',{key:'test',fetcher:mock({...response,content:[{type:'text',text:JSON.stringify(bad)}]})});assert.equal(r.status,'failed');assert.ok(r.response.usage);
});
test('provider failure is one attempt with unknown usage',async()=>{
 let calls=0;const r=await benchmarkArm(packet,'claude-sonnet-5-5',{key:'test',fetcher:async()=>{calls++;return {ok:false,status:429};}});assert.equal(calls,1);assert.equal(r.response,null);assert.equal(r.status,'failed');
});
test('review warnings catch observed interpretation failures',()=>{
 const warnings=analysisReviewWarnings({...finding,title:'Arada outperformed competitors',implication:'The team has agreed because supportedChange=true. Careers entry indicating non-sales enquiries.'});assert.ok(warnings.length>=4);
});
test('benchmark schema is repeatable and duplicate reservation cannot charge twice',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();
 const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8').split('-- Batch 102:')[1];
 await db.exec('CREATE TABLE orgs(id INTEGER PRIMARY KEY); CREATE TABLE projects(id INTEGER PRIMARY KEY); INSERT INTO projects VALUES(31);');
 await db.exec('-- Batch 102:'+schema);await db.exec('-- Batch 102:'+schema);
 const sql="INSERT INTO report_analyst_benchmarks(project_id,source_draft_id,evidence_hash,packet,system_prompt,status) VALUES(31,4,'hash','{}','test','running') ON CONFLICT(project_id,source_draft_id,evaluation_key) DO NOTHING RETURNING id";
 assert.equal((await db.query(sql)).rows.length,1);assert.equal((await db.query(sql)).rows.length,0);
 await db.query("INSERT INTO report_analyst_benchmarks(project_id,source_draft_id,evidence_hash,packet,system_prompt,status,evaluation_key) VALUES(31,4,'new-hash','{}','new prompt','running','new-evidence')");
 await db.exec('-- Batch 102:'+schema);
 assert.equal((await db.query('SELECT * FROM report_analyst_benchmarks')).rows.length,2);
 await db.close();
});

test('candidate-only plan makes one request and distinguishes changed evidence and settings',()=>{
 const single=benchmarkPlan(packet,{candidateOnly:true});
 assert.deepEqual(single.models,['claude-sonnet-5-5']);assert.equal(single.requests,1);
 assert.equal(single.evaluationKey,benchmarkPlan(structuredClone(packet),{candidateOnly:true}).evaluationKey);
 assert.notEqual(single.evaluationKey,benchmarkPlan(packet).evaluationKey);
 assert.notEqual(single.evaluationKey,benchmarkPlan({...packet,analysisPolicy:'new'},{candidateOnly:true}).evaluationKey);
});
