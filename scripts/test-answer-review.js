import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {hasAnswerText,unmeasuredReason,possibleTruncation} from '../src/lib/answer-quality.js';
const {JSDOM}=await import(process.env.JSDOM_MODULE);
const {PGlite}=await import(process.env.PGLITE_MODULE);
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const data={prompt:'Which accounts?',cycle:'2026-09-29',projectId:28,measurement:{id:43},runs:[
 {id:1,engine:'chatgpt',measured:true,mentioned:true,cited:true,snippet:'Bank <script>alert(1)</script>',response_text:'A stored answer',citations:[{url:'https://bank.example/account',owned:true}]},
 {id:2,engine:'claude',measured:true,mentioned:true,cited:false,response_text:'Named only',citations:[]},
 {id:3,engine:'perplexity',measured:true,mentioned:false,cited:true,response_text:'Citation only',citations:[]},
 {id:4,engine:'ai_mode',measured:true,mentioned:false,cited:false,response_text:'Neither',citations:[]},
 {id:5,engine:'ai_overview',measured:false,mentioned:null,cited:null,error:'Provider unavailable',citations:[]}
]};
function harness(response=data){
 const dom=new JSDOM('<article class="rec" data-task="42"><button data-see-answer="7">Read answers</button><div data-answers hidden></div></article>');
 const h=vm.createContext({document:dom.window.document,window:{COUNTRIES:[]},state:{overview:{project:{market:'JO'}}},esc,shortDate:x=>x,ENGINE_LABEL:{},formatAnswer:esc,answerUrl:x=>/^https?:/.test(x),encodeURIComponent,api:async()=>response});
 vm.runInContext(app.slice(app.indexOf('function answerReviewSummary'),app.indexOf('function detailPanel')),h);
 const body=app.slice(app.indexOf("  const see = e.target.closest('[data-see-answer]');"),app.indexOf('  // Selecting only what is on screen'));
 vm.runInContext('async function openAnswers(e){'+body+'}',h);
 return {document:dom.window.document,h,open:()=>h.openAnswers({target:dom.window.document.querySelector('button')})};
}
test('reader explains overlapping outcomes, excludes unmeasured and keeps stored evidence with the task',async()=>{
 const {document,open}=harness();await open();const text=document.body.textContent;
 assert.match(text,/2 \/ 4.*named your brand/);assert.match(text,/2 \/ 4.*cited your website/);
 assert.match(text,/1 both · 1 named only · 1 cited only · 1 neither/);assert.match(text,/1.*stored answers unmeasured/);
 assert.match(text,/may be newer than the recommendation/);assert.match(text,/Saved brand-match excerpt/);assert.equal(document.querySelector('script'),null);
 assert.equal(document.querySelector('.ans-sources').open,true);
 assert.equal(document.querySelector('[data-next-open]').dataset.nextOpen,'42');
 assert.ok(document.querySelector('a[href="/api/projects/28/measurements/43#run-1"]'));
 assert.match(document.querySelector('.ans-source').textContent,/your website/);
 assert.equal(document.querySelector('[data-reask]').closest('details').open,false);
 assert.match(text,/citation not measured/);assert.equal(document.querySelectorAll('.answer-reader').length,5);
 await open();assert.equal(document.querySelector('[data-answers]').hidden,true);
});
test('unknown citation verdict is not treated as zero and empty responses stay unmeasured',async()=>{
 const h=harness({...data,runs:[{...data.runs[0],cited:undefined}]});await h.open();assert.match(h.document.body.textContent,/Unavailable/);assert.doesNotMatch(h.document.body.textContent,/1 both/);
 const empty=harness({...data,runs:[]});await empty.open();assert.match(empty.document.body.textContent,/Not measured/);assert.match(empty.document.body.textContent,/Nothing stored/);
});
test('load errors allow retry and do not strand the loading button',async()=>{
 const x=harness();x.h.api=async()=>{throw new Error('offline')};await x.open();assert.equal(x.document.querySelector('button').disabled,false);assert.match(x.document.body.textContent,/could not be loaded/);
 await x.open();x.h.api=async()=>data;await x.open();assert.equal(x.document.querySelectorAll('.answer-reader').length,5);
});
test('answers endpoint preserves organization scope, exact-domain citation rules, snippets and null verdicts',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE projects(id int, org_id int, domain text);CREATE TABLE prompts(id int,text text,project_id int);CREATE TABLE entities(id int,project_id int,kind text,name text);CREATE TABLE runs(id int,prompt_id int,project_id int,cycle_date date,engine text,model text,run_index int,response_text text,ok boolean,error text);CREATE TABLE mentions(run_id int,entity_id int,mentioned boolean,ordinal int,snippet text);CREATE TABLE citations(id int,run_id int,domain text,url text);CREATE TABLE published_measurements(id int,project_id int,cycle_date date,started_at timestamptz);CREATE VIEW reporting_runs AS SELECT * FROM runs;
 INSERT INTO projects VALUES(28,1,'bank.example'),(29,2,'other.example');INSERT INTO prompts VALUES(7,'Which accounts?',28),(8,'Private question',29);INSERT INTO entities VALUES(1,28,'owned','Bank'),(2,28,'competitor','Other');
 INSERT INTO published_measurements VALUES(43,28,'2026-09-29','2026-09-29T10:00:00Z');
 INSERT INTO runs VALUES(1,7,28,'2026-09-29','chatgpt','test',0,'Complete.',true,NULL),(2,7,28,'2026-09-29','claude','test',0,'Complete.',true,NULL),(3,7,28,'2026-09-29','ai_mode','test',0,'',false,'Failed'),(4,7,28,'2026-09-29','perplexity','test',0,'Complete.',true,NULL);
 INSERT INTO mentions VALUES(1,1,true,1,'Saved excerpt'),(1,2,false,NULL,NULL),(2,1,false,NULL,NULL);
 INSERT INTO citations VALUES(1,1,'www.bank.example','https://www.bank.example/account'),(2,1,'www.bank.example','https://www.bank.example/account'),(3,2,'bank.example.evil.test','https://bank.example.evil.test'),(4,3,'bank.example','https://bank.example'),(5,4,'bank.example','https://bank.example');`);
 let handler;const h=vm.createContext({app:{get:(_url,_auth,fn)=>handler=fn},requireAuth:()=>{},wrap:fn=>fn,one:async(s,p)=>(await db.query(s,p)).rows[0],many:async(s,p)=>(await db.query(s,p)).rows,hasAnswerText,unmeasuredReason,possibleTruncation,process:{env:{}}});
 const route=server.slice(server.indexOf("app.get('/api/prompts/:promptId/answers'"),server.indexOf('\n/**\n * Ask one question again.'));
 vm.runInContext(route,h);let result,status=200;const res={status:n=>{status=n;return res},json:x=>result=x};
 await handler({params:{promptId:'7'},session:{orgId:1}},res);
 assert.equal(result.runs.length,4);assert.equal(result.measurement.id,43);
 const byId=id=>result.runs.find(x=>x.id===id);
 assert.equal(byId(1).snippet,'Saved excerpt');assert.equal(byId(1).cited,true);assert.equal(byId(2).cited,false);assert.equal(byId(3).cited,null);assert.equal(byId(4).cited,null);assert.equal(byId(4).measured,false);
 await handler({params:{promptId:'8'},session:{orgId:1}},res);assert.equal(status,404);assert.equal(result.error,'Not found');
 }finally{await db.close();}
});
