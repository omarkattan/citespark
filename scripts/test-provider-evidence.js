import test from 'node:test';
import assert from 'node:assert/strict';
import {askEngine,answerFromPayload,validateRecoveryModels} from '../src/lib/dataforseo.js';
test('real provider parser retains raw attempts, citation annotations, search results and cumulative retry costs',async()=>{
 const original=globalThis.fetch,events=[];let calls=0;
 process.env.DATAFORSEO_LOGIN='fixture';process.env.DATAFORSEO_PASSWORD='fixture';
 const annotation={url:'https://blog.bankaletihad.com/a',title:'Travel cards',start_index:0,end_index:13};
 const raw={cost:.02,tasks:[{id:'provider-2',status_code:20000,result:[{model_name:'pin',web_search:true,search_results:[{url:'https://other.example/'}],items:[{type:'reasoning',sections:[{text:'Private reasoning must not become an answer.'}]},{type:'message',sections:[{text:'Bank al Etihad offers cards.',annotations:[annotation]}]}]}]}]};
 globalThis.fetch=async(url,options)=>{calls++;assert.equal(JSON.parse(options.body)[0].web_search,true);assert.equal(JSON.parse(options.body)[0].model_name,'pin');
  return new Response(JSON.stringify(calls===1?{cost:.01,tasks:[{id:'provider-1',status_code:50000,status_message:'Service Unavailable'}]}:raw),{status:200});};
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
