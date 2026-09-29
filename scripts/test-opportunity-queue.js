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
 assert.equal(document.querySelectorAll('#opportunityQueue > article, #opportunityQueue > section').length,4);
 assert.equal(document.querySelectorAll('#opportunityQueue details[open]').length,0);
 const labels=[...document.querySelectorAll('#opportunityKind option')].map(o=>o.textContent);
 assert.deepEqual(labels,['All opportunities (4 checks)','Question reviews (1 check)','Source reviews (1 check)','Competitor reviews (1 check)','Other actions (1 check)']);
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
test('Task cards require an explicit compact option rather than inheriting array indexes',()=>{
 const {h,document}=harness();document.body.innerHTML=tasks.map(t=>h.taskCard(t)).join('');assert.equal(document.querySelectorAll('.queue-task').length,0);
 assert.doesNotMatch(app,/\.map\(taskCard\)/);
});
test('overlapping question checks form one review while notes, assignments, report selections and completed states remain independent',async()=>{
 const {h,document,state}=harness();state.taskFilter='all';
 const list=[{...tasks[1],notes:'Approved next step',assignee:'editor@example.test',reportIncluded:true}, {...tasks[1],id:20,type:'entity_authority',status:'done',notes:'Identity checked',assignee:'reviewer@example.test'}, {...tasks[1],id:21,evidence:{...tasks[1].evidence,prompt_id:13,prompt:'أي مورد مناسب؟'}}];
 const before=JSON.stringify(list);
 h.api=async()=>({tasks:list,counts:{open:2,doing:0,done:1,dismissed:0,total:3}});
 document.body.innerHTML=await h.viewActions();
 assert.equal(document.querySelectorAll('[data-question-group]').length,2);
 assert.equal(document.querySelectorAll('[data-task]').length,3);
 assert.match(document.querySelector('[data-question-group="question:12"] > details > summary').textContent,/1 to do · 1 done/);
 assert.match(document.querySelector('[data-task="2"]').textContent,/Approved next step/);
 assert.ok(document.querySelector('[data-task="2"] [data-report-note="2"][data-include="false"]'));
 assert.equal(document.getElementById('a-20').value,'reviewer@example.test');
 assert.ok(document.querySelector('[data-task="20"] [data-status="open"]'));
 assert.doesNotMatch(document.body.textContent,/Suggested priority|priority 25|effort 2\/5/);
 assert.equal(JSON.stringify(list),before);
});
test('group summaries refresh after status or owner changes without replacing another check’s unsaved notes',async()=>{
 const {h,document}=harness();let list=[tasks[1],{...tasks[1],id:20,type:'entity_authority'}];
 h.api=async()=>({tasks:list,counts:{open:1,doing:1,done:0,dismissed:0,total:2}});
 document.body.innerHTML=await h.viewActions();document.querySelector('.question-review').open=true;
 document.getElementById('next-note-20').value='Unsaved draft';document.getElementById('next-editor-20').hidden=false;
 vm.runInContext(app.slice(app.indexOf('async function refreshTaskCounts('),app.indexOf('/* ---------- setup ---------- */',app.indexOf('async function refreshTaskCounts('))),h);
 list=[{...tasks[1],status:'doing',assignee:'owner@example.test'},list[1]];
 await h.refreshTaskCounts();
 assert.match(document.querySelector('.question-review > summary').textContent,/1 to do · 1 in progress/);
 assert.match(document.querySelector('.question-review > summary').textContent,/owner@example.test/);
 assert.equal(document.getElementById('next-note-20').value,'Unsaved draft');assert.equal(document.getElementById('next-editor-20').hidden,false);assert.equal(document.querySelector('.question-review').open,true);
});
test('review ordering puts scheduled and ongoing work first, then questions ahead of source popularity',()=>{
 const {h}=harness();const source={...tasks[0],priority:999999};
 const due={...source,id:90,due_date:'2000-01-01'};const doing={...source,id:91,status:'doing'};
 const groups=h.reviewGroups([source,tasks[1],doing,due,tasks[2]]);
 assert.deepEqual(Array.from(groups,g=>g.tasks[0].id),[90,91,2,3,1]);
});

test('explicit decisions appear in groups while legacy notes never imply readiness',async()=>{
 const {h,document}=harness();
 h.api=async()=>({tasks:[{...tasks[1],notes:'Existing review'},{...tasks[1],id:22,review_decision:{stage:'ready',page:'https://bank.test/app',evidence:'<unsafe>',change:'Add transfer link',reviewed_at:'2026-09-29'}}],counts:{open:2,doing:0,done:0,total:2}});
 document.body.innerHTML=await h.viewActions();
 assert.match(document.querySelector('[data-question-group] > details > summary').textContent,/1 ready to implement/);
 assert.match(document.querySelector('[data-task="2"] [data-decision-summary]').textContent,/Needs investigation/);
 assert.equal(document.getElementById('decision-evidence-22').value,'<unsafe>');assert.equal(document.querySelector('unsafe'),null);
 assert.equal(document.getElementById('next-note-2').value,'Existing review');
});
test('queue sorts ready decisions above investigation and no-change below, retaining due work',()=>{
 const {h}=harness();const base={...tasks[1],evidence:{prompt_id:0}};
 const list=[{...base,id:1},{...base,id:2,review_decision:{stage:'no_change'}},{...base,id:3,review_decision:{stage:'ready'}},{...base,id:4,due_date:'2000-01-01'}];
 assert.deepEqual(Array.from(h.reviewGroups(list),g=>g.tasks[0].id),[4,3,1,2]);
});
test('decision filter resets on changing projects',async()=>{
 const {h,state,document}=harness();state.opportunityDecision='ready';state.projectId=99;
 document.body.innerHTML=await h.viewActions();assert.equal(state.opportunityDecision,'all');assert.equal(document.getElementById('opportunityDecision').value,'all');
});
test('saved decisions lead collapsed reviews safely while retaining the original question and full decision',()=>{
 const {h,document}=harness();
 const change='Add <transfer> links & clarify options. '+ 'Supporting detail. '.repeat(25);
 const task={...tasks[1],review_decision:{stage:'ready',change,page:'https://example.com/',evidence:'Reviewed answer'},notes:'Keep existing notes'};
 document.body.innerHTML=h.reviewGroupCard(h.reviewGroups([task])[0]);
 const heading=document.querySelector('.question-review > summary .rec-title');
 assert.equal(heading.textContent.length,238);
 assert.match(heading.textContent,/^Add <transfer> links & clarify options/);
 assert.match(document.querySelector('.question-review > summary').textContent,/Question: Which <supplier>\?/);
 assert.equal(document.querySelectorAll('transfer').length,0);
 assert.match(document.querySelector('[data-review-context]').textContent,/Original check:/);
 assert.ok([...document.querySelectorAll('textarea')].some(el=>el.value===change));
 assert.match(document.body.textContent,/Keep existing notes/);
 assert.match(h.queueCountText([task],1),/^1 review shown, containing 1 of 1 matching saved check\.$/);
});
test('a no-change decision on a secondary check does not hide an unfinished investigation',()=>{
 const {h,document}=harness();
 const pending={...tasks[1],id:100};
 const reviewed={...pending,id:101,review_decision:{stage:'no_change',change:'No new page required'}};
 const group=h.reviewGroups([reviewed,pending])[0];
 document.body.innerHTML=h.reviewGroupCard(group);
 assert.equal(document.querySelector('.question-review > summary .rec-title').textContent,pending.evidence.prompt);
 assert.match(document.querySelector('[data-task="101"] [data-review-title]').textContent,/No new page required/);
});
test('saving or clearing decision wording updates headings without replacing open work or drafts',()=>{
 const {h,document}=harness();
 document.body.innerHTML=h.taskCard(tasks[1],true);
 const card=document.querySelector('[data-task]');
 const original=card.querySelector('[data-review-title]').textContent;
 const context=card.querySelector('[data-review-context]').textContent;
 const editor=card.querySelector('textarea');editor.value='Unsaved work';
 card.querySelector('details').open=true;
 h.panel=card;h.result={stage:'ready',change:'Add a descriptive transfer link'};
 const start=app.indexOf("  const card=panel.closest('[data-task]');",app.indexOf("panel.querySelector('[data-decision-summary]').textContent"));
 const block=app.slice(start,app.indexOf('  const badge=',start));
 vm.runInContext('{'+block+'}',h);
 assert.equal(card.querySelector('[data-review-title]').textContent,h.result.change);
 assert.equal(card.querySelector('textarea'),editor);assert.equal(editor.value,'Unsaved work');
 assert.equal(card.querySelector('details').open,true);
 h.result={stage:'investigate',change:''};vm.runInContext('{'+block+'}',h);
 assert.equal(card.querySelector('[data-review-title]').textContent,original);
 assert.equal(card.querySelector('[data-review-context]').textContent,context);
});
