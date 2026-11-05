import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryPlan, inheritRecovery } from '../src/lib/measurement-recovery.js';

function fixture() {
  const prompts = Array.from({ length: 6 }, (_, i) => ({ id: i+1, text: `Question ${i+1}` }));
  const settings = { engines: ['chatgpt'], runs: 1, entities: [{id: 1},{id: 2}], models: {chatgpt:'pinned'}, maxTokens:2000 };
  const plan = prompts.map(p => ({prompt_id:p.id,text:p.text,engine:'chatgpt',run_index:0}));
  const rows = plan.slice(1).map((p,i) => ({...p,id:i+10,project_id:74,ok:true,response_text:'A full answer.',entity_ids:[1,2]}));
  rows[0].ok = false;
  rows[1].entity_ids = [1];
  rows[2].response_text = ''; rows[2].no_overview = true; rows[2].entity_ids = [];
  rows[3].response_text = 'Here are the providers:'; rows[3].entity_ids = [];
  return { source:{id:97,project_id:74,status:'failed',purpose:'monitoring',legacy:false,settings,collection_plan:plan},projectId:74,prompts,settings,rows };
}
test('recovery retries only missing, failed and incomplete slots and keeps original records', () => {
  const f=fixture(), before=structuredClone(f), r=recoveryPlan(f);
  assert.deepEqual(r.reasons,{missing:1,failed:1,incomplete:1});
  assert.deepEqual(r.jobs.map(j=>j.prompt.id),[1,2,3]);
  assert.deepEqual(r.inheritIds,[12,13,14]);
  assert.equal(r.plan.length,6); assert.deepEqual(f,before);
});
test('recovery refuses a different project, unknown settings, changed questions and ambiguous records', () => {
  const changes=[f=>f.projectId=75,f=>f.source.status='completed',f=>f.source.legacy=true,
    f=>f.source.purpose='experiment',f=>f.settings={...f.settings,maxTokens:700},f=>f.prompts[0].text='Changed',
    f=>f.prompts.push({id:99,text:'New'}),f=>f.source.collection_plan.push(f.source.collection_plan[0]),
    f=>f.rows.push(f.rows[0]),f=>f.rows[0].project_id=75,f=>f.source.collection_plan=null];
  for(const mutate of changes) {const f=fixture();mutate(f);assert.throws(()=>recoveryPlan(f));}
});
test('same number of wrong entity verdicts is incomplete, and fully saved zero naming stays valid',()=>{
  const f=fixture(); f.rows[4].entity_ids=[1,99]; assert.equal(recoveryPlan(f).reasons.incomplete,2);
  f.rows[4].entity_ids=[2,1]; assert.equal(recoveryPlan(f).reasons.incomplete,1);
});
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
test('inheritance preserves costs and source evidence while enforcing project scope',async()=>{
  const db=new PGlite();try{
    await db.exec(`CREATE TABLE runs(id int,project_id int,cost numeric); INSERT INTO runs VALUES(12,74,.03),(13,74,.02),(14,74,.04),(15,75,.09);
      CREATE TABLE measurement_answers(measurement_id int,run_id int); INSERT INTO measurement_answers VALUES(97,12),(97,13),(97,14),(97,15);
      CREATE TABLE measurement_members(measurement_id int,run_id int); CREATE TABLE method_notes(project_id int,note text,detail text);`);
    await inheritRecovery(db,{id:98,project_id:74},recoveryPlan(fixture()));
    assert.deepEqual((await db.query('SELECT run_id FROM measurement_members ORDER BY run_id')).rows.map(r=>r.run_id),[12,13,14]);
    assert.equal((await db.query('SELECT SUM(cost) AS cost FROM runs')).rows[0].cost,'0.18');
    assert.equal((await db.query('SELECT * FROM measurement_answers')).rows.length,4);
    assert.match((await db.query('SELECT detail FROM method_notes')).rows[0].detail,/not a new independent full scan/);
    await assert.rejects(inheritRecovery(db,{id:99,project_id:74},{...recoveryPlan(fixture()),inheritIds:[15]}),/evidence changed/);
  }finally{await db.close();}
});
