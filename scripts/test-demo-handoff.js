import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE||'jsdom');
test('handoff survives navigation in browser storage, expires, and handles unavailable storage',()=>{
 const w=new JSDOM('',{url:'https://cited.ae',runScripts:'outside-only'}).window;
 const source=readFileSync(new URL('../src/public/demo-handoff.js',import.meta.url),'utf8');w.eval(source);
 assert.equal(w.CitedDemoHandoff.save({domain:'example.com',brandName:'Example'},[{question:'Which?',runs:3,mentions:0}]),true);
 w.eval(source);assert.equal(w.CitedDemoHandoff.read().results[0].mentions,0);
 const key='cited.demo.handoff.v1',d=JSON.parse(w.localStorage.getItem(key));d.savedAt-=25*60*60*1000;w.localStorage.setItem(key,JSON.stringify(d));assert.equal(w.CitedDemoHandoff.read(),null);
 w.localStorage.setItem(key,'invalid');assert.equal(w.CitedDemoHandoff.read(),null);
 Object.defineProperty(w,'localStorage',{get(){throw Error('Disabled')}});assert.equal(w.CitedDemoHandoff.save({domain:'example.com'},[]),false);assert.equal(w.CitedDemoHandoff.read(),null);
});
test('internal bypass still enforces shared spend cap and normal users keep allowances',async()=>{
 const source=readFileSync(new URL('../src/lib/demo.js',import.meta.url),'utf8');const fn=source.slice(source.indexOf('export async function checkLimits'),source.indexOf('/* ---------------- step one')).replace('export ','');
 let answers=[],calls=0;const c=vm.createContext({DEMO_DAILY_BUDGET:15,DEMO_PER_IP_DAY:3,DEMO_PER_IP_HOUR:2,one:async()=>{calls++;return answers.shift()}});vm.runInContext(fn,c);
 answers=[{total:15}];assert.equal((await c.checkLimits('ip',{internal:true})).ok,false);
 calls=0;answers=[{total:1}];assert.equal((await c.checkLimits('ip',{internal:true})).remaining,null);assert.equal(calls,1);
 answers=[{total:1},{n:1},{n:2}];assert.equal((await c.checkLimits('ip')).ok,false);
});
test('only matching authenticated user and organisation can qualify for internal testing',async()=>{
 const source=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');const fn=source.slice(source.indexOf('async function demoInternal'),source.indexOf("app.get('/api/demo/config'"));let params;let response={internal:false};
 const c=vm.createContext({one:async(sql,p)=>{assert.match(sql,/u.id=\$1 AND o.id=\$2/);params=p;return response;}});vm.runInContext(fn,c);
 assert.equal(await c.demoInternal({body:{internal:true}}),false);
 assert.equal(await c.demoInternal({session:{userId:1,orgId:2},body:{internal:true}}),false);
 response={internal:true};assert.equal(await c.demoInternal({session:{userId:1,orgId:2}}),true);assert.equal(params.join(','),'1,2');
});
test('app setup uses demo hints only on click and keeps notes separate from reports',()=>{
 const w=new JSDOM('<main></main><button id="addSiteBtn"></button><input id="f_domain"><input id="f_brand"><input id="f_category"><input id="f_qualifier"><input id="f_aliases"><input id="f_rivals"><select id="f_market"></select><select id="f_city"></select><p id="f_cityHint"></p><p id="f_scanned"></p><p id="siteError"></p>',{url:'https://cited.ae/app',runScripts:'outside-only'}).window;
 w.eval(readFileSync(new URL('../src/public/demo-handoff.js',import.meta.url),'utf8'));
 w.CitedDemoHandoff.save({domain:'example.com',brandName:'<img src=x>',market:'GB'},[{question:'Which agency should I choose?',runs:3,mentions:0}]);
 w.countryOptions=()=>'<option>GB</option>';w.DEFAULT_COUNTRY='AE';w.fillCities=()=>{};
 w.eval("var state={};var $=id=>document.getElementById(id);var esc=s=>String(s??'').replaceAll('<','&lt;').replaceAll('>','&gt;');");
 const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');w.eval(app.slice(app.indexOf('function showDemoHandoff(){')));w.showDemoHandoff();
 assert.equal(w.document.querySelector('#f_domain').value,'');assert.match(w.document.body.textContent,/not included in reports/);
 w.document.querySelector('#demoUseSetup').click();assert.equal(w.document.querySelector('#f_domain').value,'example.com');assert.equal(w.document.querySelectorAll('img').length,0);assert.equal(w.document.querySelector('[data-demo-question]').value,'Which agency should I choose?');
 w.document.querySelector('#demoDiscard').click();assert.equal(w.CitedDemoHandoff.read(),null);
});
test('rescanning the same domain preserves results, another domain does not inherit them',()=>{
 const w=new JSDOM('',{url:'https://cited.ae',runScripts:'outside-only'}).window;
 w.eval(readFileSync(new URL('../src/public/demo-handoff.js',import.meta.url),'utf8'));
 const h=w.CitedDemoHandoff,q={question:'Which agency should I choose?',runs:3,mentions:2};
 h.save({domain:'example.com'},[q]);h.save({domain:'example.com'},[]);assert.equal(h.read().results.length,1);
 h.save({domain:'example.com'},[{...q,mentions:0}]);assert.equal(h.read().results.length,1);assert.equal(h.read().results[0].mentions,0);
 h.save({domain:'different.com'},[]);assert.equal(h.read().results.length,0);
});
