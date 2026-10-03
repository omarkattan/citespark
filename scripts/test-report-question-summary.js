import test from 'node:test';
import assert from 'node:assert/strict';
import {questionSummary} from '../src/lib/report-question-summary.js';
import {analystPacket,analysisReviewWarnings} from '../src/lib/report-analyst.js';
const q=(id,measured,named,cited,source='generated')=>({id,measured,named,cited,source});
test('reviewed Arada counts are computed without double counting Jouri Hills',()=>{
 const project=[[6,6,4],[6,5,4],[6,4,4],[5,4,3],[6,6,5],[6,5,4],[6,5,4],[6,4,3]];
 const general=[[6,0,0],[6,4,0],[6,0,0],[6,0,0],[6,1,1],[6,3,0],[6,2,1],[6,3,0],[6,0,0],[6,6,1],[6,0,0],[6,0,0],[5,2,1],[6,0,0],[6,0,0],[6,1,0],[5,1,0],[6,0,0],[6,0,0],[6,0,0]];
 const result=questionSummary([...project.map((v,i)=>q(1261+i,...v,'gsc+model')),...general.map((v,i)=>q(1269+i,...v))]);
 const a=result.bySource.find(x=>x.source==='gsc+model'),b=result.bySource.find(x=>x.source==='generated');
 assert.equal(a.questionCount,8);assert.equal(a.measuredAnswers,47);assert.equal(a.named.answers,39);assert.equal(a.cited.answers,31);
 assert.equal(b.questionCount,20);assert.equal(b.measuredAnswers,118);assert.equal(b.named.answers,23);assert.equal(b.cited.answers,4);assert.equal(b.named.zeroInMeasuredAnswersQuestionCount,11);
 assert.equal(result.all.questionCount,28);assert.equal(result.all.named.answers,62);assert.equal(result.all.cited.answers,35);assert.equal(result.all.measuredAnswers,165);
 assert.equal(b.named.rate,23/118);assert.equal(b.cited.rate,4/118);
});
test('null is not zero and each metric keeps its own measured denominator',()=>{
 const s=questionSummary([q(1,6,null,0),q(2,5,0,null),q(3,0,0,0),q(4,null,0,0)]).all;
 assert.equal(s.named.answers,0);assert.equal(s.named.measuredAnswerDenominator,5);assert.deepEqual(s.named.zeroInMeasuredAnswersQuestionIds,[2]);
 assert.equal(s.cited.measuredAnswerDenominator,6);assert.deepEqual(s.cited.zeroInMeasuredAnswersQuestionIds,[1]);assert.equal(s.questionsWithUnknownMeasurement,1);
});
test('no measured results produces unknown rates, never false zero performance',()=>{
 const s=questionSummary([q(1,0,0,0)]).all;assert.equal(s.named.answers,null);assert.equal(s.named.rate,null);assert.equal(s.named.eligibleQuestionCount,0);
 assert.equal(questionSummary([]).all.cited.rate,null);
});
test('duplicate IDs cannot inflate question counts',()=>{
 assert.throws(()=>questionSummary([q(1,6,1,1),q('1',6,1,1)]),/unique/);
});
test('invalid counts cannot create impossible rates',()=>{
 const s=questionSummary([q(1,6,7,-1),q(2,6,1.5,NaN)]).all;
 assert.equal(s.named.rate,null);assert.equal(s.cited.rate,null);
});
test('packet includes citeable totals and caps summary to the declared question sample',()=>{
 const report={project:{id:31},period:{},executive:{measurement:{id:47},questions:Array.from({length:105},(_,i)=>q(i+1,6,0,0)),totals:{}},traffic:{},review:{},trend:{}};
 const p=analystPacket(report),record=p.records.find(r=>r.id==='question-summary');assert.ok(record);
 const summary=JSON.parse(record.text);assert.equal(summary.questionsTotal,105);assert.equal(summary.questionsSummarized,100);assert.equal(summary.all.questionCount,100);assert.equal(summary.all.named.zeroInMeasuredAnswersQuestionCount,100);assert.match(summary.groupingRule,/does not mean branded/);
});
test('one-cycle never wording is flagged for review',()=>{
 assert.ok(analysisReviewWarnings({title:'Most questions never name the brand'}).some(s=>s.includes('one measured sample')));
});
