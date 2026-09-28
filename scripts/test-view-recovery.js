import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const src=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const apiCode=src.slice(src.indexOf('async function api('),src.indexOf('\n/**',src.indexOf('async function api(')));
function context(fetch){return vm.createContext({fetch,AbortController,setTimeout,clearTimeout,FormData,window:{location:{}}});}
test('a stalled GET settles at its deadline and aborts the request',async()=>{
 let signal;const h=context(async(p,o)=>{signal=o.signal;return new Promise(()=>{});});vm.runInContext(apiCode,h);
 await assert.rejects(h.api('/read',{readTimeoutMs:15}),/too long/);assert.equal(signal.aborted,true);
});
test('deadline also covers a response whose body never completes',async()=>{
 const h=context(async()=>({status:200,json:()=>new Promise(()=>{})}));vm.runInContext(apiCode,h);await assert.rejects(h.api('/read',{readTimeoutMs:15}),/too long/);
});
test('mutations are not timed out or retried and body settings stay intact',async()=>{
 let calls=0,options;const h=context(async(p,o)=>{calls++;options=o;await new Promise(r=>setTimeout(r,20));return {status:200,json:async()=>({ok:true})};});vm.runInContext(apiCode,h);
 const result=await h.api('/write',{method:'POST',body:{x:1},readTimeoutMs:1});assert.equal(result.ok,true);assert.equal(calls,1);assert.equal(options.signal,undefined);assert.equal(options.body,'{"x":1}');assert.equal('readTimeoutMs' in options,false);
});
test('view failure displays retry and an outdated view cannot replace a newer one',async()=>{
 const document=new JSDOM('<main id="view"></main>').window.document;
 const state={view:'overview'};const noop=()=>{};
 const h=vm.createContext({document,state,$:id=>document.getElementById(id),syncNavigation:noop,viewOverview:async()=>{throw Error('Failed');}});
 for(const name of ['viewConnections','viewAnswerEvidence','viewActions','viewAssigned','viewPages','viewQuestions','viewRivals','viewSources','viewTraffic','viewSetup','viewBilling','viewTrends','viewLandscape'])h[name]=noop;
 vm.runInContext(src.slice(src.indexOf('async function render()'),src.indexOf('async function loadProject(')),h);
 await h.render();assert.match(document.body.textContent,/This view could not be loaded/);assert.ok(document.querySelector('[data-retry-view]'));
 let reject;h.viewOverview=()=>new Promise((_,r)=>reject=r);const pending=h.render();state.renderId++;document.getElementById('view').textContent='New view';reject(Error('Old failure'));await pending;assert.equal(document.body.textContent,'New view');
});
