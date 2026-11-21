import test from 'node:test';
import assert from 'node:assert/strict';
import {askEngine,answerFromPayload,validateRecoveryModels,isTransient} from '../src/lib/dataforseo.js';
test('real provider parser retains raw attempts, citation annotations, search results and cumulative retry costs',async()=>{
 const original=globalThis.fetch,events=[];let calls=0;
 process.env.DATAFORSEO_LOGIN='fixture';process.env.DATAFORSEO_PASSWORD='fixture';
 const annotation={url:'https://blog.bankaletihad.com/a',title:'Travel cards',start_index:0,end_index:13};
 const raw={cost:.02,tasks:[{id:'provider-2',status_code:20000,result:[{model_name:'pin',web_search:true,search_results:[{url:'https://other.example/'}],items:[{type:'reasoning',sections:[{text:'Private reasoning must not become an answer.'}]},{type:'message',sections:[{text:'Bank al Etihad offers cards.',annotations:[annotation]}]}]}]}]};
 globalThis.fetch=async(url,options)=>{calls++;assert.equal(JSON.parse(options.body)[0].web_search,true);assert.equal(JSON.parse(options.body)[0].model_name,'pin');
  return new Response(JSON.stringify(calls===1?{cost:.01,tasks:[{id:'provider-1',status_code:50000,status_message:'Internal Error.'}]}:raw),{status:200});};
 try {
  const answer=await askEngine({engine:'claude',prompt:'Which banks?',model:'pin',onAttempt:async e=>events.push(e)});
  assert.equal(calls,2);assert.equal(answer.costUsd,.03);assert.equal(answer.text,'Bank al Etihad offers cards.');
  assert.deepEqual(answer.evidence.annotations,[annotation]);assert.equal(answer.evidence.searchResults.length,1);assert.equal(answer.citations[0].title,'Travel cards');
  assert.equal(events.filter(e=>e.phase==='dispatch').length,2);assert.deepEqual(events.at(-1).response,raw);
  assert.ok(!JSON.stringify(events).includes('Basic '));assert.equal(answerFromPayload('claude',raw).evidence.replayed,true);
 }finally{globalThis.fetch=original;}
});
test('recovery verifies exact saved model availability without silently substituting models',async()=>{
 const s={engines:['claude'],models:{claude:'old-pin'}};
 await assert.rejects(validateRecoveryModels(s,async()=>[{model_name:'new-pin',web_search_supported:true}]),/not in the provider/);
 await assert.rejects(validateRecoveryModels(s,async()=>[{model_name:'old-pin',web_search_supported:false}]),/does not currently support/);
 await assert.rejects(validateRecoveryModels(s,async()=>{throw Error('Unavailable');}),/No checks were requested/);
 assert.equal((await validateRecoveryModels(s,async()=>[{model_name:'old-pin',web_search_supported:true}]))[0].model,'old-pin');
});

test('Google parser requires an intact result before recording a missing Overview, for live and replay',async()=>{
 const original=globalThis.fetch;
 process.env.DATAFORSEO_LOGIN='fixture';process.env.DATAFORSEO_PASSWORD='fixture';
 try{
  for(const [result,complete] of [[null,false],[[],false],[{items:null},false],[[{items:[]}],false],[[{items:[{type:'organic'}]}],true]]){
   const payload={tasks:[{id:'google-original',status_code:20000,result}]};
   globalThis.fetch=async()=>new Response(JSON.stringify(payload));
   const answer=await askEngine({engine:'ai_overview',prompt:'Which providers?',market:'AE'});
   assert.equal(answer.ok,complete);assert.equal(Boolean(answer.noOverview),complete);
   assert.equal(answerFromPayload('ai_overview',payload)?.noOverview??false,complete);
  }
 }finally{globalThis.fetch=original;}
});
test('provider codes distinguish upstream failures from credentials and invalid fields',()=>{
 assert.equal(isTransient({providerStatusCode:40101,error:'localized failure'}),true);
 assert.equal(isTransient({providerStatusCode:50000,error:'Internal Error.'}),true);
 assert.equal(isTransient({error:'40100: Not authorized'}),false);
 assert.equal(isTransient({error:'40501: Invalid Field'}),false);
});

test('Google Live 40101 moves the same localized question to its own priority queue',async t=>{
 const originalTimer=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>originalTimer(fn,0,...args));
 process.env.DATAFORSEO_LOGIN='fixture';process.env.DATAFORSEO_PASSWORD='fixture';
 for(const [engine,surface] of [['ai_overview','organic'],['ai_mode','ai_mode']]){
  const api='https://api.dataforseo.com/v3/serp/google/'+surface,requests=[],events=[];
  const result=engine==='ai_overview'?[{type:'organic',url:'https://example.org/'}]:[{type:'ai_overview',text:'The answer refers to a family office.'}];
  const responses=[
   {id:'live-1',status_code:40101,cost:.004,status_message:'Internal SE Server Error.'},
   {id:'queue-1',status_code:20100,cost:.0018},
   {id:'queue-1',status_code:40602,cost:.0018},
   {id:'queue-1',status_code:20000,cost:.0018,result:[{items:result}]}];
  const fetch=t.mock.method(globalThis,'fetch',async(url,options)=>{
   requests.push({url,method:options.method,body:options.body?JSON.parse(options.body):undefined});
   return Response.json({tasks:[responses.shift()]});
  });
  const answer=await askEngine({engine,prompt:'ما هي أفضل خيارات إدارة الثروات؟',market:'AE',onAttempt:e=>events.push(e)});
  fetch.mock.restore();
  assert.deepEqual(requests.map(r=>[r.method,r.url]),[['POST',api+'/live/advanced'],['POST',api+'/task_post'],['GET',api+'/task_get/advanced/queue-1'],['GET',api+'/task_get/advanced/queue-1']]);
  assert.deepEqual(requests[1].body,[{...requests[0].body[0],priority:2}]);
  assert.equal(requests[0].body[0].language_code,'ar');assert.equal(requests[0].body[0].location_name,'United Arab Emirates');
  assert.equal(requests[1].body[0].load_async_ai_overview,engine==='ai_overview'?true:undefined);
  assert.equal(answer.ok,true);assert.equal(Boolean(answer.noOverview),engine==='ai_overview');
  assert.equal(answer.costUsd,.0018);assert.equal(answer.evidence.providerRequestId,'queue-1');
  assert.deepEqual(events.filter(e=>e.phase==='response').map(e=>e.costUsd),[0,0,0,.0018]);
 }
});

test('a refunded queued failure, a rejected request and a pending receipt never create a zero-visibility answer',async t=>{
 const timer=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>timer(fn,0,...args));
 process.env.DATAFORSEO_LOGIN='fixture';process.env.DATAFORSEO_PASSWORD='fixture';
 for(const [last,expected] of [[40101,3],[40602,11],[40501,1]]){
  let calls=0;
  const mock=t.mock.method(globalThis,'fetch',async()=>{
   calls++;
   const code=calls===1?(last===40501?40501:40101):calls===2?20100:last;
   return Response.json({cost:.004,tasks:[{id:calls===1?'live-2':'queue-2',cost:.004,status_code:code,status_message:code===40501?'Invalid Field':'Provider response'}]});
  });
  const answer=await askEngine({engine:'ai_overview',prompt:'Which firms?',market:'AE'});
  mock.mock.restore();
  assert.equal(calls,expected);assert.equal(answer.ok,false);assert.ok(!answer.noOverview);
  assert.equal(Boolean(answer.queuePending),last===40602);
  if(last!==40501)assert.equal(answer.costUsd,0);
 }
});
