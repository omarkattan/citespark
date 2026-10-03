import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reportPreparationHtml} from '../src/lib/report-preparation.js';
const script=readFileSync(new URL('../src/public/report-analysis-status.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('preparation inclusion check follows dates, handles failure, and rejects out-of-order responses',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);
 const dom=new JSDOM(reportPreparationHtml({id:31,name:'Arada'},[]),{runScripts:'outside-only',url:'https://cited.ae/api/projects/31/report/prepare'}),w=dom.window;
 try{
 await tick();let pending=[];
 w.fetch=(url,options)=>new Promise(resolve=>pending.push({url,options,resolve}));
 w.eval(script);w.dispatchEvent(new w.Event('pageshow'));
 assert.equal(pending.length,1);assert.equal(pending[0].options.method,undefined);
 const from=w.document.querySelector('[data-report-from]');from.value='2026-10-01';from.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.match(pending[1].url,/from=2026-10-01/);assert.equal(pending[0].options.signal.aborted,true);
 pending[1].resolve({ok:true,json:async()=>({state:'draft'})});await tick();
 pending[0].resolve({ok:true,json:async()=>({state:'included',draftId:1,revision:0})});await tick();
 const status=w.document.querySelector('[data-analysis-inclusion]');assert.match(status.textContent,/Not included: a current draft/);
 w.document.querySelector('[data-recheck-analysis]').click();pending[2].resolve({ok:false});await tick();assert.match(status.textContent,/could not be verified/);
 w.document.querySelector('[data-recheck-analysis]').click();pending[3].resolve({ok:true,json:async()=>({state:'included',draftId:2,revision:1})});await tick();assert.match(status.textContent,/Draft 2, wording version 1/);
 const to=w.document.querySelector('[data-report-to]');to.value='2026-09-01';to.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(pending.length,4);assert.match(status.textContent,/valid reporting period/);
 }finally{w.close();}
});
test('status endpoint scopes project before reading and never generates analysis',()=>{
 const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
 const route=server.split("app.get('/api/projects/:id/report/analysis-status'")[1].split('// Analyst generation')[0];
 assert.ok(route.indexOf('assertProject')<route.indexOf('buildReport'));
 assert.match(route,/no-store/);assert.match(route,/presentationOnly:true/);assert.doesNotMatch(route,/generateAnalysis|requestAnalysis/);
});
