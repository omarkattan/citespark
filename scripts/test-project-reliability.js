import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE||'jsdom');
const src=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const index=readFileSync(new URL('../src/public/index.html',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
function harness(){
 const dom=new JSDOM(index,{url:'https://cited.ae/app?site=74'}),document=dom.window.document;
 const state={projectId:74,view:'questions',setupStep:'recommendations'};
 const noop=()=>{};
 dom.window.scrollTo=noop;
 const h=vm.createContext({window:dom.window,document,state,$:id=>document.getElementById(id),esc,clearTimeout,setTimeout,ga4RefreshPoll:null,
  syncNavigation:noop,setupJourney:()=>'',loadPersonas:async()=>{},applyQuestionView:noop,refreshBulkBar:noop,toast:noop,setupErr:noop,resumeActionPreparation:noop,qState:{}});
 for(const name of ['FirstMeasurement','ReportGuide','CompetitorReview','Overview','Connections','AnswerEvidence','Actions','Assigned','Pages','Questions','Rivals','SearchDemand','Sources','Traffic','Setup','Billing','Trends','Landscape'])h['view'+name]=async()=>'<p>New view</p>';
 vm.runInContext(src.slice(src.indexOf('async function render()'),src.indexOf('function showProjectLoadError(')),h);
 return {h,state,document,dom};
}
test('explicit Settings navigation stays in Settings throughout unfinished setup',()=>{
 const {h,state,document}=harness();h.render=async()=>{};
 vm.runInContext(src.slice(src.indexOf('const VIEW_SECTION'),src.indexOf('async function viewOverview()')),h);
 vm.runInContext(src.slice(src.indexOf("document.querySelectorAll('.tab[data-view]')"),src.indexOf("$('projectPicker').addEventListener")),h);
 document.querySelector('[data-section="settings"]').click();assert.equal(state.view,'setup');
 h.syncNavigation();assert.equal(document.querySelector('[data-section="settings"]').getAttribute('aria-current'),'page');
 assert.match(document.querySelector('main > .eyebrow').textContent,/Site settings/);
 document.querySelector('[data-view="billing"]').click();assert.equal(state.view,'billing');
});
test('refresh keeps edits made while waiting, import expansion and selections',async()=>{
 const {h,state,document}=harness();
 const html='<details id="questionAdd" open><input id="q_text"><select id="q_site_language"><option>en</option><option>ar</option></select><details open><textarea id="q_bulk_text"></textarea></details><div id="qTopicPanel"><input type="checkbox" data-topicq="0" checked><input type="checkbox" data-topicq="1"></div></details><input type="checkbox" data-qsel="7" checked>';
 const view=document.getElementById('view');view.innerHTML=html;view.dataset.renderedProject='74';view.dataset.renderedView='questions';
 let finish;h.viewQuestions=()=>new Promise(resolve=>finish=resolve);
 const pending=h.render();assert.ok(document.getElementById('q_text'));assert.equal(view.getAttribute('aria-busy'),'true');
 document.getElementById('q_text').value='A draft typed during the refresh';document.getElementById('q_site_language').value='ar';document.getElementById('q_bulk_text').value='من يقدم أفضل خدمات الإطارات؟';
 view.insertAdjacentHTML('beforeend','<div class="question-editor" id="question-edit-7"><textarea>Old wording</textarea></div>');
 document.querySelector('#question-edit-7 textarea').value='Unsaved revision';
 finish(html+'<div class="question-editor" id="question-edit-7" hidden></div>');await pending;
 assert.equal(document.getElementById('q_text').value,'A draft typed during the refresh');assert.equal(document.getElementById('q_site_language').value,'ar');
 assert.equal(document.getElementById('q_bulk_text').closest('details').open,true);assert.match(document.getElementById('q_bulk_text').value,/الإطارات/);
 assert.equal(document.querySelector('[data-topicq="1"]').checked,false);assert.equal(document.querySelector('[data-qsel="7"]').checked,true);assert.equal(view.hasAttribute('aria-busy'),false);
 assert.equal(document.querySelector('#question-edit-7').hidden,false);assert.equal(document.querySelector('#question-edit-7 textarea').value,'Unsaved revision');
 state.view='billing';await h.render();assert.doesNotMatch(view.textContent,/draft/);
});
test('failed refresh retains the current question draft',async()=>{
 const {h,document}=harness();const view=document.getElementById('view');view.innerHTML='<input id="q_text" value="Draft">';view.dataset.renderedProject='74';view.dataset.renderedView='questions';
 h.viewQuestions=async()=>{throw Error('Timeout');};await h.render();assert.equal(document.getElementById('q_text').value,'Draft');
});
test('a response for another project cannot overwrite the current view',async()=>{
 const {h,state,document}=harness();let finish;h.viewQuestions=()=>new Promise(resolve=>finish=resolve);
 const pending=h.render();state.projectId=75;state.view='billing';await h.render();finish('<p>Wrong project</p>');await pending;
 assert.equal(document.getElementById('view').textContent,'New view');
});
test('suggestions stay a preview until selected questions are explicitly added',async()=>{
 const {h,state,document}=harness();document.getElementById('view').innerHTML='<select id="q_site_language"><option value="ar">Arabic</option></select><button id="q_generate">Suggest discovery questions</button><div id="qTopicPanel"></div>';
 const calls=[];h.api=async(path,options)=>{calls.push({path,...options});return path.endsWith('generate-prompts')?{questions:[{text:'من يقدم أفضل خدمات الإطارات في دبي؟'},{text:'أين أشتري إطارات جديدة في دبي؟',duplicate:true}]}:{added:1};};
 h.render=async()=>{};
 vm.runInContext(src.slice(src.indexOf('function showQuestionPreview('),src.indexOf('function questionTools(')),h);
 const start=src.indexOf("  if (['q_topic','q_generate','q_bulk_preview'].includes(t.id))"),end=src.indexOf("  if (t.dataset.delPrompt)",start);
 h.t=document.getElementById('q_generate');await vm.runInContext(`(async()=>{${src.slice(start,end)}})()`,h);
 assert.equal(calls.length,1);assert.equal(calls[0].body.language,'ar');assert.equal(calls[0].body.count,20);
 assert.match(document.getElementById('qTopicPanel').textContent,/Nothing has been added or measured/);assert.equal(document.querySelector('[data-topicq="1"]').disabled,true);
 h.t=document.getElementById('q_topic_add');await vm.runInContext(`(async()=>{${src.slice(start,end)}})()`,h);
 assert.equal(calls.length,2);assert.match(calls[1].path,/prompts\/import$/);assert.equal(calls[1].body.items.length,1);assert.equal(state.questionPreview,null);
});
test('background completion on an old project does not refresh or show a report on the new one',async()=>{
 const {h,state}=harness();let finish;h.api=()=>new Promise(resolve=>finish=resolve);h.loadProject=()=>assert.fail('stale project refresh');h.showReport=()=>assert.fail('stale report');
 const a=src.indexOf('async function pollCycle()');vm.runInContext(src.slice(a,src.indexOf('\n/**',a)),h);
 const pending=h.pollCycle();state.projectId=75;finish({phase:'done',summary:{}});assert.equal(await pending,true);
});
