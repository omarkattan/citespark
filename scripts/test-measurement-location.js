import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { measurementLocation, assertMeasurementLocation } from '../src/lib/measurement-location.js';
const { JSDOM } = await import(process.env.JSDOM_MODULE || 'jsdom');
const server = readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const app = readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const index = readFileSync(new URL('../src/public/index.html',import.meta.url),'utf8');
const jobs = readFileSync(new URL('../src/jobs/runCycle.js',import.meta.url),'utf8');
const project = {id:37,org_id:1,market:'HK',location_name:null,engines:['chatgpt','ai_mode','ai_overview']};
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

test('missing, whitespace and unsupported country locations cannot proceed', async()=>{
 for(const market of ['',null,'  ','HKG','HK']){
  const result=await measurementLocation({...project,market});assert.equal(result.ok,false);assert.equal(result.code,'MEASUREMENT_LOCATION_REQUIRED');
 }
});
test('configured country works without a city lookup; selected city must be verified',async()=>{
 const fail=async()=>{throw Error('must not call');};
 assert.equal((await measurementLocation({...project,market:'GB'},{lookup:fail})).locationName,'United Kingdom');
 const city='Verified city,HK'; const deps={lookup:async()=>[{name:city}]};
 assert.equal((await measurementLocation({...project,location_name:city},deps)).ok,true);
 assert.equal((await measurementLocation({...project,location_name:'London'},deps)).ok,false);
 for(const lookup of [async()=>[],async()=>{throw Error('outage');}]) assert.equal((await measurementLocation({...project,location_name:city},{lookup})).ok,false);
});
test('explicit assistant-only runs do not pretend to measure Google; setup still requires a supported location',async()=>{
 const assistants={...project,engines:['chatgpt']};assert.equal((await measurementLocation(assistants)).ok,true);
 assert.equal((await measurementLocation(assistants,{requireGoogle:true})).ok,false);
 await assert.rejects(assertMeasurementLocation(project),{code:'MEASUREMENT_LOCATION_REQUIRED'});
});
function route(method,path,deps={}){
 let handler;const context=vm.createContext({app:{[method]:(url,...handlers)=>{handler=handlers.at(-1);}},requireAuth:()=>{},wrap:x=>x,measurementLocation,...deps});
 const start=server.indexOf(`app.${method}('${path}'`);assert.ok(start>=0);const end=server.indexOf('\n}));',start)+5;vm.runInContext(server.slice(start,end),context);return handler;
}
function response(){return {statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};}
test('run and estimate APIs reject before budget checks or starting collection',async()=>{
 for(const [method,path] of [['post','/api/projects/:id/run'],['get','/api/projects/:id/run-scope']]){
  let paid=0;const res=response();const handler=route(method,path,{assertProject:async()=>project,one:async()=>{paid++;throw Error('read too far');},budgetForCycle:async()=>{paid++;},runCycleForProject:async()=>{paid++;}});
  await handler({body:{},session:{orgId:1}},res);assert.equal(res.statusCode,422);assert.equal(paid,0);assert.match(res.body.error,/not configured/);
 }
});
test('creation rejects before INSERT and question-generation spending',async()=>{
 let mutations=0;const res=response();const h=route('post','/api/projects',{one:async()=>null,checkCanAddSite:async()=>null,selectedDemoQuestions:()=>[],getEntitlements:async()=>({plan:{engines:6,questions:20}}),ENGINE_IDS:project.engines,query:async()=>{mutations++;},generatePrompts:async()=>{mutations++;}});
 await h({body:{domain:'forani.com',brandName:'Forani',market:'HK'},session:{orgId:1}},res);assert.equal(res.statusCode,422);assert.equal(mutations,0);
});
test('setup progression and engine enablement reject invalid location before mutation',async()=>{
 let writes=0;const deps={assertProject:async()=>project,query:async()=>{writes++;},ENGINE_IDS:project.engines,getEntitlements:async()=>({plan:{engines:6}})};
 for(const step of ['sources','questions','measurement','complete']) {const r=response();await route('post','/api/projects/:id/setup-progress',deps)({body:{step}},r);assert.equal(r.statusCode,422);}
 const r=response();await route('patch','/api/projects/:id',deps)({body:{engines:['ai_mode']},session:{orgId:1}},r);assert.equal(r.statusCode,422);assert.equal(writes,0);
});
test('changing country clears old city; invalid new market cannot be saved',async()=>{
 let values;const h=route('patch','/api/projects/:id',{assertProject:async()=>({...project,market:'GB',location_name:'London,England,United Kingdom'}),query:async(sql,v)=>{values=v;}});
 const res=response();await h({body:{market:'US'}},res);assert.equal(res.statusCode,200);assert.equal(values[6],'US');assert.equal(values[10],true);assert.equal(values[11],null);
 values=null;const bad=response();await h({body:{market:'HK'}},bad);assert.equal(bad.statusCode,422);assert.equal(values,null);
});
test('run-all skips invalid project before charging or scheduling',async()=>{
 let paid=0;const res=response();const h=route('post','/api/run-all',{many:async()=>[project],one:async sql=>sql.includes('COUNT')?{n:20}:project,cycles:new Map(),budgetForCycle:async()=>{paid++;},runCycleForProject:async()=>{paid++;}});
 await h({session:{orgId:1}},res);assert.equal(paid,0);assert.equal(res.body.started.length,0);assert.match(res.body.skipped[0].reason,/not configured/);
});
test('worker and retry reject before a measurement is created or any provider runs',async()=>{
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 for(const name of ['collectProject','collectRetry']){
  const start=jobs.indexOf(`async function ${name}(`);const end=jobs.indexOf('\n}',start)+2;const source=jobs.slice(start,end);let calls=0;
  const deps={one:async sql=>sql.includes('JOIN projects')?{id:1,project_id:37}:project,many:async()=>[],enginesFor:p=>p.engines,assertMeasurementLocation,startMeasurement:async()=>{calls++;},askEngine:async()=>{calls++;}};
  const execute=new AsyncFunction(...Object.keys(deps),`${source}; return ${name}(37,{},()=>{});`);
  await assert.rejects(execute(...Object.values(deps)),/not configured/);assert.equal(calls,0);
 }
});
function ui(api){
 const dom=new JSDOM(index);const document=dom.window.document;
 const h=vm.createContext({esc,api,cityCache:new Map()});const start=app.indexOf('function syncLocationChoice(');const end=app.indexOf('const ENGINE_LABEL',start);vm.runInContext(app.slice(start,end),h);
 return {h,document,dom,select:document.getElementById('f_city'),hint:document.getElementById('f_cityHint'),save:document.getElementById('siteSave')};
}
test('required location is visible and Continue stays disabled until supported',async()=>{
 let finish;const u=ui(()=>new Promise(r=>finish=r));const pending=u.h.fillCities('HK',u.select,u.hint);
 assert.equal(u.save.disabled,true);assert.equal(u.document.getElementById('siteOptional').contains(u.select),false);
 finish({country:'HK',countryLocation:null,cities:[]});await pending;assert.equal(u.save.disabled,true);assert.match(u.hint.textContent,/not configured/);assert.equal(u.select.querySelector('option').disabled,true);
});
test('verified country or explicit valid city enables Continue, while stale choice is preserved and blocked',async()=>{
 const u=ui(async()=>({countryLocation:'United Kingdom',cities:[{name:'London',label:'London',type:'City'}]}));
 await u.h.fillCities('GB',u.select,u.hint);assert.equal(u.save.disabled,false);
 await u.h.fillCities('GB',u.select,u.hint,'Old city');assert.equal(u.select.value,'Old city');assert.equal(u.save.disabled,true);
 u.select.value='London';u.select.dispatchEvent(new u.dom.window.Event('change'));assert.equal(u.save.disabled,false);
});
test('unconfigured country with verified city requires explicit selection',async()=>{
 const u=ui(async()=>({countryLocation:null,cities:[{name:'Verified HK place',label:'Verified HK place',type:'City'}]}));await u.h.fillCities('HK',u.select,u.hint);assert.equal(u.select.value,'');assert.equal(u.save.disabled,true);
 u.select.value='Verified HK place';u.select.dispatchEvent(new u.dom.window.Event('change'));assert.equal(u.save.disabled,false);
});
test('failed lookup is not cached and retry can recover; late response cannot override current country',async()=>{
 let n=0;const u=ui(async()=>++n===1?{unavailable:'down',countryLocation:null,cities:[]}:{countryLocation:'United Kingdom',cities:[]});
 await u.h.fillCities('HK',u.select,u.hint);assert.equal(u.save.disabled,true);await u.h.fillCities('HK',u.select,u.hint);assert.equal(n,2);assert.equal(u.save.disabled,false);
 const pending={};const v=ui(url=>new Promise(r=>pending[url]=r));const first=v.h.fillCities('GB',v.select,v.hint);const second=v.h.fillCities('HK',v.select,v.hint);
 pending['/api/locations/HK']({countryLocation:null,cities:[]});await second;pending['/api/locations/GB']({countryLocation:'United Kingdom',cities:[]});await first;assert.equal(v.save.disabled,true);assert.match(v.hint.textContent,/not configured/);
});
test('run review offers a location fix and no run button on blocked scope',async()=>{
 const dom=new JSDOM(index);const document=dom.window.document;dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 const h=vm.createContext({document,state:{projectId:37},esc,$:id=>document.getElementById(id),api:async()=>measurementLocation(project)});
 vm.runInContext(app.slice(app.indexOf('async function reviewProjectRun()'),app.indexOf('async function startCycle(')),h);await h.reviewProjectRun();assert.equal(document.querySelectorAll('[data-run-confirm]').length,0);assert.ok(document.querySelector('[data-fix-run-location]'));assert.match(document.querySelector('#projectRunReview [role="alert"]').textContent,/not configured/);
});
