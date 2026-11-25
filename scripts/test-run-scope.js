import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {configuredRunScope,runScopeProblem,projectForSample} from '../src/lib/run-scope.js';
import {PLANS} from '../src/lib/plans.js';
const billing=readFileSync(new URL('../src/lib/billing.js',import.meta.url),'utf8');
const worker=readFileSync(new URL('../src/jobs/runCycle.js',import.meta.url),'utf8');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const project={id:181,org_id:1,market:'AE',engines:['chatgpt','perplexity'],runs_per_cycle:3};
const prompts=[{id:1,text:'Best bank?',language:'en'},{id:2,text:'أفضل بنك؟',language:'ar'}];
function billingHarness({internal=true,unmetered=false,spend=0,calls=0,verified=true,plan='free',remainingBudget=250}={}){
 const h=vm.createContext({getSubscription:async()=>({effectivePlan:plan,status:'active'}),planFor:id=>PLANS[id],process:{env:{}},
 INTERNAL_BUDGET:remainingBudget,ENGINE_IDS:['chatgpt','perplexity','claude','gemini','ai_mode','ai_overview'],getUsage:async()=>({calls,spend}),
 one:async sql=>sql.includes('SELECT internal,')?{internal,unmetered_usage:unmetered,quick_start_enabled:true,quick_start_action_preview:true}:sql.includes('COUNT')?{sites:1,questions:2}:null,verifiedEnough:async()=>verified,engineCosts:async()=>({costs:{chatgpt:0.03,perplexity:0.03}}),WORST_CASE_CALL:0.03});
 vm.runInContext(billing.slice(billing.indexOf('export async function getEntitlements('),billing.indexOf('/**\n * Limit checks.')).replace('export ',''),h);
 vm.runInContext(billing.slice(billing.indexOf('export async function budgetForCycle('),billing.indexOf('/* ---------------- Stripe')).replace('export ',''),h);
 return h;
}
test('internal account keeps three configured repeats and its spend cap',async()=>{
 const h=billingHarness(),ent=await h.getEntitlements(1),b=await h.budgetForCycle(1,{questions:2,engines:project.engines,runs:3});
 assert.equal(ent.plan.name,'Internal access');assert.equal(ent.plan.monthlyBudgetUsd,250);assert.equal(b.runs,3);assert.equal(b.maxCalls,12);
 const jobsContext=vm.createContext({prompts,budget:b,recovery:null});
 vm.runInContext(worker.slice(worker.indexOf('  const jobs = recovery ?'),worker.indexOf('  console.log(',worker.indexOf('  const jobs = recovery ?')))+'\nthis.jobs=jobs;',jobsContext);
 assert.equal(jobsContext.jobs.length,12);assert.equal(new Set(jobsContext.jobs.map(j=>`${j.prompt.id}:${j.engine}:${j.runIndex}`)).size,12);
});
test('usage-only grants allow scans above both monthly limits and do not confer internal access',async()=>{
 const h=billingHarness({internal:false,unmetered:true,spend:400,calls:5000});
 const budget=await h.budgetForCycle(1,{questions:2,engines:project.engines,runs:3});
 const e=budget.entitlements;
 assert.equal(budget.maxCalls,12);assert.equal(e.advanced,true);assert.equal(e.actionPreview,false);
 assert.equal(e.internal,false);assert.equal(e.plan.internal,false);
 assert.equal(e.usage.limit,null);assert.equal(e.usage.budget,null);assert.equal(e.cycleSpendCap,null);
 assert.equal((await billingHarness({internal:false,spend:2}).budgetForCycle(1,{questions:1,engines:['chatgpt'],runs:1})).ok,false);
 assert.equal((await billingHarness({internal:true,spend:251}).budgetForCycle(1,{questions:1,engines:['chatgpt'],runs:1})).ok,false);
 assert.equal((await billingHarness({internal:false,unmetered:true,verified:false}).budgetForCycle(1,{questions:1,engines:['chatgpt'],runs:1})).needsVerification,true);
});
test('commercial free plan remains capped at one repeat, with explicit refusal instead of silent reduction',async()=>{
 const b=await billingHarness({internal:false}).budgetForCycle(1,{questions:2,engines:project.engines,runs:3});
 assert.equal(b.runs,1);assert.match(runScopeProblem(configuredRunScope(project,prompts),b),/repeat count exceed/);
});
test('insufficient spend cannot silently shorten the panel',async()=>{
 const b=await billingHarness({remainingBudget:0.1}).budgetForCycle(1,{questions:2,engines:project.engines,runs:3});
 assert.match(runScopeProblem(configuredRunScope(project,prompts),b),/cannot cover/);
});
test('scope detects changed engine, repeats, question text, language, model and market',()=>{
 const scope=configuredRunScope(project,prompts),budget={ok:true,runs:3,engines:project.engines,maxCalls:12};
 assert.equal(scope.checks,12);assert.deepEqual(scope.languages,{en:1,ar:1});assert.equal(runScopeProblem(scope,budget,scope.fingerprint),null);
 for(const [p,qs] of [[{...project,runs_per_cycle:1},prompts],[{...project,engines:['chatgpt']},prompts],[{...project,market:'JO'},prompts],[{...project,models:{chatgpt:'new-model'}},prompts],[project,[{...prompts[0],text:'Different question'},prompts[1]]],[project,[{...prompts[0],language:'ar'},prompts[1]]]])
  assert.match(runScopeProblem(configuredRunScope(p,qs),budget,scope.fingerprint),/changed/);
 assert.equal(configuredRunScope(project,[...prompts].reverse()).fingerprint,scope.fingerprint);
});
function routeHarness(){
 const routes={},cycles=new Map(),launched=[];
 const h=vm.createContext({app:{post:(path,...handlers)=>routes[path]=handlers.at(-1)},requireAuth:()=>{},wrap:fn=>fn,
 assertProject:async()=>project,measurementLocation:async()=>({ok:true}),getEntitlements:async()=>({advanced:true}),
 many:async()=>prompts,configuredRunScope,runScopeProblem,budgetForCycle:async()=>({ok:true,engines:project.engines,runs:3,maxCalls:12}),cycles,MOCK:true,
 runCycleForProject:(id,opts)=>{launched.push({id,opts});return new Promise(()=>{});}});
 const start=server.indexOf("app.post('/api/projects/:id/run'");vm.runInContext(server.slice(start,server.indexOf('/**\n * Run every site',start)),h);
 const res=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}});
 return {routes,launched,res};
}
test('stale confirmation makes no worker call, matching confirmation starts once',async()=>{
 const {routes,launched,res}=routeHarness(),run=routes['/api/projects/:id/run'];
 const request=confirmedScope=>({session:{orgId:1},body:{confirmedScope}});
 const stale=res();await run(request('stale'),stale);assert.equal(stale.statusCode,409);assert.equal(launched.length,0);
 const accepted=res(),scope=configuredRunScope(project,prompts);await run(request(scope.fingerprint),accepted);
 assert.equal(accepted.body.calls,12);assert.equal(launched.length,1);assert.equal(launched[0].opts.confirmedScope,scope.fingerprint);
 const repeated=res();await run(request(scope.fingerprint),repeated);assert.equal(repeated.statusCode,409);assert.equal(launched.length,1);
});
test('worker rejects changed confirmation before creating a batch or provider call',async()=>{
 let providerCalls=0,batches=0;
 const h=vm.createContext({one:async sql=>sql.includes('SELECT * FROM projects')?project:null,many:async sql=>sql.includes('prompts')?prompts:[],
 projectForSample,assertMeasurementLocation:async()=>{},enginesFor:p=>p.engines,selectedEntities:()=>[],budgetForCycle:async()=>({ok:true,runs:3,engines:project.engines,maxCalls:12}),
 configuredRunScope,runScopeProblem,askEngine:async()=>providerCalls++,startMeasurement:async()=>batches++,console});
 const a=worker.indexOf('async function collectProject('),b=worker.indexOf('async function summarise(',a);vm.runInContext(worker.slice(a,b),h);
 const result=await h.collectProject(181,{confirmedScope:'stale'},()=>{});
 assert.equal(result.blocked,true);assert.equal(providerCalls,0);assert.equal(batches,0);
});
