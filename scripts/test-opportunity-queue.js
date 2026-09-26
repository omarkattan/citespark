import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const base={status:'open',priority:25,effort:2,title:'Review',action:'Inspect evidence'};
const tasks=[{...base,id:1,type:'source_gap',sourceReview:{status:'irrelevant',reason:'Other business',question:'Which supplier?'},evidence:{domain:'example.com'}},{...base,id:2,type:'content_gap',evidence:{prompt_id:12,prompt:'Which <supplier>?',runs:6,own_rate:0}},{...base,id:3,type:'competitor_comparison',evidence:{competitor:'Rival'}},{...base,id:4,type:'entity_authority',evidence:{}}];
function harness(){
 const document=new JSDOM('<div id="view"></div>').window.document;
 const state={projectId:26,opportunityProject:26,view:'actions'};
 const h=vm.createContext({document,state,esc,$:id=>document.getElementById(id),dueLabel:()=>'',highlight:esc,evidenceDetails:()=>'',api:async()=>({tasks,counts:{open:4,doing:0,done:0,dismissed:0,total:4}})});
 vm.runInContext(app.slice(app.indexOf('function opportunityKind('),app.indexOf('function renderTeardown(')),h);
 vm.runInContext(app.slice(app.indexOf('const TYPE_LABEL'),app.indexOf('/**\n * Who is doing')),h);
 return {h,document,state};
}
test('complete queue groups tasks with accurate counts and native collapsed cards',async()=>{
 const {h,document}=harness();document.body.innerHTML=await h.viewActions();
 assert.equal(document.querySelectorAll('#opportunityQueue .queue-task').length,4);
 assert.equal(document.querySelectorAll('#opportunityQueue details[open]').length,0);
 const labels=[...document.querySelectorAll('#opportunityKind option')].map(o=>o.textContent);
 assert.deepEqual(labels,['All opportunities (4)','Question reviews (1)','Source reviews (1)','Competitor reviews (1)','Other actions (1)']);
 const source=document.querySelector('[data-task="1"] summary');assert.match(source.textContent,/Source appears unrelated/);
 const question=document.querySelector('[data-task="2"]');assert.match(question.querySelector('summary').textContent,/6 measured answers/);
 assert.equal(question.querySelectorAll('supplier').length,0);
 assert.ok(question.querySelector('[data-see-answer="12"]'));assert.ok(question.querySelector('[data-rec="2"][data-status="doing"]'));
 assert.equal(document.querySelectorAll('.reportbar').length,1);
});
test('focus filtering leaves backend evidence and ordering unchanged',async()=>{
 const {h,document,state}=harness();const before=JSON.stringify(tasks);
 for(const [kind,id] of [['sources','1'],['questions','2'],['competitors','3'],['other','4']]){
  state.opportunityKind=kind;document.body.innerHTML=await h.viewActions();assert.deepEqual([...document.querySelectorAll('[data-task]')].map(e=>e.dataset.task),[id]);
 }
 assert.equal(JSON.stringify(tasks),before);
});
test('changing projects resets focus and empty focus offers a recovery',async()=>{
 const {h,state,document}=harness();state.opportunityKind='questions';state.projectId=27;await h.viewActions();assert.equal(state.opportunityKind,'all');
 h.api=async()=>({tasks:[tasks[0]],counts:{open:1,doing:0,done:0,dismissed:0,total:1}});state.opportunityKind='questions';document.body.innerHTML=await h.viewActions();assert.match(document.body.textContent,/No tasks match this focus/);assert.ok(document.getElementById('opportunityKind'));assert.ok(document.getElementById('repOpen'));
});
test('updating an open task retains the expanded queue card and its new status',async()=>{
 const {h,document}=harness();document.body.innerHTML=await h.viewActions();document.querySelector('[data-task="2"] .queue-task').open=true;
 h.refreshTaskCounts=()=>{};
 vm.runInContext(app.slice(app.indexOf('function replaceCard('),app.indexOf('async function refreshTaskCounts(')),h);
 h.replaceCard(2,{...tasks[1],status:'doing'});
 const card=document.querySelector('[data-task="2"]');assert.equal(card.querySelector('.queue-task').open,true);assert.match(card.querySelector('summary').textContent,/In progress/);assert.ok(card.querySelector('[data-status="done"]'));
});
test('Overview task cards remain expanded rather than inheriting array indexes as options',()=>{
 const {h,document}=harness();document.body.innerHTML=tasks.map(t=>h.taskCard(t)).join('');assert.equal(document.querySelectorAll('.queue-task').length,0);
 assert.doesNotMatch(app,/\.map\(taskCard\)/);
});
