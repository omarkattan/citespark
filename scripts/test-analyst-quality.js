import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {qualitySignals,qualityReference,reviewSavedAnalysis} from '../src/lib/report-analyst-quality.js';
const packet={records:[{id:'scope',text:JSON.stringify({measurement:50,engineCoverage:[{engine:'chatgpt',measured:20,failed:0},{engine:'gemini',measured:0,failed:12},{engine:'ai_mode',measured:16,failed:4}]})},{id:'traffic',text:'{"state":"disconnected","total":null}'}]};
const fixture=JSON.parse(readFileSync(new URL('./fixtures/analyst-quality-cases.json',import.meta.url)));
for(const c of fixture.cases)test(c.id,()=>{
 assert.deepEqual(qualitySignals({findings:[{action:c.text}]},packet).map(s=>s.rule),c.expected);
});
test('review is repeatable, keeps missing values unknown and never auto-approves',()=>{
 const row={id:10,packet,stop_reason:'end_turn',raw_response:'{"findings":[]}'};
 const a=reviewSavedAnalysis(row);assert.deepEqual(a,reviewSavedAnalysis(row));
 assert.equal(a.structuralStatus,'blocked');assert.equal(a.editorialStatus,'not_reviewed');assert.equal(a.rubric.length,5);
 assert.equal(qualityReference(packet).naming,null);assert.equal(qualityReference(packet).traffic.state,'disconnected');
 assert.match(a.limitations,/not a quality pass/);
});
test('invalid JSON and incomplete responses remain blocked with hashes',()=>{
 for(const row of [{raw_response:'{"findings": "unescaped "quote""}',stop_reason:'end_turn'},{raw_response:'{}',stop_reason:'max_tokens'}]){
  const r=reviewSavedAnalysis({...row,packet});assert.equal(r.structuralStatus,'blocked');assert.equal(r.responseHash.length,64);
 }
});
