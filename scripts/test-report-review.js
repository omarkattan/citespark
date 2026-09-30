import {reportNotePreview} from '../src/lib/report-note.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {reportReview} from '../src/lib/report-review.js';
import {summariseEvidence} from '../src/lib/report-evidence.js';
import {reportHtml} from '../src/lib/report-html.js';
test('comparisons isolate project and measurement, preserve zero and missing, and label retrospective results',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();
 try{
 await db.exec(`CREATE TABLE recommendations(id int,project_id int);CREATE TABLE report_review_notes(recommendation_id int,project_id int,title text,notes text,selected_at timestamp);
 CREATE TABLE entities(id int PRIMARY KEY,project_id int,name text,domain text,kind text);CREATE TABLE mentions(run_id int,entity_id int,mentioned boolean);
 CREATE TABLE citations(run_id int,domain text);CREATE TABLE runs(id int,project_id int,ok boolean,response_text text);CREATE TABLE measurement_answers(measurement_id int,run_id int);CREATE TABLE competitor_baselines(entity_id int,measurement_id int,analysis jsonb);
 INSERT INTO entities VALUES(1,28,'Own','www.bank.test','owned'),(2,28,'Retro','retro.test','competitor'),(3,28,'New',null,'competitor'),(4,99,'Other','other.test','owned');
 INSERT INTO runs VALUES(1,28,true,'Answer'),(2,28,true,'Old'),(3,99,true,'Other'),(4,28,true,''),(5,28,false,'Failure');
 INSERT INTO measurement_answers VALUES(41,1),(40,2),(41,3),(41,4),(41,5);INSERT INTO mentions VALUES(1,1,false),(2,1,true),(3,1,true),(4,1,true),(5,1,true);INSERT INTO citations VALUES(1,'news.bank.test');
 INSERT INTO competitor_baselines VALUES(2,41,'{"entity":{"name":"Retro","domain":"retro.test"},"measured":1,"named":0,"cited":0}'),(3,40,'{"measured":99}'),(1,41,'{"measured":99}');
 INSERT INTO recommendations VALUES(1,28),(2,99);INSERT INTO report_review_notes VALUES(1,28,'Selected','Reviewed',now()),(2,99,'Private','Internal',now());`);
 const many=async(sql,args)=>(await db.query(sql,args)).rows;
 const r=await reportReview(28,{id:41},many);assert.equal(r.notes.length,1);assert.equal(r.comparisons.length,3);
 const own=r.comparisons.find(x=>x.id===1);assert.equal(own.measured,1);assert.equal(own.named,0);assert.equal(own.cited,1);assert.equal(own.method,'Measured in this cycle');
 const retro=r.comparisons.find(x=>x.id===2);assert.equal(retro.method,'Retrospective analysis');assert.equal(retro.named,0);
 const fresh=r.comparisons.find(x=>x.id===3);assert.equal(fresh.named,null);assert.equal(fresh.cited,null);
 assert.deepEqual((await reportReview(28,null,many)).comparisons,[]);
 }finally{await db.close();}
});
test('report notes require ownership, snapshot saved text, update explicitly and remove without deleting task',async()=>{
 const source=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');const prefix="app.post('/api/recommendations/:recId/report-note', requireAuth, wrap(async(req,res)=>{";
 const body=source.slice(source.indexOf(prefix)+prefix.length,source.indexOf("\n}));",source.indexOf(prefix))).trim();
 const route=new (Object.getPrototypeOf(async function(){}).constructor)('req','res','one','query','reportNotePreview',body);
 let rec={id:1,project_id:28,title:'Invisible for: Mobile banking',notes:'Reviewed text'},saved,sql;
 const one=async(q,args)=>{if(q.includes('FROM report_review_notes'))return null;assert.match(q,/p.org_id=\$2/);assert.deepEqual(args,[1,7]);return rec;};
 const invoke=async(include)=>{let status=200,result;const res={status:n=>{status=n;return res},json:r=>result=r};await route({params:{recId:'1'},session:{orgId:7},body:{include,version:rec?reportNotePreview(rec).version:null}},res,one,async(q,a)=>{sql=q;saved=a},reportNotePreview);return {status,result};};
 assert.equal((await invoke(true)).status,200);assert.equal(saved[2],'Review visibility for: Mobile banking');assert.equal(saved[3],'Reviewed text');
 rec.notes='Changed internally';assert.equal(saved[3],'Reviewed text');await invoke(true);assert.equal(saved[3],'Changed internally');
 await invoke(false);assert.match(sql,/DELETE FROM report_review_notes/);assert.doesNotMatch(sql,/DELETE FROM recommendations/);
 rec.notes='';assert.equal((await invoke(true)).status,400);rec=null;assert.equal((await invoke(true)).status,404);
});
test('executive output escapes selected notes and labels comparison methods and denominators',()=>{
 const executive={...summariseEvidence([{prompt_id:1,text:'Best mobile banking apps?',source:'generated',engine:'chatgpt',ok:true,mentioned:false,cited:false,response_text:'Complete answer.'}]),measurement:{id:41,started_at:'2026-09-28',settings:{maxTokens:2000}},cycle:'2026-09-28',priorities:[]};
 const r={project:{id:28,name:'Layout test',domain:'bank.example'},generatedAt:'2026-09-29',executive,trend:{comparable:false},review:{notes:[{title:'Review mobile transfers',notes:'<script>alert(1)</script>\n'+('Review existing payment information and links. Confirm fees with the product owner before publication.\n').repeat(20)+'مراجعة خيارات التحويل',selected_at:'2026-09-29'}],comparisons:[{name:'Example bank',kind:'owned',domain:'bank.example',measured:50,named:22,cited:22,method:'Measured in this cycle'},{name:'Example rival',kind:'competitor',domain:'rival.example',measured:50,named:27,cited:16,method:'Retrospective analysis',reviewedAt:'2026-09-28'},{name:'Unmeasured rival',kind:'competitor',measured:0,named:null,cited:null,method:'Not measured in this cycle'}]}};
 const html=reportHtml(r);assert.ok(!html.includes('<script>alert(1)'));assert.match(html,/27 \/ 50/);assert.match(html,/Retrospective analysis/);assert.match(html,/Not measured/);assert.match(html,/Explicitly selected notes/);
 if(process.env.REPORT_PREVIEW)writeFileSync(process.env.REPORT_PREVIEW,html);
});
