/** UI regression checks. Install jsdom outside production and set JSDOM_MODULE. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const index=readFileSync(new URL('../src/public/index.html',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness(overrides={}) {
 const dom=new JSDOM(index);const document=dom.window.document;
 const state={projectId:25,view:'overview',overview:{project:{},cycle:'2026-09-26',runs:10,visibility:0}};
 const h=vm.createContext({state,document,$:id=>document.getElementById(id),esc,pct:n=>`${Math.round(n*100)}%`,shortDate:x=>x,taskCard:t=>`<article>${esc(t.title)}</article>`,api:async path=>path.includes('/recommendations')?{tasks:[],people:[]}:path.endsWith('/history')?{cycles:[{}]}:{all:10,checksAll:10,costAll:0.11},...overrides});
 vm.runInContext(app.slice(app.indexOf('const VIEW_SECTION'),app.indexOf('async function viewActions')),h);
 return {h,document,state};
}
test('five primary sections and every existing destination has the right parent',()=>{
 const {h,document,state}=harness();
 assert.deepEqual([...document.querySelectorAll('[data-section]')].map(b=>b.textContent),['Overview','Questions','Opportunities','Evidence','Settings']);
 for(const [view,section] of Object.entries({overview:'overview',questions:'questions',actions:'opportunities',assigned:'opportunities',answers:'evidence',connections:'settings',trends:'evidence',rivals:'evidence',sources:'evidence',pages:'evidence',landscape:'evidence',traffic:'evidence',setup:'settings',billing:'settings'})){
  state.view=view;h.syncNavigation();
  assert.equal(document.querySelector('[data-section][aria-current="page"]').dataset.section,section);
  assert.equal(document.querySelector(`[data-view="${view}"]`).getAttribute('aria-current'),'page');
  assert.equal(document.getElementById('measurementDetails').hidden,section!=='evidence');
  assert.equal(document.querySelectorAll('[data-nav-group]:not([hidden])').length,['overview','questions'].includes(section)?0:1);
 }
});
test('existing shortcut clicks and primary navigation still render correct destinations',async()=>{
 const {h,document,state}=harness();h.render=async()=>h.syncNavigation();
 vm.runInContext(app.slice(app.indexOf("document.querySelectorAll('.tab[data-view]')"),app.indexOf("$('projectPicker').addEventListener")),h);
 document.querySelector('[data-section="opportunities"]').click();assert.equal(state.view,'actions');
 document.querySelector('.tab[data-view="billing"]').click();assert.equal(state.view,'billing');assert.equal(document.querySelector('[data-section="settings"]').getAttribute('aria-current'),'page');
 document.querySelector('[data-view="traffic"]').click();assert.equal(state.view,'traffic');assert.equal(document.querySelector('[data-section="evidence"]').getAttribute('aria-current'),'page');
 document.querySelector('[data-section="overview"]').click();assert.equal(state.view,'overview');
});
test('overview preserves measured zero, denominator, cost preview and one-cycle limitation',async()=>{
 const {h}=harness();const html=await h.viewOverview();
 assert.match(html,/Named in 0% of 10 successfully measured answers/);assert.match(html,/One measurement so far/);assert.match(html,/10 active questions · 10 answer checks/);assert.match(html,/No open tasks/);assert.doesNotMatch(html,/visibility (rose|fell)/);
});
test('unmeasured overview does not turn missing results into zero',async()=>{
 const {h,state}=harness();state.overview={project:{},cycle:null,visibility:0};const html=await h.viewOverview();
 assert.match(html,/Not measured/);assert.doesNotMatch(html,/Named in 0%/);assert.match(html,/connect Google Search Console/);
});
test('overview uses the existing task renderer and only the first three ranked tasks',async()=>{
 const seen=[];const {h}=harness({taskCard:t=>{seen.push(t.id);return `<article>${esc(t.title)}</article>`;},api:async path=>path.includes('recommendations')?{tasks:[1,2,3,4].map(id=>({id,title:'Task '+id})),people:[]}:null});
 const html=await h.viewOverview();assert.deepEqual(seen,[1,2,3]);assert.match(html,/All opportunities \(4\)/);assert.doesNotMatch(html,/Task 4/);
});
test('failed task request is not presented as no open work',async()=>{
 const {h}=harness({api:async()=>({error:'Unavailable'})});assert.match(await h.viewOverview(),/task list could not be loaded/);
});
test('paused and superseded questions are excluded from the waiting notice',()=>{
 const start=app.indexOf('const waiting = prompts.filter');const end=app.indexOf(';',start);
 for(const [prompts,expected] of [[[{active:false,measured:false}],0],[[{active:true,measured:false,replacedBy:2}],0],[[{active:true,measured:false}],1]]){
  const h=vm.createContext({prompts});assert.equal(vm.runInContext(app.slice(start,end+1)+'waiting',h),expected);
 }
});
test('a slow previous view cannot overwrite a later navigation',async()=>{
 let finish;const {h,state,document}=harness();
 for(const name of ['viewOverview','viewConnections','viewAnswerEvidence','viewActions','viewAssigned','viewPages','viewQuestions','viewRivals','viewSources','viewTraffic','viewSetup','viewBilling','viewTrends','viewLandscape'])h[name]=async()=>'<p>new view</p>';
 h.viewOverview=()=>new Promise(resolve=>finish=resolve);
 vm.runInContext(app.slice(app.indexOf('async function render()'),app.indexOf('async function loadProject(')),h);
 const old=h.render();state.view='trends';await h.render();finish('<p>stale view</p>');await old;
 assert.equal(document.getElementById('view').textContent,'new view');
});
test('answer evidence reuses stored-answer controls and excludes unmeasured questions',async()=>{
 const {h}=harness({api:async()=>[{id:1,text:'Measured <question>',measured:true},{id:2,text:'Unmeasured question',measured:false}]});
 const html=await h.viewAnswerEvidence();assert.match(html,/data-see-answer="1"/);assert.doesNotMatch(html,/data-see-answer="2"/);assert.match(html,/Measured &lt;question&gt;/);assert.match(html,/data-answers hidden/);
});
test('Settings keeps both Google connection entry points discoverable',async()=>{
 const {h}=harness();const html=await h.viewConnections();assert.match(html,/data-open-gsc/);assert.match(html,/data-open-view="traffic"/);assert.match(html,/different Google accounts/);
});
// Optional standalone preview, containing fixture data only and no production calls.
if(process.env.PREVIEW_PATH){
 const {h,document}=harness({api:async path=>path.includes('recommendations')?{tasks:[{id:1,title:'Review whether a cited source answers the buyer question'},{id:2,title:'Inspect the original answer before changing content'},{id:3,title:'Review questions that missed your brand'}],people:[]}:path.endsWith('/history')?{cycles:[{}]}:{all:10,checksAll:10,costAll:0.11}});
 document.querySelectorAll('script,link').forEach(e=>e.remove());document.getElementById('brandTitle').textContent='Cited';document.getElementById('view').innerHTML=await h.viewOverview();h.syncNavigation();
 const css=document.createElement('style');css.textContent=readFileSync(new URL('../src/public/styles.css',import.meta.url),'utf8');document.head.appendChild(css);
 writeFileSync(process.env.PREVIEW_PATH,'<!doctype html>'+document.documentElement.outerHTML);
}
