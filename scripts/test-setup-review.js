import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const index=readFileSync(new URL('../src/public/index.html',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness(api=async()=>({all:20,unrun:2,checksAll:120,checksUnrun:12,costAll:1.67,costUnrun:0.17})){
 const dom=new JSDOM(index);const document=dom.window.document;
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 const calls=[];const state={projectId:26};document.getElementById('brandTitle').textContent='Sandstorm';document.getElementById('runBtn').disabled=false;
 const h=vm.createContext({document,state,esc,$:id=>document.getElementById(id),api,startCycle:async only=>calls.push({id:state.projectId,only})});
 vm.runInContext(app.slice(app.indexOf('async function reviewProjectRun()'),app.indexOf('async function startCycle(')),h);
 return {h,document,calls,state,dom};
}
test('setup retains all field IDs and keeps advanced options collapsed',()=>{
 const {document}=harness();assert.equal(document.getElementById('siteOptional').open,false);
 for(const id of ['f_aliases','f_city','f_rivals'])assert.ok(document.getElementById('siteOptional').contains(document.getElementById(id)));
 for(const id of ['f_domain','f_brand','f_category','f_qualifier','f_market'])assert.equal(document.getElementById('siteOptional').contains(document.getElementById(id)),false);
});
test('review displays site and estimates without starting a run or offering all sites',async()=>{
 const {h,document,calls}=harness();await h.reviewProjectRun();const dialog=document.getElementById('projectRunReview');assert.ok(dialog.open);assert.match(dialog.textContent,/Sandstorm/);assert.match(dialog.textContent,/120 answer checks · estimated \$1.67/);assert.equal(calls.length,0);assert.doesNotMatch(dialog.textContent,/Run every site/);
 dialog.querySelector('[data-run-cancel]').click();assert.equal(document.getElementById('projectRunReview'),null);
});
test('explicit confirmation chooses the correct selected-site scope',async()=>{
 for(const [scope,expected] of [['all',null],['unrun','unrun']]){const {h,document,calls}=harness();await h.reviewProjectRun();document.querySelector(`[data-run-confirm="${scope}"]`).click();assert.deepEqual(calls,[{id:26,only:expected}]);assert.equal(document.getElementById('projectRunReview'),null);}
});
test('missing cost or a request failure cannot launch a measurement',async()=>{
 for(const result of [{all:20},{error:'Unavailable'}]){const {h,document,calls}=harness(async()=>result);await h.reviewProjectRun();assert.equal(document.querySelectorAll('[data-run-confirm]').length,0);assert.ok(document.querySelector('#projectRunReview [role="alert"]'));assert.equal(calls.length,0);}
});
test('project changes and already-running checks block launch',async()=>{
 for(const change of ['project','running']){const {h,document,calls,state}=harness();await h.reviewProjectRun();if(change==='project')state.projectId=25;else document.getElementById('runBtn').disabled=true;document.querySelector('[data-run-confirm]').click();assert.equal(calls.length,0);assert.ok(document.querySelector('[data-run-error]').textContent);}
});
test('empty scope disables both launch choices',async()=>{
 const {h,document}=harness(async()=>({all:0,unrun:0,checksAll:0,checksUnrun:0,costAll:0,costUnrun:0}));await h.reviewProjectRun();for(const b of document.querySelectorAll('[data-run-confirm]'))assert.equal(b.disabled,true);
});
test('late scope responses cannot reopen a cancelled review',async()=>{
 let resolve;const {h,document,calls}=harness(()=>new Promise(r=>resolve=r));const pending=h.reviewProjectRun();document.querySelector('[data-run-cancel]').click();resolve({all:20});await pending;assert.equal(document.getElementById('projectRunReview'),null);assert.equal(calls.length,0);
});
test('latest country request wins when city responses arrive out of order',async()=>{
 const {document}=harness();const pending={};const h=vm.createContext({esc,cityCache:new Map(),api:url=>new Promise(resolve=>pending[url]=resolve)});
 const start=app.indexOf('async function fillCities(');const end=app.indexOf('\n}',start)+2;vm.runInContext(app.slice(start,end),h);
 const select=document.getElementById('f_city');const first=h.fillCities('AE',select,null);const second=h.fillCities('GB',select,null);
 pending['/api/locations/GB']({cities:[{type:'City',name:'London',label:'London'}]});await second;
 pending['/api/locations/AE']({cities:[{type:'City',name:'Dubai',label:'Dubai'}]});await first;
 assert.match(select.textContent,/London/);assert.doesNotMatch(select.textContent,/Dubai/);
});
test('scan refreshes cities for the inferred country and clears stale competitor suggestions',async()=>{
 const {document,dom}=harness();const cities=[];document.getElementById('f_domain').value='example.com';document.getElementById('f_rivals').value='Old competitor';
 let complete;const done=new Promise(r=>complete=r);
 const h=vm.createContext({document,$:id=>document.getElementById(id),window:{DEFAULT_COUNTRY:'AE',countryOptions:country=>`<option value="${country}">${country}</option>`},fillCities:country=>cities.push(country),fetch:async()=>({ok:true,json:async()=>({domain:'example.com',brandName:'Example',market:'GB',competitors:[],confident:true})})});
 const btn=document.getElementById('f_scan');const add=btn.addEventListener.bind(btn);btn.addEventListener=(name,fn)=>add(name,async e=>{await fn(e);complete();});
 vm.runInContext(app.slice(app.indexOf("$('f_scan').addEventListener"),app.indexOf("$('siteCancel').addEventListener")),h);
 btn.click();await done;assert.deepEqual(cities,['GB']);assert.equal(document.getElementById('f_rivals').value,'');assert.equal(btn.disabled,false);
});
