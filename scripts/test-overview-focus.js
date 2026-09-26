import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness({measured=true,history={cycles:[{}]},tasks=null,counts={open:150,doing:2}}={}){
 const document=new JSDOM('<main id="view"></main>').window.document;
 const state={projectId:26,view:'overview',overview:measured?{cycle:'2026-09-26',runs:119,visibility:0}:{}};
 const data=tasks || Array.from({length:4},(_,i)=>({id:i+1,status:'open',type:'content_gap',title:'old',action:'old',priority:25-i,effort:4,evidence:{prompt_id:i+1,prompt:`Buyer question ${i+1}`,runs:6,own_rate:0}}));
 const h=vm.createContext({document,state,esc,$:id=>document.getElementById(id),pct:n=>`${n*100}%`,shortDate:x=>x,dueLabel:()=>'',highlight:esc,evidenceDetails:()=>'',api:async url=>url.includes('recommendations')?{tasks:data,counts,people:[]}:url.endsWith('history')?history:{all:20,checksAll:120,costAll:1.67}});
 vm.runInContext(app.slice(app.indexOf('async function viewOverview()'),app.indexOf('async function viewConnections()')),h);
 vm.runInContext(app.slice(app.indexOf('const TYPE_LABEL'),app.indexOf('/**\n * Who is doing')),h);
 vm.runInContext("const STATUS_LABEL={open:'To do',doing:'In progress',done:'Done',dismissed:'Dismissed'}",h);
 return {h,document,state};
}
test('complete Overview renders three compact tasks, two summary panels and separate run controls',async()=>{
 const {h,document}=harness();document.getElementById('view').innerHTML=await h.viewOverview();
 assert.equal(document.querySelectorAll('.overview-focus > section').length,2);assert.equal(document.querySelectorAll('#overviewNext .queue-task').length,3);
 assert.equal(document.querySelectorAll('#overviewNext .queue-task[open]').length,0);
 assert.match(document.body.textContent,/Named in 0% of 119 successfully measured answers/);assert.match(document.body.textContent,/All opportunities \(152\)/);
 assert.match(document.body.textContent,/One measurement so far/);assert.ok(document.querySelector('.overview-measurement [data-start-first-cycle]'));assert.equal(document.querySelector('.overview-measurement').open,false);
 assert.match(document.body.textContent,/20 active questions · 120 answer checks · estimated \$1.67/);
});
test('primary action opens and focuses the first task without a paid run',async()=>{
 const {h,document}=harness();document.getElementById('view').innerHTML=await h.viewOverview();
 let scrolled=false;document.querySelector('.queue-task').scrollIntoView=()=>scrolled=true;
 const start=app.indexOf("document.addEventListener('click', async event => {\n  if (event.target.closest('[data-overview-next]'))");
 vm.runInContext(app.slice(start,app.indexOf("$('projectPicker').addEventListener",start)),h);
 document.querySelector('[data-overview-next]').click();assert.equal(document.querySelector('.queue-task').open,true);assert.equal(document.activeElement,document.querySelector('.queue-task summary'));assert.equal(scrolled,true);
});
test('unmeasured site prioritises question review rather than a false zero',async()=>{
 const {h,document}=harness({measured:false,tasks:[],counts:{open:0,doing:0},history:{cycles:[]}});document.body.innerHTML=await h.viewOverview();
 assert.match(document.body.textContent,/Not measured/);assert.doesNotMatch(document.body.textContent,/Named in 0%/);assert.ok(document.querySelector('.overview-intro [data-open-view="questions"]'));
});
test('multiple measurements link to comparable cohorts without inventing a direction',async()=>{
 const {h}=harness({history:{cycles:[{},{}]}});const html=await h.viewOverview();assert.match(html,/comparable question-and-engine cohort/);assert.doesNotMatch(html,/visibility (rose|fell|increased|decreased)/);
});
test('failed history remains unavailable instead of claiming no change',async()=>{
 const {h}=harness({history:{error:'Unavailable'}});assert.match(await h.viewOverview(),/Trend history could not be loaded/);
});

const task=(id,type='content_gap',extra={})=>({id,type,status:'open',priority:50,effort:2,evidence:{prompt_id:id,prompt:`Question ${id}`,runs:6,own_rate:0},...extra});
async function shortlist(tasks,counts={open:tasks.length,doing:0}) {
 const {h,document}=harness({tasks,counts});const before=JSON.stringify(tasks);
 document.body.innerHTML=await h.viewOverview();assert.equal(JSON.stringify(tasks),before);
 return {ids:[...document.querySelectorAll('#overviewNext [data-task]')].map(e=>Number(e.dataset.task)),text:document.body.textContent};
}
test('three high-score sources do not crowd out question and competitor reviews',async()=>{
 const r=await shortlist([task(1,'source_gap'),task(2,'source_gap'),task(3,'source_gap'),task(4),task(5,'competitor_comparison')]);
 assert.deepEqual(r.ids,[4,5,1]);assert.match(r.text,/Why this task:/);assert.match(r.text,/does not predict improvement/);
});
test('overdue work then in-progress work override category diversity',async()=>{
 const r=await shortlist([task(1),task(2,'source_gap',{due_date:'2000-01-01'}),task(3,'source_gap',{status:'doing'}),task(4,'competitor_comparison')]);
 assert.deepEqual(r.ids,[2,3,1]);assert.match(r.text,/Overdue/);assert.match(r.text,/Already in progress/);
});
test('due today wins over in-progress and distant future dates do not monopolise slots',async()=>{
 const d=new Date();const today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 const r=await shortlist([task(1,'source_gap',{due_date:'2099-01-01'}),task(2,'source_gap',{due_date:today}),task(3,'source_gap',{status:'doing'}),task(4)]);
 assert.deepEqual(r.ids,[2,3,4]);assert.match(r.text,/Due today/);
});
test('source relevance stays scoped, unrelated sources stay excluded, and selection has no duplicates',async()=>{
 const r=await shortlist([task(1,'source_gap',{sourceReview:{status:'irrelevant'},due_date:'2000-01-01'}),task(2,'source_gap',{sourceReview:{status:'uncertain'}}),task(3,'source_gap'),task(4,'source_gap',{sourceReview:{status:'relevant'},status:'doing'})]);
 assert.deepEqual(r.ids,[4,3,2]);assert.match(r.text,/Nothing was dismissed or deleted/);
});
test('same-category work fills available slots and completed work is never selected',async()=>{
 const r=await shortlist([task(1,'content_gap',{status:'done'}),task(2),task(3),task(4)]);
 assert.deepEqual(r.ids,[2,3,4]);
});
test('a capped candidate list discloses its scope without claiming all tasks were ranked',async()=>{
 const r=await shortlist([task(1),task(2)],{open:140,doing:0});
 assert.deepEqual(r.ids,[1,2]);assert.match(r.text,/considers the first 2 tasks returned/);assert.match(r.text,/All opportunities \(140\)/);
});
