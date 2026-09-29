import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {repairQuestionSample} from '../src/lib/repair-question-sample.js';
import {reportEvidence} from '../src/lib/report-evidence.js';
const {PGlite}=await import(process.env.PGLITE_MODULE);
async function fixture(){
 const db=new PGlite();await db.exec(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
 await db.exec(`INSERT INTO orgs(id,name) VALUES(1,'Test');
 INSERT INTO projects(id,org_id,name,domain,brand_name) VALUES(28,1,'Bank','bank.test','Bank');
 INSERT INTO entities(id,project_id,name,domain,kind) VALUES(1,28,'Bank','bank.test','owned');
 INSERT INTO prompts(id,project_id,text,active,created_at,revises_prompt_id) VALUES
 (1,28,'Old wording',false,'2026-09-29T10:00Z',NULL),
 (2,28,'Revised wording',true,'2026-09-29T11:00Z',1),
 (3,28,'Unchanged question',false,'2026-09-29T10:00Z',NULL),
 (4,28,'Future revision',true,'2026-09-29T13:00Z',3);
 INSERT INTO measurement_batches(id,project_id,cycle_date,status,started_at,completed_at,settings,collection_plan) VALUES
 (43,28,'2026-09-29','completed','2026-09-29T10:00Z','2026-09-29T10:30Z','{"engines":["chatgpt"],"runs":1}', '[{"prompt_id":1,"engine":"chatgpt","run_index":0},{"prompt_id":3,"engine":"chatgpt","run_index":0}]'),
 (44,28,'2026-09-29','completed','2026-09-29T12:00Z','2026-09-29T12:30Z','{"engines":["chatgpt"],"runs":1}', '[{"prompt_id":1,"engine":"chatgpt","run_index":0},{"prompt_id":2,"engine":"chatgpt","run_index":0},{"prompt_id":3,"engine":"chatgpt","run_index":0}]');
 SELECT setval('measurement_batches_id_seq',44);
 INSERT INTO runs(id,project_id,prompt_id,engine,cycle_date,ok,response_text,cost_usd,measurement_id) VALUES
 (1,28,1,'chatgpt','2026-09-29',true,'Bank old',.01,43),
 (2,28,2,'chatgpt','2026-09-29',false,'',.01,44),
 (3,28,3,'chatgpt','2026-09-29',true,'Bank unchanged',.01,43);
 INSERT INTO mentions(run_id,entity_id,mentioned) VALUES(1,1,true),(3,1,true);
 INSERT INTO measurement_members VALUES(44,1),(44,3);`);
 const adapter={query:(sql,args)=>sql.includes('pg_try_advisory_xact_lock')?Promise.resolve({rows:[{locked:true}]}):db.query(sql,args)};
 return {db,adapter};
}
test('repair previews, publishes a corrected sample, keeps historical snapshots and excludes only revisions existing at collection start',async()=>{
 const {db,adapter}=await fixture();try{
 const preview=await repairQuestionSample(adapter,28,44);assert.equal(preview.removedAnswers,1);assert.equal(preview.expected,2);assert.equal(preview.applied,false);
 assert.equal((await db.query('SELECT * FROM measurement_batches')).rows.length,2);
 const result=await repairQuestionSample(adapter,28,44,{apply:true});assert.equal(result.applied,true);
 const members=(await db.query('SELECT run_id FROM measurement_answers WHERE measurement_id=$1 ORDER BY run_id',[result.correctedId])).rows;
 assert.deepEqual(members.map(r=>r.run_id),[2,3]);
 assert.equal((await db.query('SELECT * FROM measurement_answers WHERE measurement_id=44')).rows.length,3);
 assert.equal((await db.query('SELECT * FROM runs')).rows.length,3);
 assert.equal(Number((await db.query('SELECT sum(cost_usd) AS cost FROM runs')).rows[0].cost),.03);
 const evidence=await reportEvidence(28,{from:null,to:null},async(s,p)=>(await db.query(s,p)).rows);
 assert.equal(Number(evidence.measurement.id),Number(result.correctedId));assert.equal(evidence.totals.measured,1);assert.equal(evidence.totals.named,1);
 assert.equal(evidence.measurement.collection_plan.length,2);
 await assert.rejects(repairQuestionSample(adapter,28,44,{apply:true}),/newer completed/);
 assert.equal((await db.query('SELECT * FROM measurement_batches')).rows.length,3);
 }finally{await db.close();}
});
test('future inheritance includes only active questions and keeps the prior sample immutable',async()=>{
 const {db}=await fixture();try{
 await db.exec('UPDATE prompts SET active=true WHERE id=3');
 const src=readFileSync(new URL('../src/lib/measurement-batches.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').replaceAll('export ','');
 const h=new Function('one','query','pool',src+';return {inheritMeasurement};')(async(s,p)=>(await db.query(s,p)).rows[0],(s,p)=>db.query(s,p),{});
 const {rows:[batch]}=await db.query(`INSERT INTO measurement_batches(project_id,cycle_date,status,settings,collection_plan) VALUES(28,'2026-09-29','running','{"engines":["chatgpt"],"runs":1}','[{"prompt_id":4,"engine":"chatgpt","run_index":0}]') RETURNING *`);
 await h.inheritMeasurement(batch,batch.settings);
 assert.deepEqual((await db.query('SELECT run_id FROM measurement_members WHERE measurement_id=$1 ORDER BY run_id',[batch.id])).rows.map(r=>r.run_id),[2,3]);
 const plan=(await db.query('SELECT collection_plan FROM measurement_batches WHERE id=$1',[batch.id])).rows[0].collection_plan;
 assert.deepEqual(plan.map(p=>p.prompt_id).sort(),[2,3,4]);
 assert.equal((await db.query('SELECT * FROM measurement_answers WHERE measurement_id=44')).rows.length,3);
 }finally{await db.close();}
});
test('repair refuses overlapping collection and rolls back a publication failure',async()=>{
 const {db,adapter}=await fixture();try{
 const blocked={query:(s,p)=>s.includes('pg_try_advisory_xact_lock')?Promise.resolve({rows:[{locked:false}]}):db.query(s,p)};
 await assert.rejects(repairQuestionSample(blocked,28,44,{apply:true}),/measurement is running/);
 const broken={query:(s,p)=>s.startsWith('INSERT INTO method_notes')?Promise.reject(Error('simulated write failure')):adapter.query(s,p)};
 await assert.rejects(repairQuestionSample(broken,28,44,{apply:true}),/simulated write/);
 assert.equal((await db.query('SELECT * FROM measurement_batches')).rows.length,2);
 assert.equal((await db.query('SELECT * FROM measurement_answers WHERE measurement_id=44')).rows.length,3);
 }finally{await db.close();}
});
