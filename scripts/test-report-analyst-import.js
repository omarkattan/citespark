import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareBenchmarkDraft} from '../src/lib/report-analyst-import.js';
import {packetHash} from '../src/lib/report-analyst.js';
const packet={records:[{id:'scope',text:'165 measured answers'}]};
const analysis={findings:[{kind:'investigate',title:'Review attribution',observation:'A single measured cycle.',implication:'Further review needed.',action:'Inspect the answers.',done_when:'Review recorded.',follow_up:'Repeat comparable questions.',evidence:[{id:'scope',quote:'165 measured answers'}]}],limitations:['One cycle only.']};
const benchmark=()=>({status:'complete',packet:structuredClone(packet),evidence_hash:packetHash(packet),results:[{requestedModel:'claude-sonnet-5-5',status:'complete',cost:null,response:{model:'claude-sonnet-5-5',stop_reason:'end_turn',provider_id:'msg_test',usage:{input_tokens:10,output_tokens:20},raw:JSON.stringify(analysis)}}]});
test('saved response becomes reviewable without generating or approving',()=>{
 const b=benchmark(),r=prepareBenchmarkDraft(b,packet,'claude-sonnet-5-5');assert.deepEqual(r.analysis,analysis);assert.equal(r.response.provider_id,'msg_test');assert.equal(r.cost,null);assert.equal(r.approved_at,undefined);assert.deepEqual(b,benchmark());
});
test('changed report evidence and tampered saved packets are rejected',()=>{
 assert.throws(()=>prepareBenchmarkDraft(benchmark(),{...packet,version:2},'claude-sonnet-5-5'),/changed/);
 const b=benchmark();b.packet.records[0].text='different';assert.throws(()=>prepareBenchmarkDraft(b,packet,'claude-sonnet-5-5'),/integrity/);
});
test('failed, truncated and missing responses cannot be imported',()=>{
 for(const edit of [b=>b.status='running',b=>b.results[0].status='failed',b=>b.results[0].response.stop_reason='max_tokens',b=>b.results[0].response.provider_id=null]){const b=benchmark();edit(b);assert.throws(()=>prepareBenchmarkDraft(b,packet,'claude-sonnet-5-5'));}
 assert.throws(()=>prepareBenchmarkDraft(benchmark(),packet,'other'));
});
test('import revalidates raw quotes rather than trusting prior parsed analysis',()=>{
 const b=benchmark();const invalid=structuredClone(analysis);invalid.findings[0].evidence[0].quote='invented evidence';b.results[0].response.raw=JSON.stringify(invalid);b.results[0].analysis=analysis;assert.throws(()=>prepareBenchmarkDraft(b,packet,'claude-sonnet-5-5'),/unverified/);
});
