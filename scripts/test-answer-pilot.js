import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectPilot, runPilotPair } from '../src/lib/answer-pilot.js';
import { retrySamples, collectionLimit, possibleTruncation } from '../src/lib/answer-quality.js';
test('pilot selects at most one flagged answer per assistant engine, excluding Google', () => {
 const rows=['gemini','gemini','claude','chatgpt','perplexity','ai_mode'].map(engine=>({engine,response_text:'x'.repeat(2900),max_output_tokens:700}));
 assert.deepEqual(selectPilot(rows).map(r=>r.engine),['gemini','claude','chatgpt']);
 assert.equal(selectPilot([{engine:'ai_mode',response_text:'x'.repeat(2900),max_output_tokens:700}]).length,0);
});
test('paired calls use exactly the same model and preserve each full answer', async()=>{
 const asks=[],saved=[],costs=[];let budgets=0;
 await runPilotPair({row:{engine:'gemini',text:'Question'},model:'project-model',
 ask:async o=>{asks.push(o);return {ok:true,text:'Full answer.',costUsd:.01,citations:[{url:'https://example.com'}]};},
 save:async r=>saved.push(r),account:async c=>costs.push(c),checkBudget:async()=>budgets++});
 assert.deepEqual(asks.map(x=>[x.model,x.maxTokens]),[['project-model',700],['project-model',2000]]);
 assert.equal(budgets,2);assert.equal(saved.length,2);assert.equal(saved[0].answer.citations.length,1);assert.equal(costs.length,2);
});
test('failed answers are retained and charged, and a budget stop prevents the next call',async()=>{
 let calls=0,checks=0;const saved=[],costs=[];
 await assert.rejects(runPilotPair({row:{engine:'claude',text:'Q'},model:'pin',
 checkBudget:async()=>{if(++checks===2)throw Error('budget');},
 ask:async()=>{calls++;return {ok:false,error:'provider failure',costUsd:.02};},
 account:async c=>costs.push(c),save:async r=>saved.push(r)}),/budget/);
 assert.equal(calls,1);assert.equal(saved[0].answer.ok,false);assert.deepEqual(costs,[.02]);
});
// Exercise the actual retry function with controlled DB/provider dependencies.
const source=readFileSync(new URL('../src/jobs/runCycle.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('export async function reaskPrompt')).replace('export async function','async function');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function retryFixture({engine='gemini',ok=false,budget=true,failAnalysis=false}={}){
 const asks=[],usage=[];
 const project={id:27,org_id:1,engines:['gemini'],models:{gemini:'project-pin'}};
 const deps={one:async sql=>sql.includes('FROM prompts')?{id:1,project_id:27,text:'Q'}:sql.includes('FROM projects')?project:sql.includes('MAX(cycle_date)')?{d:'2026-09-28'}:{id:99},
 many:async sql=>sql.includes('FROM entities')?[{id:1,kind:'owned'}]:[],
 enginesFor:p=>p.engines,budgetForCycle:async()=>({ok:budget,maxCalls:budget?1:0,reason:'budget denied'}),
 resolveModel:async(e,c,override)=>override,ENGINE_CFG:{gemini:{kind:'llm'}},
 retrySamples,collectionLimit,possibleTruncation,
 askEngine:async o=>{asks.push(o);return {ok,text:'Answer.',costUsd:.04,error:ok?null:'failure'};},
 recordUsage:async(...a)=>usage.push(a),query:async()=>{},
 analyseRun:async()=>{if(failAnalysis)throw Error('analysis failed');return [];},hasAnthropic:false,
 isWrapper:()=>false,resolveAll:async()=>new Map(),domainOf:()=>null};
 const execute=new AsyncFunction(...Object.keys(deps),`${body}\nreturn reaskPrompt(1,{engine:${JSON.stringify(engine)}});`);
 let error;try{await execute(...Object.values(deps));}catch(e){error=e;}
 return {asks,usage,error};
}
test('retry passes project model and bills failed calls once',async()=>{
 const r=await retryFixture();assert.equal(r.error,undefined);assert.equal(r.asks[0].model,'project-pin');assert.deepEqual(r.usage,[[1,1,.04]]);
});
test('retry refuses disabled engines and exhausted budgets before calling provider',async()=>{
 for(const options of [{engine:'claude'},{budget:false}]){const r=await retryFixture(options);assert.ok(r.error);assert.equal(r.asks.length,0);}
});
test('provider usage survives subsequent analysis failure without double billing',async()=>{
 const r=await retryFixture({ok:true,failAnalysis:true});assert.match(r.error.message,/analysis failed/);assert.deepEqual(r.usage,[[1,1,.04]]);
});
