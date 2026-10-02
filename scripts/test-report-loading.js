import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reportLoadingHtml,reportRange} from '../src/lib/report-loading.js';
import {reportPreparationHtml} from '../src/lib/report-preparation.js';
const script=readFileSync(new URL('../src/public/report-loading.js',import.meta.url),'utf8');
const settle=()=>new Promise(r=>setTimeout(r,5));
test('loading shell keeps only supported options and escapes the project name',()=>{
 const html=reportLoadingHtml({id:31,name:'<script>oops</script>'},{from:'2026-10-01',to:'2026-10-02',view:'ceo',format:'csv',redirect:'https://evil.test'});
 assert.match(html,/from=2026-10-01&amp;to=2026-10-02&amp;view=ceo/);assert.doesNotMatch(html,/<script>oops|evil.test|format=csv/);assert.match(html,/No new AI checks/);
 assert.equal(reportRange({from:'2026-99-01',to:'2026-02-30'}).size,0);
});
test('preparation passes chosen dates to both formats',()=>{
 const html=reportPreparationHtml({id:31,name:'Arada'},[],undefined,undefined,{from:'2026-10-01',to:'2026-10-02'});
 assert.match(html,/report\/open\?from=2026-10-01&amp;to=2026-10-02/);assert.match(html,/view=ceo&amp;from=2026-10-01&amp;to=2026-10-02/);
});
test('failure offers retry, makes no paid check request, then replaces URL before rendering',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);const dom=new JSDOM(reportLoadingHtml({id:31,name:'Arada'},{view:'ceo',from:'2026-10-01'}),{url:'https://cited.ae/api/projects/31/report/open?view=ceo',runScripts:'outside-only'});
 const w=dom.window,calls=[];let fail=true;
 w.fetch=async url=>{calls.push(url);return {ok:!fail,status:503,headers:{get:()=> 'text/html'},text:async()=>'<html><body><h1>Finished report</h1></body></html>'};};
 w.eval(script);await settle();assert.equal(w.document.querySelector('#retry').hidden,false);assert.match(w.document.querySelector('#reportStatus').textContent,/503/);
 fail=false;w.document.querySelector('#retry').click();await settle();assert.match(w.document.body.textContent,/Finished report/);assert.equal(w.location.pathname,'/api/projects/31/report');assert.equal(w.location.search,'?from=2026-10-01&view=ceo');assert.equal(calls.length,2);assert.ok(calls.every(x=>x.startsWith('/api/projects/31/report?')));dom.window.close();
});
test('timeout provides a recoverable error, not invented progress',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);const dom=new JSDOM(reportLoadingHtml({id:31,name:'Arada'}),{url:'https://cited.ae/api/projects/31/report/open',runScripts:'outside-only'});const w=dom.window;
 w.fetch=async()=>{const e=Error('timeout');e.name='AbortError';throw e;};w.eval(script);await settle();assert.match(w.document.querySelector('#reportStatus').textContent,/took too long/);assert.equal(w.document.querySelector('#retry').hidden,false);dom.window.close();
});
test('date changes retain format, reject reversed ranges and preserve draft fields',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);const dom=new JSDOM(reportPreparationHtml({id:31,name:'Arada'},[]),{url:'https://cited.ae/api/projects/31/report/prepare',runScripts:'outside-only'});const w=dom.window;
 w.eval(readFileSync(new URL('../src/public/report-preparation.js',import.meta.url),'utf8'));
 const from=w.document.querySelector('[data-report-from]'),to=w.document.querySelector('[data-report-to]');from.value='2026-10-02';to.value='2026-10-01';to.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(w.document.querySelector('[data-report-link]').hasAttribute('href'),false);
 to.value='2026-10-03';to.dispatchEvent(new w.Event('change',{bubbles:true}));const ceo=new URL(w.document.querySelector('[data-report-link=ceo]').href);assert.equal(ceo.searchParams.get('view'),'ceo');assert.equal(ceo.searchParams.get('from'),'2026-10-02');assert.equal(ceo.searchParams.get('to'),'2026-10-03');dom.window.close();
});
test('unchanged report preview shows one copy and no confirm button',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);const row={id:1,title:'Action',status:'open',selected_at:'2026-10-01',review_decision:{stage:'ready'}};
 const dom=new JSDOM(reportPreparationHtml({id:31,name:'Arada'},[row]),{url:'https://cited.ae/api/projects/31/report/prepare',runScripts:'outside-only'}),w=dom.window;
 w.fetch=async()=>({ok:true,json:async()=>({current:{title:'Action',notes:'Same evidence'},proposed:{title:'Action',notes:'Same evidence'},changed:false,canInclude:true})});
 w.eval(readFileSync(new URL('../src/public/report-preparation.js',import.meta.url),'utf8'));w.document.querySelector('[data-preview]').click();await settle();assert.equal(w.document.querySelectorAll('.preview-box').length,1);assert.doesNotMatch(w.document.querySelector('[data-preview-panel]').textContent,/Confirm report update/);dom.window.close();
});
