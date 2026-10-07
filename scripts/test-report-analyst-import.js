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
test('unfinished, truncated and missing responses cannot be imported',()=>{
 for(const edit of [b=>b.status='running',b=>b.results[0].status='running',b=>b.results[0].response.stop_reason='max_tokens',b=>b.results[0].response.provider_id=null]){const b=benchmark();edit(b);assert.throws(()=>prepareBenchmarkDraft(b,packet,'claude-sonnet-5-5'));}
 assert.throws(()=>prepareBenchmarkDraft(benchmark(),packet,'other'));
});
test('import revalidates raw quotes rather than trusting prior parsed analysis',()=>{
 const b=benchmark();const invalid=structuredClone(analysis);invalid.findings[0].evidence[0].quote='invented evidence';b.results[0].response.raw=JSON.stringify(invalid);b.results[0].analysis=analysis;assert.throws(()=>prepareBenchmarkDraft(b,packet,'claude-sonnet-5-5'),/unverified/);
});

test('PostgreSQL JSONB round-trip preserves importability despite object key order',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();
 try{
  const current={version:'2',analysisPolicy:'test',project:{name:'Arada',id:31},records:[{id:'scope',label:'Scope',text:'165 measured answers'}],optional:undefined};
  const b=benchmark();b.packet=current;b.evidence_hash=packetHash(current);
  await db.exec('CREATE TABLE evidence(packet JSONB)');
  await db.query('INSERT INTO evidence VALUES($1)',[JSON.stringify(current)]);
  b.packet=(await db.query('SELECT packet FROM evidence')).rows[0].packet;
  assert.notEqual(packetHash(b.packet),b.evidence_hash,'test must reproduce the pre-fix order mismatch');
  assert.deepEqual(prepareBenchmarkDraft(b,current,'claude-sonnet-5-5').analysis,analysis);
 }finally{await db.close();}
});
test('array order, types and embedded evidence text remain integrity-sensitive',()=>{
 const current={records:[...packet.records,{id:'other',text:'another source'}],count:2};
 for(const edit of [b=>b.packet.records.reverse(),b=>b.packet.count='2',b=>b.packet.records[0].text='165 measured answers ']){
  const b=benchmark();b.packet=structuredClone(current);b.evidence_hash=packetHash(current);edit(b);
  assert.throws(()=>prepareBenchmarkDraft(b,current,'claude-sonnet-5-5'),/integrity/);
 }
});

test('previous validation failure is rechecked without changing saved status or skipping freshness',()=>{
 const b=benchmark();b.status='failed';b.results[0].status='failed';
 assert.deepEqual(prepareBenchmarkDraft(b,packet,'claude-sonnet-5-5').analysis,analysis);
 assert.equal(b.status,'failed');assert.equal(b.results[0].status,'failed');
 assert.throws(()=>prepareBenchmarkDraft(b,{...packet,version:9},'claude-sonnet-5-5'),/changed/);
 const bad=structuredClone(analysis);bad.findings[0].evidence[0].quote='fabricated quotation';b.results[0].response.raw=JSON.stringify(bad);
 assert.throws(()=>prepareBenchmarkDraft(b,packet,'claude-sonnet-5-5'),/unverified/);
});

function compatible(){
 const old={version:'2',sourceFingerprint:'unchanged',records:[{id:'scope',text:JSON.stringify({cycle:'2026-10-01',totals:{measured:165},engineCoverage:[]})}]};
 const b=benchmark();b.id=4;b.packet=old;b.evidence_hash=packetHash(old);
 const value=structuredClone(analysis);value.findings[0].evidence=[{id:'scope',quote:'"measured":165'}];b.results[0].response.raw=JSON.stringify(value);
 const current=structuredClone(old);current.version='5';current.records[0].text=JSON.stringify({cycle:'2026-10-01',totals:{measured:165},engineCoverage:[],measuredEngines:[]});current.records.push({id:'collection-notes',text:'{"notes":[]}'});
 return {b,current};
}
test('known additive format change preserves original evidence and revalidates current references',()=>{
 const {b,current}=compatible(),before=JSON.stringify(b);
 const r=prepareBenchmarkDraft(b,current,'claude-sonnet-5-5');
 assert.equal(r.evidenceHash,packetHash(current));assert.equal(r.provenance.originalEvidenceHash,b.evidence_hash);assert.equal(JSON.stringify(b),before);
 assert.deepEqual(r.packet,current);assert.equal(r.approved_at,undefined);
});
test('format reuse rejects changed data, new notes, tampering and unknown versions',()=>{
 for(const edit of [
  ({current})=>current.sourceFingerprint='changed',
  ({current})=>current.version='6',
  ({current})=>current.records[1].text='{"notes":[{"note":"new issue"}]}',
  ({current})=>current.records[0].text=current.records[0].text.replace('165','164'),
  ({b})=>b.packet.records[0].text='tampered',
  ({b})=>b.evidence_hash='wrong'
 ]){const x=compatible();edit(x);assert.throws(()=>prepareBenchmarkDraft(x.b,x.current,'claude-sonnet-5-5'));}
});

test('v2 engine coverage is retained and cannot be changed during format reuse',()=>{
 const {b,current}=compatible();
 assert.ok(JSON.parse(b.packet.records[0].text).engineCoverage);
 const scope=JSON.parse(current.records[0].text);scope.engineCoverage=[{engine:'chatgpt',measured:1}];current.records[0].text=JSON.stringify(scope);
 assert.throws(()=>prepareBenchmarkDraft(b,current,'claude-sonnet-5-5'),/integrity|verification/);
});

test('v2 benchmark hashed after JSONB reload survives format upgrade with exact value integrity',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();
 try {
  const {b,current}=compatible();
  await db.exec('CREATE TABLE packets(packet JSONB)');
  await db.query('INSERT INTO packets VALUES($1)',[JSON.stringify(b.packet)]);
  b.packet=(await db.query('SELECT packet FROM packets')).rows[0].packet;
  b.evidence_hash=packetHash(b.packet);
  const legacy=structuredClone(current);legacy.version='2';legacy.records=legacy.records.filter(r=>r.id!=='collection-notes');
  const scope=JSON.parse(legacy.records[0].text);delete scope.measuredEngines;legacy.records[0].text=JSON.stringify(scope);
  assert.notEqual(packetHash(legacy),b.evidence_hash);assert.deepEqual(legacy,b.packet);
  const result=prepareBenchmarkDraft(b,current,'claude-sonnet-5-5');
  assert.equal(result.evidenceHash,packetHash(current));assert.equal(result.provenance.originalEvidenceHash,b.evidence_hash);
  b.packet.records[0].text='tampered';b.evidence_hash=packetHash(b.packet);
  assert.throws(()=>prepareBenchmarkDraft(b,current,'claude-sonnet-5-5'),/integrity/);
 }finally{await db.close();}
});
