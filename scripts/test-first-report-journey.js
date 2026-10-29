import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {isBuyerQuestion,containsSearchBrand,queryKey} from '../src/lib/gsc-query-integrity.js';
import {evaluateRules} from '../src/lib/recommend.js';
import {reportPreparationHtml} from '../src/lib/report-preparation.js';
const {JSDOM}=await import(process.env.JSDOM_MODULE);
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const settle=()=>new Promise(r=>setImmediate(r));
function fixture(extra={}){
 const dom=new JSDOM('<div id="figures"></div><div id="view"></div><div id="brandTitle">SkinCycles</div><div id="brandDek"></div><div id="cycleMeta"></div><div id="verifyBar"></div><button id="runBtn"></button><input id="draft" value="Keep my draft">',{url:'https://cited.test/app?site=39'});
 const w=dom.window;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 const state={projectId:39,view:'connections',setupStep:'sources',emailVerified:true,overview:{project:{name:'SkinCycles',domain:'skincycles.com',brand_name:'SkinCycles',market:'GB',engines:['chatgpt']}}};
 const ctx=vm.createContext({window:w,document:w.document,state,esc,URL,URLSearchParams,setTimeout,clearTimeout,$:id=>w.document.getElementById(id),ENGINE_LABEL:{chatgpt:'ChatGPT'},COUNTRIES:[['GB','United Kingdom']],api:async()=>({}),toast:()=>{},render:async()=>{},...extra});
 vm.runInContext(app.slice(app.indexOf('const SETUP_VIEWS='),app.indexOf('async function viewSearchDemand()')),ctx);
 return {dom,w,ctx,state,close:()=>dom.window.close()};
}
test('optional sources has one next action and future result steps are disabled',async()=>{
 const f=fixture();f.w.document.getElementById('view').innerHTML=f.ctx.setupJourney()+await f.ctx.viewConnections();
 const main=f.w.document.querySelector('#view');assert.equal([...main.querySelectorAll('button')].filter(b=>b.textContent==='Continue to questions').length,1);assert.equal(main.querySelector('[data-setup-step=report]').disabled,true);assert.equal(main.querySelector('[data-setup-step=recommendations]').disabled,true);assert.match(main.textContent,/connect sources later/);f.close();
});
test('first measurement is a short review, and running state blocks duplicate launch',async()=>{
 const f=fixture({api:async()=>({all:10,checksAll:10,costAll:0.36})});f.state.view='firstMeasurement';f.state.setupStep='measurement';
 f.w.document.getElementById('view').innerHTML=f.ctx.setupJourney()+await f.ctx.viewFirstMeasurement();assert.match(f.w.document.body.textContent,/United Kingdom/);assert.match(f.w.document.body.textContent,/ChatGPT/);assert.doesNotMatch(f.w.document.body.textContent,/Remove this site|Competitors/);assert.equal(f.w.document.querySelectorAll('[data-start-first-cycle]').length,1);
 f.state.measurementRunning=true;assert.doesNotMatch(f.ctx.setupJourney(),/data-start-first-cycle/);assert.match(f.ctx.setupJourney(),/Measurement in progress/);f.close();
});
test('results keep the guide at recommendations, legacy measured projects stay complete, saved report resumes',async()=>{
 const f=fixture({refreshRunScope:()=>{},renderFigures:async()=>{},shortDate:()=>'',api:async path=>path.endsWith('/overview')?{cycle:'2026-10-29',runs:10,project:{name:'SkinCycles',brand_name:'SkinCycles'}}:{step:f.savedStep}});
 vm.runInContext(app.slice(app.indexOf('async function loadProject(id)'),app.indexOf('async function loadProjectList(')),f.ctx);
 f.savedStep='measurement';f.state.view='firstMeasurement';await f.ctx.loadProject(39);assert.equal(f.state.setupStep,'recommendations');assert.equal(f.state.view,'actions');assert.match(f.ctx.setupJourney(),/Next: prepare your report/);
 f.savedStep='report';f.state.projectId=null;await f.ctx.loadProject(39);assert.equal(f.state.view,'reportGuide');
 f.savedStep=null;f.state.projectId=null;await f.ctx.loadProject(39);assert.equal(f.state.setupStep,'complete');assert.equal(f.ctx.setupJourney(),'');f.close();
});
test('step failures keep the current screen and do not falsely report saved progress',async()=>{
 const f=fixture({api:async()=>({error:'Save unavailable'})});f.w.document.getElementById('view').innerHTML=f.ctx.setupJourney();f.w.document.querySelector('[data-setup-step=questions]').click();await settle();assert.equal(f.state.setupStep,'sources');assert.equal(f.state.view,'connections');assert.match(f.w.document.getElementById('setupProgressError').textContent,/Save unavailable/);f.close();
});
test('email confirmation refresh preserves unsaved fields and rejects a different session user',async()=>{
 let me={signedIn:true,userId:7,emailVerified:true};const f=fixture({api:async()=>me});f.state.emailVerified=false;f.state.userId=7;
 vm.runInContext(app.slice(app.indexOf('function showVerifyBar(me)'),app.indexOf('async function refreshUsagePill()')),f.ctx);
 assert.equal(await f.ctx.refreshVerification(),true);assert.equal(f.w.document.getElementById('verifyBar').hidden,true);assert.equal(f.w.document.getElementById('draft').value,'Keep my draft');
 f.state.emailVerified=false;me={...me,userId:8};assert.equal(await f.ctx.refreshVerification(),false);assert.equal(f.state.emailVerified,false);f.close();
});
test('first run confirms once, mixed runs retain the unrun option, cancel makes no paid request',async()=>{
 let unrun=10,starts=0;const f=fixture({refreshVerification:async()=>true,startCycle:async()=>{starts++;},api:async()=>({all:10,unrun,checksAll:10,checksUnrun:unrun,costAll:.36,costUnrun:.36})});
 vm.runInContext(app.slice(app.indexOf('async function reviewProjectRun()'),app.indexOf('async function startCycle(')),f.ctx);
 await f.ctx.reviewProjectRun();assert.equal(f.w.document.querySelectorAll('[data-run-confirm]').length,1);f.w.document.querySelector('[data-run-cancel]').click();assert.equal(starts,0);
 unrun=3;await f.ctx.reviewProjectRun();assert.equal(f.w.document.querySelectorAll('[data-run-confirm]').length,2);f.w.document.querySelector('[data-run-confirm=unrun]').click();await settle();assert.equal(starts,1);f.close();
});
test('one valid missed answer creates a preliminary review, zero answers do not',()=>{
 const row={prompt_id:1,text:'Which skincare products suit dry skin?',cluster:'dry skin',ai_search_volume:null,engine:'chatgpt',kind:'owned',runs:1,hits:0,negatives:0,sample_run:99};
 const reviews=evaluateRules({project:{domain:'skincycles.com'},stats:[row]});assert.equal(reviews.length,1);assert.equal(reviews[0].evidence.preliminary,true);assert.equal(reviews[0].evidence.run_id,99);assert.match(reviews[0].action,/not a reliable absence rate/);assert.doesNotMatch(reviews[0].title,/Invisible/);
 assert.equal(evaluateRules({project:{domain:'skincycles.com'},stats:[{...row,runs:0}]}).length,0);
});
test('site suggestion generation rejects keyword fragments, duplicates and prompted brand recall',async()=>{
 const source=readFileSync(new URL('../src/lib/prompts.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
 const output=['Best skincare for dry skin','How to treat pigmentation?','How can I choose skincare for dry skin?','How can I choose skincare for dry skin?','Is SkinCycles best for dry skin?'];
 const ctx=vm.createContext({isBuyerQuestion,containsSearchBrand,queryKey,complete:async()=>output,parseJsonArray:()=>output.map(text=>({text}))});vm.runInContext(source,ctx);
 const result=await ctx.generatePrompts({brand:'SkinCycles',domain:'skincycles.com',category:'skincare',count:10});assert.deepEqual(Array.from(result,x=>x.text),['How can I choose skincare for dry skin?']);
});
test('report preparation has ordered delivery steps and actionable empty recommendations',()=>{
 const dom=new JSDOM(reportPreparationHtml({id:39,name:'SkinCycles'},[],{state:'disconnected'},{connected:false,questions:[]}));const d=dom.window.document;
 assert.deepEqual([...d.querySelectorAll('main > section > h2')].map(h=>h.textContent),['1. Choose recommendations to include','2. Preview your report','3. Save and download']);
 assert.ok(d.querySelector('#report-decisions a[href="/app?site=39&view=actions"]'));assert.ok(d.querySelector('[data-analysis-check]').closest('details'));assert.ok(d.querySelector('[aria-label="Analytics report coverage"]').closest('details'));assert.match(d.body.textContent,/Print \/ save PDF/);dom.window.close();
});
for(const [measured,step,expected] of [[false,'measurement','Ready for your first measurement'],[true,'measurement','No evidence reviews yet'],[true,'report','Prepare a report you can share']])test(`complete app resumes ${step} with measured=${measured}`,async()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/public/index.html',import.meta.url),'utf8'),{url:'https://cited.test/app?site=39',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window,requests=[];
 w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
 const project={id:39,name:'SkinCycles',brand_name:'SkinCycles',domain:'skincycles.com',market:'GB',engines:['chatgpt']};
 w.fetch=async(path,options={})=>{requests.push([path,options.method||'GET']);let data;
 if(path==='/api/me')data={signedIn:true,userId:7,emailVerified:true,productTourStatus:'completed'};
 else if(path==='/api/projects')data=[project];
 else if(path==='/api/billing')data=null;
 else if(path.endsWith('/overview'))data={project,cycle:measured?'2026-10-29':null,runs:measured?10:0,engines:[]};
 else if(path.endsWith('/setup-progress'))data={step};
 else if(path.endsWith('/run-scope'))data={all:10,unrun:measured?0:10,checksAll:10,checksUnrun:10,costAll:.36,costUnrun:.36};
 else if(path.endsWith('/cycle-status'))data={phase:'idle'};
 else if(path.includes('/recommendations?'))data={tasks:[],counts:{open:0,doing:0,done:0,dismissed:0,total:0},people:[]};
 else throw new Error('Unexpected request: '+path);
 return {ok:true,status:200,json:async()=>data};};
 w.eval(readFileSync(new URL('../src/public/countries.js',import.meta.url),'utf8'));w.eval(app);
 for(let i=0;i<20&&!w.document.getElementById('view').textContent.includes(expected);i++)await settle();
 assert.match(w.document.getElementById('view').textContent,new RegExp(expected));assert.ok(w.document.querySelector('.setup-journey'));assert.ok(requests.every(([,method])=>method==='GET'));dom.window.close();
});
test('one-check question opens its task and decision save leads directly to a confirmed report preview',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/public/index.html',import.meta.url),'utf8'),{url:'https://cited.test/app?site=39',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window,requests=[];
 w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
 const project={id:39,name:'SkinCycles',brand_name:'SkinCycles',domain:'skincycles.com',market:'GB',engines:['chatgpt']};
 const task={id:99,type:'content_gap',status:'open',title:'Review first answer',evidence:{prompt_id:1,prompt:'How much should skincare cost?',runs:1,own_rate:0,preliminary:true},review_decision:{}};
 w.fetch=async(path,options={})=>{requests.push([path,options.method||'GET']);let data;
 if(path==='/api/me')data={signedIn:true,userId:7,emailVerified:true};else if(path==='/api/projects')data=[project];else if(path==='/api/billing')data=null;
 else if(path.endsWith('/overview'))data={project,cycle:'2026-10-29',runs:1,engines:[]};else if(path.endsWith('/setup-progress'))data={step:'recommendations'};
 else if(path.endsWith('/run-scope'))data={all:1,unrun:0,checksAll:1,checksUnrun:0,costAll:.03,costUnrun:0};else if(path.endsWith('/cycle-status'))data={phase:'idle'};
 else if(path.includes('/recommendations?'))data={tasks:[task],counts:{open:1,doing:0,done:0,dismissed:0,total:1},people:[]};
 else if(path.endsWith('/review-decision'))data={...JSON.parse(options.body),reviewed_at:'2026-10-29'};
 else if(path.endsWith('/report-note-preview'))data={current:null,proposed:{title:'Investigate pricing',notes:'Check the existing page first'},canInclude:true,version:'v1'};
 else throw new Error('Unexpected request: '+path);
 return {ok:true,status:200,json:async()=>data};};
 w.eval(readFileSync(new URL('../src/public/countries.js',import.meta.url),'utf8'));w.eval(app);
 for(let i=0;i<20&&!w.document.querySelector('[data-task="99"]');i++)await settle();
 const card=w.document.querySelector('[data-task="99"]');assert.ok(card);assert.equal(card.querySelector('details.queue-task').open,true);
 // Exercise the same decision CTA used after an answer is read, without fabricating an answer response.
 const cta=w.document.createElement('button');cta.dataset.decisionOpen='99';card.append(cta);cta.click();assert.equal(card.querySelector('.task-decision > details').open,true);assert.equal(w.document.activeElement.id,'decision-stage-99');
 w.document.getElementById('decision-title-99').value='Investigate pricing';w.document.getElementById('decision-change-99').value='Check the existing page first';card.querySelector('[data-decision-save]').click();
 for(let i=0;i<20&&!card.querySelector('[data-decision-feedback] [data-report-preview]');i++)await settle();
 const next=card.querySelector('[data-decision-feedback] [data-report-preview]');assert.ok(next);next.click();
 for(let i=0;i<20&&!card.querySelector('[data-report-note]');i++)await settle();
 assert.equal(card.querySelector('[data-report-preview-panel]').hidden,false);assert.equal(card.querySelector('[data-report-note]').textContent,'Include in client report');assert.ok(!requests.some(([path,method])=>path.endsWith('/report-note')&&method==='POST'));dom.window.close();
});

test('failed overview reads give an actionable retry instead of a permanent Loading screen',async()=>{
 let reads=0;const f=fixture({refreshRunScope:()=>{},renderFigures:async()=>{},shortDate:()=>'',api:async path=>path.endsWith('/overview')?(++reads===1?{error:'Temporarily unavailable <img src=x>'}:{cycle:'2026-10-29',runs:10,project:{name:'SkinCycles',brand_name:'SkinCycles'}}):{step:'report'}});
 vm.runInContext(app.slice(app.indexOf('function showProjectLoadError('),app.indexOf('async function loadProjectList(')),f.ctx);
 await f.ctx.loadProject(39);assert.match(f.w.document.getElementById('brandTitle').textContent,/could not be loaded/);assert.ok(f.w.document.querySelector('[data-retry-project]'));assert.equal(f.w.document.querySelector('img'),null);
 f.w.document.querySelector('[data-retry-project]').click();await settle();assert.equal(reads,2);assert.equal(f.w.document.getElementById('brandTitle').textContent,'SkinCycles');assert.equal(f.state.view,'reportGuide');f.close();
});
