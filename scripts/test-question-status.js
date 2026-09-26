import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slice=(a,b)=>app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));
function harness(){
 const document=new JSDOM('<main id="view"></main>').window.document;
 const h=vm.createContext({document,esc,$:id=>document.getElementById(id),state:{projectId:26},helpDot:()=>''});
 vm.runInContext(slice('function gscQuestionPanel(', 'async function viewQuestions('),h);
 vm.runInContext(slice('function importRoom(', 'function gscCandidateRow('),h);
 vm.runInContext(slice('const qState =','document.addEventListener'),h);
 return {h,document};
}
for(const [name,status,expected] of [
 ['connected property',{connected:true,siteUrl:'https://sandstormdigital.com/',email:'test@example.com'},'https://sandstormdigital.com/'],
 ['connected without property',{connected:true},'choose a property'],
 ['disconnected',{connected:false},'connect an account'],
 ['unavailable',{error:true},'status unavailable']
])test(`GSC header: ${name}`,()=>{
 const {h,document}=harness();document.body.innerHTML=h.gscQuestionPanel(status);
 assert.ok(document.querySelector('summary').textContent.includes(expected));
 assert.equal(!!document.getElementById('gscSwitch'),!!status.siteUrl);
 if(status.connected)assert.doesNotMatch(document.querySelector('summary').textContent,/connect an account/);
});
test('property and account strings remain escaped',()=>{
 const {h,document}=harness();document.body.innerHTML=h.gscQuestionPanel({siteUrl:'<img src=x>',email:'<script>x</script>'});
 assert.equal(document.querySelectorAll('img,script').length,0);
});
test('internal unlimited, finite plans, full plans and unknown limits',()=>{
 const {h}=harness();assert.equal(h.importRoom({limit:{questions:Number.MAX_SAFE_INTEGER,active:20}}),'Unlimited active questions on this plan.');
 assert.match(h.importRoom({limit:{questions:25,active:20}}),/Room for 5 more.*25/);
 assert.match(h.importRoom({limit:{questions:10,active:10}}),/at its limit/);
 assert.equal(h.importRoom({}), '');
});
function questions(){
 const x=harness();const {document,h}=x;
 document.body.innerHTML=['all','invisible','weak','strong','unrun'].map(k=>`<button data-group="state" data-value="${k}"></button>`).join('')+'<span id="promptFilterCount"></span><div id="promptList"><p data-filter-empty hidden>No match</p></div>';
 for(const [id,active,source,state,cluster] of [[1,true,'generated','invisible','seo'],[2,false,'gsc','unrun','ppc'],[3,true,'gsc','unrun','seo'],[4,true,'gsc','strong','ppc']]){
  const r=document.createElement('div');r.className='prompt';Object.assign(r.dataset,{prompt:id,active,source,state,cluster,intent:'commercial',persona:'',filterText:cluster,title:cluster,rate:state==='unrun'?-1:state==='invisible'?0:1,volume:1});document.getElementById('promptList').append(r);
 }
 x.set=values=>{h.values=values;vm.runInContext('Object.assign(qState,values);applyQuestionView()',h);};
 x.count=k=>document.querySelector(`[data-value="${k}"]`).textContent;
 x.visible=()=>[...document.querySelectorAll('.prompt:not([hidden])')].map(r=>r.dataset.prompt);
 return x;
}
test('active counts exclude paused questions and preserve measured zero vs unmeasured',()=>{
 const x=questions();x.set({});assert.equal(x.count('all'),'All 3');assert.equal(x.count('unrun'),'Not asked yet 1');assert.equal(x.count('invisible'),'Never named 1');assert.deepEqual(x.visible().sort(),['1','3','4']);
});
test('counts combine origin, status, topic and search without narrowing to the selected state',()=>{
 const x=questions();x.set({origin:'gsc',state:'unrun'});assert.equal(x.count('all'),'All 2');assert.equal(x.count('strong'),'Named often 1');assert.deepEqual(x.visible(),['3']);
 x.set({activity:'paused'});assert.equal(x.count('all'),'All 1');assert.deepEqual(x.visible(),['2']);
 x.set({activity:'all',cluster:'seo',text:'ppc'});assert.equal(x.count('all'),'All 0');assert.deepEqual(x.visible(),[]);
 assert.equal(x.document.querySelector('[data-value="unrun"]').hidden,false);assert.equal(x.document.querySelector('[data-value="unrun"]').getAttribute('aria-pressed'),'true');
});
test('clearer count denominator and selected state survive rerender',()=>{
 const x=questions();x.set({origin:'gsc',state:'strong'});assert.equal(x.document.getElementById('promptFilterCount').textContent,'1 shown · 2 match filters · 4 total including history');
 assert.ok(x.document.querySelector('[data-value="strong"]').classList.contains('is-on'));
});
test('changing property lists choices without disconnecting either account',async()=>{
 const {h}=harness();let listed=0;h.e={target:{id:'gscSwitch',disabled:false}};h.loadGscSites=async()=>listed++;h.api=()=>{throw Error('Must not disconnect');};
 await vm.runInContext('(async()=>{'+slice("  if (e.target.id === 'gscSwitch')", "  if (e.target.id === 'gscDisconnect')")+'})()',h);
 assert.equal(listed,1);assert.equal(h.e.target.disabled,false);
});
test('Search Console disconnect requests only gsc, preserving Analytics',async()=>{
 const {h}=harness();let what;h.e={target:{id:'gscDisconnect'}};h.confirm=()=>true;h.api=async(_,options)=>what=options.body.what;h.render=async()=>{};
 await vm.runInContext('(async()=>{'+slice("  if (e.target.id === 'gscDisconnect')", "  if (e.target.id === 'ga4Disconnect')")+'})()',h);assert.equal(what,'gsc');
});
for(const success of [true,false])test(`property save ${success?'refreshes header':'shows error without loading candidates'}`,async()=>{
 const {h,document}=harness();document.body.innerHTML=h.gscQuestionPanel({connected:true});
 const site=document.createElement('button');site.dataset.gscSite='https://sandstormdigital.com/';document.getElementById('gscBody').append(site);h.e={target:site};
 h.fetch=async()=>({ok:success,json:async()=>success?{ok:true}:{error:'Save failed'}});h.api=async()=>({connected:true,siteUrl:site.dataset.gscSite});let loaded=0;h.loadGscCandidates=async()=>loaded++;
 await vm.runInContext('(async()=>{'+slice("  const site = e.target.closest('[data-gsc-site]');", "  if (e.target.id === 'gscNone')")+'})()',h);
 assert.equal(loaded,success?1:0);assert.equal(site.disabled,false);
 if(success){assert.match(document.querySelector('summary').textContent,/sandstormdigital/);assert.equal(document.getElementById('gscPanel').open,true);}else assert.match(document.querySelector('[role="alert"]').textContent,/Save failed/);
});

test('typing a search keeps origin and activity filters instead of a second handler overriding them',()=>{
 const x=questions();const {h,document}=x;
 document.body.insertAdjacentHTML('beforeend','<input id="promptFilter">');
 vm.runInContext(slice('function filterRows(', 'function searchBox('),h);
 vm.runInContext(slice("document.addEventListener('input', (e) => {\n  if (e.target.id !== 'promptFilter')", '/*'),h);
 vm.runInContext(slice('const FILTERS =', '/**'),h);
 x.set({origin:'gsc'});
 const input=document.getElementById('promptFilter');input.value='ppc';input.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));
 assert.deepEqual(x.visible(),['4']);assert.equal(x.count('all'),'All 1');
 assert.equal(document.getElementById('promptFilterCount').textContent,'1 shown · 1 match filters · 4 total including history');
});
