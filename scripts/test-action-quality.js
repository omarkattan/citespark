/** Offline task presentation and generation regressions. No provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const recommend=readFileSync(new URL('../src/lib/recommend.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function cardHarness(){
 const h=vm.createContext({esc,evidenceDetails:()=>'',dueLabel:()=>'',STATUS_LABEL:{open:'To do'},TYPE_LABEL:{},state:{},highlight:esc});
 const a=app.indexOf('function renderSourceReview('),b=app.indexOf('function taskCard('),end=app.indexOf('\nfunction ',b+1);vm.runInContext(app.slice(a,end),h);return h;
}
const base={id:3,type:'competitor_comparison',status:'open',title:'LEGACY_TITLE',action:'UNSUPPORTED_COMPARISON_PROMISE',priority:25,effort:4,evidence:{competitor:'Rival <name>',own_rate:0,competitor_rate:100}};
test('old competitor cards replace unsupported advice without mutating saved evidence or status',()=>{
 const h=cardHarness(),before=JSON.stringify(base),html=h.taskCard(base);
 assert.doesNotMatch(html,/LEGACY_TITLE|UNSUPPORTED_COMPARISON_PROMISE|you 0%|Rival &lt;name&gt; 100%/);
 for(const label of ['Observed','Check next','Action supported now','Inspect stored answers'])assert.match(html,new RegExp(label));
 assert.match(html,/Rival &lt;name&gt;/);assert.match(html,/data-status="doing"/);assert.equal(JSON.stringify(base),before);
});
test('source cards retain their relevance warning and evidence controls',()=>{
 const html=cardHarness().taskCard({...base,type:'source_gap',sourceReview:{status:'irrelevant',reason:'Wrong buyer need',question:'Buyer question'},evidence:{domain:'example.com',analysable:true,url:'https://example.com',question:'Buyer question'}});
 assert.match(html,/Source appears unrelated/);assert.match(html,/Page changes and outreach are withheld/);assert.match(html,/View relevance details/);
});
async function overview(tasks){
 const seen=[];const h=vm.createContext({state:{projectId:1,overview:{cycle:'2026-09-26',runs:10,visibility:0}},esc,pct:n=>`${n*100}%`,shortDate:x=>x,taskCard:t=>{seen.push(t.id);return '<article>task</article>';},api:async p=>p.includes('recommendations')?{tasks,people:[]}:p.endsWith('history')?{cycles:[{}]}:{all:10,checksAll:10,costAll:0.11}});
 vm.runInContext(app.slice(app.indexOf('async function viewOverview()'),app.indexOf('async function viewConnections()')),h);
 return {html:await h.viewOverview(),seen};
}
test('Overview excludes only unrelated source reviews and fills its three slots from remaining tasks',async()=>{
 const tasks=[{id:1,type:'source_gap',sourceReview:{status:'irrelevant'}},{id:2,type:'source_gap',sourceReview:{status:'uncertain'}},{id:3,type:'source_gap'},{id:4,type:'competitor_comparison'},{id:5,type:'source_gap',sourceReview:{status:'relevant'}}];
 const before=JSON.stringify(tasks);const result=await overview(tasks);
 assert.deepEqual(result.seen,[2,3,4]);assert.match(result.html,/All opportunities \(5\)/);assert.match(result.html,/Nothing was dismissed or deleted/);assert.equal(JSON.stringify(tasks),before);
});
test('all-unrelated state does not claim that no open tasks exist',async()=>{
 const result=await overview([{id:1,type:'source_gap',sourceReview:{status:'irrelevant'}}]);
 assert.deepEqual(result.seen,[]);assert.match(result.html,/No other tasks to prioritise/);assert.doesNotMatch(result.html,/No open tasks/);
});
test('new competitor recommendations keep identity, rates and priority while adding answer denominators',()=>{
 const g={name:'Rival',domain:'rival.com',impact:100,questions:[{prompt_id:5,text:'Which supplier?',theirs:100,yours:0,own_runs:3,competitor_runs:3}]};
 const h=vm.createContext({rivalGaps:new Map([['Rival',g]]),out:[],rec:x=>x});
 vm.runInContext(recommend.slice(recommend.indexOf('  for (const g of rivalGaps.values())'),recommend.indexOf('  /* Rule 10:')),h);
 const r=h.out[0];assert.equal(r.title,'Rival beats you on 1 question');assert.equal(r.targetUrl,'https://rival.com');assert.equal(r.impact,100);assert.equal(r.evidence.own_rate,0);assert.equal(r.evidence.competitor_rate,100);
 assert.equal(r.evidence.questions[0].own_runs,3);assert.equal(r.evidence.questions[0].competitor_runs,3);assert.equal(r.evidence.questions[0].prompt_id,5);
 assert.doesNotMatch(r.action,/Balanced comparisons|models favour|100% of answers/);assert.match(r.action,/only if the evidence/);
});
test('question evidence labels absent legacy denominators rather than inventing counts',()=>{
 const h=vm.createContext({esc});
 vm.runInContext(app.slice(app.indexOf('function detailPanel('),app.indexOf('const TYPE_LABEL')),h);
 const old=h.evidenceDetails({...base,evidence:{competitor:'Rival',questions:[{question:'Which?',own_rate:0,competitor_rate:100}]}});
 assert.match(old,/counts were not recorded/);
 const fresh=h.evidenceDetails({...base,evidence:{competitor:'Rival',questions:[{question:'Which?',own_rate:0,competitor_rate:100,own_runs:3,competitor_runs:3}]}});
 assert.match(fresh,/measured answers: you 3, competitor 3/);
});
