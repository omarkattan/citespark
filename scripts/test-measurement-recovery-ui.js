import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {measurementHtml} from '../src/lib/measurement-archive.js';
const {JSDOM}=await import(process.env.JSDOM_MODULE||'jsdom');
const source=readFileSync(new URL('../src/public/measurement-recovery.js',import.meta.url),'utf8');
const page=()=>new JSDOM(measurementHtml({id:28,name:'Bank al Etihad'},{id:173,status:'failed',settings:{}},[]),{url:'https://cited.ae/api/projects/28/measurements/173',runScripts:'outside-only'});
test('recovery UI previews five unresolved checks before any paid request and retains original snapshot link',async()=>{
 const dom=page(),calls=[];try{
 dom.window.fetch=async(url,o={})=>{calls.push({url,...o});return {ok:true,json:async()=>o.method==='POST'?{started:true}:{retained:355,retry:5,replay:0,unresolved:5,estimatedCost:.15}};};
 dom.window.eval(source);assert.equal(calls.length,0);
 await dom.window.document.querySelector('[data-recovery]').onclick();assert.equal(calls.length,1);assert.equal(calls[0].method,undefined);
 const box=dom.window.document.querySelector('[data-recovery-status]');assert.match(box.textContent,/Keep 355 saved records/);assert.match(box.textContent,/request 5 checks/);
 await box.querySelector('button').onclick();assert.equal(calls.length,2);assert.equal(calls[1].method,'POST');assert.deepEqual(JSON.parse(calls[1].body),{confirmedRetry:5});assert.match(box.textContent,/Recovery started/);
 }finally{dom.window.close();}
});
test('unsupported recovery explains the problem without showing a started state',async()=>{
 const dom=page();try{dom.window.fetch=async()=>({ok:false,json:async()=>({error:'Original model is unavailable. A new baseline is required.'})});dom.window.eval(source);await dom.window.document.querySelector('[data-recovery]').onclick();
 assert.match(dom.window.document.querySelector('[data-recovery-status]').textContent,/Original model is unavailable/);assert.equal(dom.window.document.querySelector('[data-recovery-status] button'),null);
 }finally{dom.window.close();}
});
