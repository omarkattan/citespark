import test from 'node:test';
import assert from 'node:assert/strict';
import {introductionOnly, INTRO_ONLY_REASON, ANSWER_ELIGIBILITY_POLICY} from '../src/lib/answer-eligibility.js';
import {analyseRun} from '../src/lib/analyze.js';
import {unmeasuredReason, measuredQuestionRates, retrySamples} from '../src/lib/answer-quality.js';
import {summariseEvidence} from '../src/lib/report-evidence.js';
import {measurementSettings} from '../src/lib/measurement-batches.js';
const entities=[{id:1,name:'Acme',domain:'acme.test',kind:'owned'}];
const intros=['Here are some top agencies to consider:\n ', 'إليك بعض أبرز الوكالات:', 'Acme and other agencies to consider:'];
test('intro-only evidence produces no entity verdict, even with paid interpretation enabled',async()=>{
 for(const text of intros){
  assert.equal(introductionOnly(text),true);
  assert.deepEqual(await analyseRun({text,entities,useModel:true}),[]);
  assert.equal(unmeasuredReason({ok:true,response_text:text,mentioned:null}),INTRO_ONLY_REASON);
 }
});
test('short complete answers and supplied list items still use literal matching',async()=>{
 for(const text of ['Compare fees before choosing.','Here are providers:\n1. Another agency','Here are providers:\n- Another agency']){
  assert.equal(introductionOnly(text),false);
  assert.equal((await analyseRun({text,entities}))[0].mentioned,false);
 }
 assert.equal((await analyseRun({text:'Acme is an agency.',entities}))[0].mentioned,true);
});
test('withheld answers stay outside report denominators and cannot create gap recommendations',async()=>{
 const rows=[];
 for(const [id,text] of [...intros,'Other providers are available.'].entries()){
  const [m]=await analyseRun({text,entities});
  rows.push({id,prompt_id:1,text:'Which agencies?',response_text:text,engine:'chatgpt',ok:true,mentioned:m?.mentioned??null,cited:m?false:null});
 }
 const report=summariseEvidence(rows);
 assert.equal(report.totals.measured,1);assert.equal(report.totals.unmeasured,3);
 assert.equal(report.totals.named,0);
 assert.equal(measuredQuestionRates(rows).measuredAnswers,1);
 assert.ok(report.priorities[0].do.includes('incomplete evidence'));
 assert.equal(report.priorities.some(p=>p.do.includes('no recorded presence')),false);
 // Withheld evidence is retained, rather than silently retried or deleted.
 assert.equal(retrySamples(rows).sound.length,4);
});
test('new collection settings identify the eligibility policy without changing the model or detector',()=>{
 const s=measurementSettings({market:'AE'},{chatgpt:'project-pin'},['chatgpt'],1,2000,entities);
 assert.equal(s.answerEligibility,ANSWER_ELIGIBILITY_POLICY);
 assert.equal(s.detection,'visible-text-v2');assert.equal(s.models.chatgpt,'project-pin');
});
