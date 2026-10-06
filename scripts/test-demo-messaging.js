import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
function page(){
 const dom=new JSDOM('<input id="demoDomain"><button id="demoScan"></button><div id="demoNote"></div><div id="demoStep1"></div><div id="demoStep2"></div><div id="demoStep3"></div><div id="demoWorking"></div><div id="demoResult"></div>',{url:'https://cited.ae',runScripts:'outside-only'});
 dom.window.HTMLElement.prototype.scrollIntoView=function(){};
 vm.runInContext(readFileSync(new URL('../src/public/demo.js',import.meta.url),'utf8'),dom.getInternalVMContext());
 return dom.window;
}
const result=(overrides={})=>({domain:'example.com',brandName:'Example',question:'Where to buy?',engine:'chatgpt',runs:3,mentions:3,rate:1,strip:[true,true,true],others:[],sources:[],fanOut:[],excerpt:'Example',...overrides});
test('distinct questions stay separate, repeat replaces its row and unsafe text is escaped',()=>{
 const w=page();w.showResult(result());w.showResult(result({question:'Other question',mentions:0,rate:0,strip:[false,false,false]}));
 let text=w.document.body.textContent;assert.match(text,/presence varies by question/);assert.match(text,/Where to buy/);assert.match(text,/Other question/);assert.doesNotMatch(text,/never names|other businesses|market share/);
 w.showResult(result({cached:true,question:'Where to buy?',brandName:'<img src=x onerror=alert(1)>'}));
 assert.equal(w.document.querySelectorAll('.demo-comparison .demo-read-line').length,2);assert.equal(w.document.querySelectorAll('img').length,0);assert.match(w.document.body.textContent,/reused without a new check/);
});
test('unknown is not zero and partial successful sample states failures',()=>{
 const w=page();w.showResult(result({runs:0,mentions:null,rate:null}));assert.match(w.document.body.textContent,/Not measured/);assert.doesNotMatch(w.document.body.textContent,/0%/);
 w.showResult(result({runs:2,mentions:1,failed:1}));assert.match(w.document.body.textContent,/Named in 1 of 2/);assert.match(w.document.body.textContent,/1 failed attempts excluded/);
});
test('duplicate clicks cannot start concurrent requests and failure resets busy state',async()=>{
 const w=page();w.eval("demo.site={domain:'example.com',questions:[{text:'Question',token:'t'}]}");let calls=0,release;
 w.fetch=()=>{calls++;return new Promise(r=>release=r)};
 const first=w.run(0);await w.run(0);assert.equal(calls,1);
 release({ok:false,json:async()=>({error:'Engine unavailable'})});await first;
 assert.match(w.document.body.textContent,/Engine unavailable/);assert.equal(w.eval('demo.running'),false);assert.equal(w.document.getElementById('demoStep3').hidden,true);
});
test('all saved answers are inspectable, escaped and old excerpts are identified',()=>{
 const w=page();const long='Example '+ 'detail '.repeat(200);
 w.showResult(result({answerEvidence:[{text:long,mentioned:true},{text:'<img src=x onerror=alert(1)>',mentioned:false},{text:'Unknown',mentioned:null}]}));
 assert.equal(w.document.querySelectorAll('#demoResult details').length,3);
 assert.ok(w.document.body.textContent.includes(long));assert.equal(w.document.querySelectorAll('img').length,0);
 assert.match(w.document.body.textContent,/Naming unavailable/);
 w.showResult(result());assert.match(w.document.body.textContent,/older result retained only an excerpt/);
});
test('demo retains each received answer and metadata without extra calls or altered counts',async()=>{
 const source=readFileSync(new URL('../src/lib/demo.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('export async function runDemo'),source.indexOf('export const DEMO_CONFIG')).replace('export ','');
 let saved,calls=0;const values=[{ok:true,text:'Example '+ 'detail '.repeat(200),citations:[],fanOut:[],model:'model-a',costUsd:0.01},{ok:false,costUsd:0.02},{ok:true,text:'Advice only.',citations:[],fanOut:[],model:'model-a',costUsd:0.01}];
 const c=vm.createContext({verifyQuestion:()=>true,one:async()=>null,query:async(sql,p)=>{saved=p},CACHE_HOURS:24,DEMO_RUNS:3,DEMO_ENGINE:'chatgpt',askEngine:async()=>values[calls++],analyseRun:async({text})=>[{mentioned:text.includes('Example'),ordinal:null,snippet:null}]});vm.runInContext(fn,c);
 const r=await c.runDemo({domain:'example.com',brandName:'Example',question:'Question',token:'t',ipHash:'test'});
 assert.equal(calls,3);assert.equal(r.runs,2);assert.equal(r.mentions,1);assert.equal(r.failed,1);
 assert.equal(r.answerEvidence[0].text,values[0].text);assert.equal(r.answerEvidence[1].model,'model-a');assert.equal(JSON.parse(saved[3]).answerEvidence.length,2);assert.equal(saved[4],0.04);
});
