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
const result=(overrides={})=>({collectionProfile:'test-profile',domain:'example.com',brandName:'Example',question:'Where to buy?',engine:'chatgpt',runs:3,mentions:3,rate:1,strip:[true,true,true],others:[],sources:[],fanOut:[],excerpt:'Example',...overrides});
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
 const fn=source.slice(source.indexOf('export function assessDemoEvidence'),source.indexOf('export const DEMO_CONFIG')).replaceAll('export ','');
 let saved,calls=0;const values=[{ok:true,text:'Example '+ 'detail '.repeat(200),citations:[],fanOut:[],model:'model-a',costUsd:0.01},{ok:false,costUsd:0.02},{ok:true,text:'Advice only.',citations:[],fanOut:[],model:'model-a',costUsd:0.01}];
 const c=vm.createContext({DEMO_MODEL:'gpt-4.1',DEMO_MAX_TOKENS:2000,DEMO_ENGINE:'chatgpt',DEMO_RUNS:3,ENGINES:{chatgpt:{}},resolveModel:async()=> 'gpt-4.1',verifyQuestion:()=>true,one:async()=>null,query:async(sql,p)=>{saved=p},CACHE_HOURS:24,DEMO_RUNS:3,DEMO_ENGINE:'chatgpt',askEngine:async opts=>{assert.equal(opts.model,'gpt-4.1');assert.equal(opts.maxTokens,2000);return values[calls++];},analyseRun:async({text})=>[{mentioned:text.includes('Example'),ordinal:null,snippet:null}]});vm.runInContext(fn,c);
 const r=await c.runDemo({domain:'example.com',brandName:'Example',question:'Question',token:'t',ipHash:'test'});
 assert.equal(calls,3);assert.equal(r.runs,2);assert.equal(r.mentions,1);assert.equal(r.failed,1);
 assert.equal(r.answerEvidence[0].text,values[0].text);assert.equal(r.answerEvidence[1].model,'model-a');assert.equal(JSON.parse(saved[3]).answerEvidence.length,2);assert.equal(saved[4],0.04);
});
test('introduction-only samples withhold scores, including cache, without rewriting stored evidence',async()=>{
 const source=readFileSync(new URL('../src/lib/demo.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('export function assessDemoEvidence'),source.indexOf('export const DEMO_CONFIG')).replaceAll('export ','');
 const intro='When seeking an agency, several firms offer services. Here are some top agencies to consider:\n\n ';
 const original=result({answerEvidence:[{text:intro,mentioned:false},{text:'Example is an agency.',mentioned:true}],mentions:1,runs:2});
 const c=vm.createContext({DEMO_MODEL:'gpt-4.1',DEMO_MAX_TOKENS:2000,DEMO_ENGINE:'chatgpt',DEMO_RUNS:3,ENGINES:{chatgpt:{}},resolveModel:async()=> 'gpt-4.1',verifyQuestion:()=>true,one:async(sql,params)=>({result:{...original,collectionProfile:params[3]}}),query:async()=>{},CACHE_HOURS:24,askEngine:()=>{throw Error('Cache must not call engine')}});vm.runInContext(fn,c);
 const r=await c.runDemo({domain:'example.com',brandName:'Example',question:'Where to buy?',token:'t',ipHash:'test'});
 assert.equal(r.status,'inconclusive');assert.equal(r.mentions,null);assert.equal(r.rate,null);assert.equal(r.cached,true);
 assert.equal(r.answerEvidence[0].text,intro);assert.equal(original.mentions,1);assert.equal(original.answerEvidence[0].qualityReview,undefined);
 assert.equal(c.assessDemoEvidence(result({excerpt:intro})).status,'inconclusive');
 assert.equal(c.assessDemoEvidence(result({excerpt:'When seeking top digital marketing agencies specializing in e-commerce growth within the UAE and the broader Middle East, several firms stand out for their expertise and proven results:'})).status,'inconclusive');
 for(const text of ['Here are some top agencies to consider:\n1. Example','Try Example.','Compare fees and experience before choosing an agency.']){
  const good=result({answerEvidence:[{text,mentioned:false}]});assert.equal(c.assessDemoEvidence(good),good);
 }
 const w=page();w.showResult(r);assert.match(w.document.body.textContent,/Result inconclusive/);assert.match(w.document.body.textContent,/Score withheld/);assert.doesNotMatch(w.document.body.textContent,/0%|Named in 0/);assert.match(w.document.body.textContent,/Needs review/);
 w.showResult(result({question:'Another question'}));assert.equal(w.document.querySelectorAll('.demo-comparison').length,0);
});
test('a legacy or different-profile cached demo cannot replace the new model sample',async()=>{
 const source=readFileSync(new URL('../src/lib/demo.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('export function assessDemoEvidence'),source.indexOf('export const DEMO_CONFIG')).replaceAll('export ','');
 let calls=0,saved;const c=vm.createContext({DEMO_MODEL:'gpt-4.1',DEMO_MAX_TOKENS:2000,DEMO_ENGINE:'chatgpt',DEMO_RUNS:3,ENGINES:{chatgpt:{}},resolveModel:async()=> 'gpt-4.1',verifyQuestion:()=>true,CACHE_HOURS:24,
 one:async(sql,params)=>{assert.match(sql,/result->>'collectionProfile' = \$4/);const profile=JSON.parse(params[3]);assert.equal(profile.model,'gpt-4.1');assert.equal(profile.maxTokens,2000);assert.equal(profile.market,'AE');return {result:result({collectionProfile:'old-settings'})};},
 query:async(sql,p)=>{saved=JSON.parse(p[3]);},
 askEngine:async()=>{calls++;return {ok:true,text:'An answer with a complete ending.',model:'gpt-4.1-2025-04-14',citations:[],costUsd:0.07};},analyseRun:async()=>[{mentioned:false}]});vm.runInContext(fn,c);
 const r=await c.runDemo({domain:'example.com',brandName:'Example',question:'Question',token:'t',ipHash:'test'});
 assert.equal(calls,3);assert.equal(r.requestedModel,'gpt-4.1');assert.equal(r.runs,3);assert.equal(r.cached,undefined);assert.equal(saved.collectionProfile,r.collectionProfile);assert.equal(saved.answerEvidence[0].model,'gpt-4.1-2025-04-14');
});

test('comparison excludes legacy and different model settings while preserving current results',()=>{
 const w=page();w.showResult(result({question:'Old question',collectionProfile:undefined}));
 w.showResult(result({question:'Mini question',collectionProfile:'old-mini'}));
 w.showResult(result({question:'Current question'}));
 assert.equal(w.document.querySelectorAll('.demo-comparison').length,0);
 w.showResult(result({question:'Second current question'}));
 const text=w.document.querySelector('.demo-comparison').textContent;
 assert.match(text,/Current question/);assert.match(text,/Second current question/);assert.doesNotMatch(text,/Old question|Mini question/);
});
