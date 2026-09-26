/** Isolated PostgreSQL and report-rendering regressions. Set PGLITE_MODULE. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {reportHtml,reportCsv} from '../src/lib/report-html.js';
const src=readFileSync(new URL('../src/lib/report.js',import.meta.url),'utf8');
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db=new PGlite();
await db.exec(`CREATE TABLE runs(id int,project_id int,prompt_id int,engine text,cycle_date date,ok boolean);
CREATE TABLE entities(id int,kind text,name text);
CREATE TABLE mentions(run_id int,entity_id int,mentioned boolean);
INSERT INTO entities VALUES(1,'owned','Brand'),(2,'competitor','Rival');
INSERT INTO runs VALUES(1,1,1,'chatgpt','2026-09-25',true),(2,1,1,'chatgpt','2026-09-26',true),(3,1,1,'gemini','2026-09-26',true);
INSERT INTO mentions VALUES(1,1,true),(2,1,false),(3,1,true),(1,2,true),(2,2,true),(3,2,true);`);
const many=async(sql,args)=>(await db.query(sql,args)).rows;
const one=async(sql,args)=>(await many(sql,args))[0];
const sql=vm.createContext({many,one});
vm.runInContext(src.slice(src.indexOf('async function trend('),src.indexOf('async function byPersona(')),sql);
vm.runInContext(src.slice(src.indexOf('async function rivals('),src.indexOf('/** What has been done')),sql);
test('report cohorts exclude an engine added after the first cycle and expose denominator counts',async()=>{
 const result=await sql.trend(1,{from:null,to:null});
 assert.deepEqual(Array.from(result.all,x=>x.answers),[1,2]);
 assert.deepEqual(Array.from(result.stable,x=>x.answers),[1,1]);
 assert.deepEqual(Array.from(result.stable,x=>Number(x.rate)),[1,0]);
});
test('competitor report respects the selected dates rather than using the latest-ever cycle',async()=>{
 const result=await sql.rivals(1,{from:'2026-09-25',to:'2026-09-25'});
 assert.equal(result.find(x=>x.kind==='competitor').answers,1);
 assert.equal(result.find(x=>x.kind==='owned').rate,1);
});
async function fixture(points={all:[{cycle_date:'2026-09-26',rate:0,questions:1,answers:1,named_count:0}],stable:[]},overrides={}){
 const h=vm.createContext({Date,one:async()=>({name:'Test',domain:'example.com',brand_name:'Brand'}),many:async()=>[],windowFor:()=>({from:null,to:null}),readable:x=>x,groupActions:()=>[],persistence:async()=>({items:[],totalCycles:1}),sourceGaps:async()=>({sources:[],ownCited:0,totalCycles:1}),citedPagePatterns:async()=>({pages:0}),trend:async()=>points,completed:async()=>[],aiTraffic:async()=>null,rivals:async()=>[],byPersona:async()=>[],...overrides});
 vm.runInContext(src.slice(src.indexOf('export async function buildReport(')).replace('export ',''),h);return h.buildReport(1);
}
test('a single cycle keeps measured zero but has no movement claim in HTML or data',async()=>{
 const r=await fixture();assert.equal(r.trend.last,0);assert.equal(r.trend.change,null);
 const html=reportHtml(r);assert.match(html,/Not enough comparable measurements/);assert.match(html,/1 measured answers/);assert.doesNotMatch(html,/0<span style="font-size:16px">pts/);
 assert.match(reportCsv(r),/measured_answers/);
});
test('different question-engine cohorts do not acquire a headline trend or sparkline',async()=>{
 const r=await fixture({all:[{cycle_date:'2026-09-25',rate:1,questions:1,answers:1},{cycle_date:'2026-09-26',rate:0,questions:2,answers:2}],stable:[]});
 assert.equal(r.trend.change,null);assert.doesNotMatch(reportHtml(r),/class="spark"/);assert.match(reportHtml(r),/separate samples/);
});
test('comparable report retains observed zero change and states the cohort',async()=>{
 const rows=[{cycle_date:'2026-09-25',rate:0,questions:1,answers:1},{cycle_date:'2026-09-26',rate:0,questions:1,answers:1}];
 const r=await fixture({all:rows,stable:rows});assert.equal(r.trend.change,0);assert.match(reportHtml(r),/common question-and-engine set/);
});
test('report priorities request evidence review rather than promise content or outreach benefits',async()=>{
 const r=await fixture(undefined,{byPersona:async()=>[{persona:'Asked plainly',questions:3,answers:6,named_rate:0}],rivals:async()=>[{kind:'competitor',name:'Rival',rate:1,named:6,answers:6}],sourceGaps:async()=>({sources:[{persistent:true,domain:'example.org',questions:3}],ownCited:0,totalCycles:1})});
 const text=JSON.stringify(r.priorities);assert.doesNotMatch(text,/Write for Asked plainly|usual way in|usually faster/);assert.match(text,/6 measured answers/);assert.match(text,/Review the relevance/);
});
test('page-feature interpretations do not infer causation from a cited-only sample',()=>{
 const patterns=src.slice(src.indexOf('  const reading = []'),src.indexOf('async function trend('));
 assert.doesNotMatch(patterns,/at a disadvantage|word.count target for|because of who publishes|a differentiator/);
 assert.match(patterns,/no uncited comparison group/);assert.match(patterns,/not a recommended word-count target/);
});
test.after(async()=>db.close());
