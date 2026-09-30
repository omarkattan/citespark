import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvedReportQuestions,reviewedReportPriorities} from '../src/lib/report-decisions.js';
import {leadershipBrief} from '../src/lib/report-brief.js';
import {reportReadout} from '../src/lib/report-readout.js';
const measurement={started_at:'2026-09-29T16:00:00Z'};
const decision={type:'content_gap',prompt_id:'7',stage:'no_change',reviewed_at:'2026-09-29T18:00:00Z'};
test('exact question decisions close generic reviews without suppressing collection or page checks',()=>{
 const ps=[{reviewKind:'question_review',evidence:{questionId:7}},{reviewKind:'question_review',evidence:{questionId:8}},{owner:'Measurement owner'},{evidence:{questionId:7}}];
 assert.deepEqual(reviewedReportPriorities(ps,{decisions:[decision]},measurement),ps.slice(1));
 assert.equal(resolvedReportQuestions({decisions:[{...decision,stage:'ready'}]},measurement).has('7'),true);
});
test('new evidence, unknown timing, revised questions and source decisions remain open',()=>{
 for(const d of [{...decision,reviewed_at:'2026-09-28'},{...decision,reviewed_at:null},{...decision,stage:'investigate'},{...decision,type:'entity_authority'}])assert.equal(resolvedReportQuestions({decisions:[d]},measurement).size,0);
 assert.equal(resolvedReportQuestions({decisions:[decision]},{}).size,0);
 assert.equal(resolvedReportQuestions({decisions:[decision]},measurement).has('8'),false);
 assert.equal(resolvedReportQuestions({decisions:[decision,{...decision,type:'engine_gap',stage:'investigate'}]},measurement).size,0);
});
test('readout respects decisions but preserves measured totals and strengths',()=>{
 const q={id:7,text:'Documents?',measured:5,named:0,cited:2,engines:['chatgpt','claude']};
 const e={questions:[q],totals:{measured:5},measurement};
 const r=reportReadout(e,{decisions:[decision]});assert.equal(r.gap,null);assert.equal(r.strength.id,7);assert.equal(r.languages[0].measured,5);
});
test('stale copy is flagged in leadership brief without replacing saved content',()=>{
 const r={executive:{},review:{notes:[{title:'Saved',notes:'Old approved copy',outdated:true}]}};
 assert.match(leadershipBrief(r,{}).next,/before sharing/);assert.equal(r.review.notes[0].notes,'Old approved copy');
});
