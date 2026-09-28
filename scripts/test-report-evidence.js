import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summariseEvidence,reportEvidence} from '../src/lib/report-evidence.js';
import {reportHtml,reportCsv} from '../src/lib/report-html.js';
import {writeFileSync} from 'node:fs';
const base={prompt_id:1,text:'Which provider?',source:'gsc',engine:'chatgpt',ok:true,mentioned:false,cited:false,response_text:'A finished answer.'};
test('failed and absent measurements do not become zero; citations can exist without naming',()=>{
 const e=summariseEvidence([base,{...base,engine:'claude',mentioned:true},{...base,engine:'gemini',cited:true},{...base,ok:false},{...base,mentioned:null}]);
 assert.deepEqual(e.totals,{missingChecks:null,expectedChecks:null,coverageBasis:'unknown',attempted:5,measured:3,named:1,cited:1,failed:1,unmeasured:1,possiblyTruncated:0,noOverview:0,missingText:0});
 assert.equal(e.coveredQuestions,1);assert.equal(e.priorities[0].owner,'Measurement owner');
});
test('incomplete answers are visible and cannot generate the gap action',()=>{
 const e=summariseEvidence([base,{...base,engine:'claude',response_text:'x'.repeat(7500)}]);
 assert.equal(e.totals.possiblyTruncated,1);assert.equal(e.totals.measured,2);
 assert.ok(!e.priorities.some(p=>p.do.includes('no recorded presence')));
});
test('a single engine is insufficient for a gap action, including repeated samples',()=>{
 assert.ok(!summariseEvidence([base,base]).priorities.some(p=>p.do.includes('no recorded presence')));
 assert.ok(summariseEvidence([base,{...base,engine:'claude'}]).priorities.some(p=>p.do.includes('no recorded presence')));
});
const fixture=e=>({executive:{...e,cycle:'2026-09-28'},project:{name:'Test <img src=x>',domain:'example.com',brand:'Test'},generatedAt:'2026-09-28',trend:{comparable:false,cycles:1,points:[]},methodNotes:[{at:'2026-09-28',note:'Correction',detail:'<script>alert(1)</script>'}],caveats:['A pilot sample.'],sources:{sources:[]},persistence:{items:[]}});
test('HTML escapes evidence, shows denominators, methods and uncertainty; no invented trend',()=>{
 const e=summariseEvidence([{...base,text:'<script>alert(1)</script>',cited:true}]);
 const html=reportHtml(fixture(e));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>alert'));
 assert.match(html,/1 \/ 1 measured answers/);assert.match(html,/No comparable movement claim/);assert.match(html,/Recorded method changes/);
 assert.ok(!html.includes('window.print());'));
});
test('empty evidence remains unmeasured and requests a baseline',()=>{
 const e=summariseEvidence([]);assert.equal(e.strongest,null);assert.match(reportHtml(fixture(e)),/Not measured/);assert.equal(e.priorities[0].do,'Collect a measured baseline.');
});
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
test('SQL isolates selected dates and project, de-duplicates citations, includes failures and missing mentions',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE projects(id int,domain text);CREATE TABLE prompts(id int,text text,source text);CREATE TABLE entities(id int,project_id int,kind text);CREATE TABLE runs(id int,project_id int,prompt_id int,engine text,ok boolean,cycle_date date,response_text text,run_index int,error text);CREATE TABLE mentions(run_id int,entity_id int,mentioned boolean);CREATE TABLE citations(run_id int,domain text);
 INSERT INTO projects VALUES(1,'example.com'),(2,'other.com');INSERT INTO prompts VALUES(1,'Question','gsc'),(2,'Other','generated');INSERT INTO entities VALUES(1,1,'owned'),(2,2,'owned');
 INSERT INTO runs VALUES(1,1,1,'chatgpt',true,'2026-09-27','Finished.',0,NULL),(2,1,1,'claude',true,'2026-09-27','Finished.',0,NULL),(3,1,1,'gemini',false,'2026-09-27','',0,NULL),(4,1,1,'perplexity',true,'2026-09-27','Finished.',0,NULL),(5,1,1,'chatgpt',true,'2026-09-28','Finished.',0,NULL),(6,2,2,'chatgpt',true,'2026-09-27','Finished.',0,NULL);
 INSERT INTO mentions VALUES(1,1,true),(2,1,false),(5,1,true),(6,2,true);INSERT INTO citations VALUES(2,'example.com'),(2,'www.example.com');`);
 await db.exec(`CREATE VIEW reporting_runs AS SELECT * FROM runs; CREATE VIEW published_measurements AS SELECT DISTINCT project_id,cycle_date FROM runs;`);
 const e=await reportEvidence(1,{from:'2026-09-27',to:'2026-09-27'},async(s,p)=>(await db.query(s,p)).rows);
 assert.equal(e.totals.measured,2);assert.equal(e.totals.named,1);assert.equal(e.totals.cited,1);assert.equal(e.totals.failed,1);assert.equal(e.totals.unmeasured,1);assert.equal(e.questions.length,1);
 }finally{await db.close();}
});
// Optional synthetic rendering fixture for offline print-layout inspection.
if(process.env.REPORT_PREVIEW){
 const rows=[];for(let i=1;i<=23;i++) for(const engine of ['chatgpt','claude','gemini','perplexity','ai_mode','ai_overview']) rows.push({...base,prompt_id:i,text:`Which wealth management providers offer international private-market access for buyer group ${i}?`,engine,mentioned:i%3===0,cited:i%2===0});
 const r=fixture(summariseEvidence(rows));r.project={name:'Sample Company',domain:'example.com'};r.methodNotes=[];writeFileSync(process.env.REPORT_PREVIEW,reportHtml(r));
}
test('data export carries the same question counts and detailed report keeps the date selection',()=>{
 const r=fixture(summariseEvidence([{...base,cited:true}]));r.period={chosen:true,from:'2026-09-01',to:'2026-09-28'};
 const csv=reportCsv(r);assert.match(csv,/Latest-cycle question evidence/);assert.match(csv,/"Which provider\?","gsc","1","0","1","0","0","0"/);
 const html=reportHtml(r);assert.match(html,/detail=1&amp;from=2026-09-01&amp;to=2026-09-28/);
});
