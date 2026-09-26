import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/lib/teardown.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const task={id:7,type:'source_gap',evidence:{url:'https://example.com/page',question:'Which agency?',domain:'example.com'}};
const project={id:26,brand_name:'Sandstorm Digital',domain:'sandstormdigital.com'};
test('loads saved status with matching question, URL and versioned brand context and no provider calls',async()=>{
 let requests;let calls=0;
 const h=vm.createContext({URL,many:async(sql,args)=>{
  calls++;
  if(sql.includes('FROM entities')){assert.equal(args[0],26);return [];}
  assert.match(sql,/question = request.question/);assert.match(sql,/url = request.url/);assert.match(sql,/result->'context' = request.context/);assert.match(sql,/interval '30 days'/);
  requests=JSON.parse(args[0]);
  return [{id:7,relevance:{status:'irrelevant',reason:'Different buyer need'},created_at:'2026-09-26'}];
 },complete:()=>{throw Error('No model call allowed')},fetchPage:()=>{throw Error('No page fetch allowed')}});
 vm.runInContext(source,h);
 const out=await h.attachSourceReviews(project,[task]);
 assert.equal(calls,2);assert.equal(requests[0].context.ownDomain,project.domain);assert.equal(requests[0].context.version,3);
 assert.equal(out[0].sourceReview.status,'irrelevant');assert.equal(out[0].sourceReview.question,task.evidence.question);
 assert.equal(task.sourceReview,undefined);
});
test('skips other task types and malformed URLs, and does not invent status for missing or invalid cache',async()=>{
 const h=vm.createContext({URL,many:async(sql)=>sql.includes('FROM entities')?[]:[{id:7,relevance:{status:'invented'}}]});vm.runInContext(source,h);
 for(const tasks of [[{...task,type:'content_gap'}],[{...task,evidence:{url:'bad',question:'Q'}}],[task]]){
  const out=await h.attachSourceReviews(project,tasks);assert.equal(out[0].sourceReview,undefined);
 }
});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('summary is visible without expanding details and escapes provider text',()=>{
 const h=vm.createContext({esc});vm.runInContext(app.slice(app.indexOf('function renderSourceReview('),app.indexOf('function taskCard(')),h);
 for(const status of ['relevant','irrelevant','uncertain']){
  const html=h.renderSourceReview({status,reason:'<script>bad</script>',question:'Question <b>text</b>'});
  assert.doesNotMatch(html,/<script>|<b>text|hidden/);assert.match(html,/Checked question/);
  if(status!=='relevant')assert.match(html,/withheld/);
 }
 assert.match(h.renderSourceReview(null),/has not been checked/);
});
test('saved review changes card button to view details',()=>{
 const h=vm.createContext({esc,evidenceDetails:()=>'',dueLabel:()=>'',STATUS_LABEL:{open:'To do'},TYPE_LABEL:{},state:{},highlight:esc});
 const a=app.indexOf('function renderSourceReview('),b=app.indexOf('function taskCard('),end=app.indexOf('\nfunction ',b+1);vm.runInContext(app.slice(a,end),h);
 const html=h.taskCard({...task,status:'open',priority:6,effort:2,sourceReview:{status:'irrelevant',reason:'Different buyer need',question:'Which agency?'},evidence:{...task.evidence,analysable:true}});
 assert.match(html,/Source appears unrelated/);assert.match(html,/View relevance details/);
});
test('completion panel uses the measured denominator, not attempted or billed calls',()=>{
 const h=vm.createContext({esc});
 vm.runInContext(app.slice(app.indexOf('function answerSampleLabel('),app.indexOf('function failureNote(')),h);
 const s={runs:120,attempted:120,billable:120,measuredAnswers:119,visibility:0,delta:null};
 assert.match(h.headline(s),/119 successful answers/);assert.doesNotMatch(h.headline(s),/120/);
 assert.match(h.headline({...s,visibility:null,measuredAnswers:0}),/unmeasured/);
 assert.match(h.answerSampleLabel({}),/unavailable/);
});
test('summary counts the same successful matched rows used by visibility',async()=>{
 const job=readFileSync(new URL('../src/jobs/runCycle.js',import.meta.url),'utf8');
 const a=job.indexOf('async function summarise('),b=job.indexOf('// Allow:',a);
 const h=vm.createContext({one:async(sql)=>{
  if(sql.includes('SELECT MAX'))return {d:null};
  if(sql.includes('AS answers')){assert.match(sql,/AND cr.ok/);assert.match(sql,/JOIN mentions/);return {answers:119,r:0};}
  if(sql.includes('COUNT(*)::int AS n'))return {n:35};
  throw Error(sql);
 },many:async()=>[]});
 vm.runInContext(job.slice(a,b),h);
 const s=await h.summarise(26,'2026-09-26',{runs:120,spend:1.67,recs:[],attempted:120,billable:120,failed:[]});
 assert.equal(s.measuredAnswers,119);assert.equal(s.visibility,0);assert.equal(s.runs,120);assert.equal(s.billable,120);
});
