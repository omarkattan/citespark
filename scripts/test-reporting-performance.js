import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8');
test('project reads preserve snapshots and avoid global membership deduplication',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schema);
  await db.exec(`INSERT INTO orgs(id,name) VALUES(1,'Fixture');
   INSERT INTO projects(id,org_id,name,domain,brand_name) SELECT n,1,'Site '||n,n||'.test','Brand '||n FROM generate_series(1,51) n;
   INSERT INTO prompts(id,project_id,text) SELECT id,id,'Which providers should I choose?' FROM projects;
   INSERT INTO measurement_batches(id,project_id,cycle_date,status,completed_at)
    SELECT id,id,'2026-11-05','completed',now() FROM projects;
   INSERT INTO runs(project_id,prompt_id,engine,cycle_date,ok,response_text,measurement_id)
    SELECT p.id,p.id,'chatgpt','2026-11-05',true,repeat('Stored evidence. ',100),p.id
    FROM projects p CROSS JOIN generate_series(1,400) n WHERE p.id<>51;
   INSERT INTO runs(project_id,prompt_id,engine,cycle_date,ok,response_text,measurement_id)
    VALUES(51,51,'chatgpt','2026-11-05',true,'Small site',51);
   INSERT INTO measurement_members SELECT measurement_id,id FROM runs WHERE id%2=0;
   CREATE VIEW previous_reporting_runs AS SELECT r.* FROM runs r
    JOIN measurement_answers a ON a.run_id=r.id JOIN published_measurements b ON b.id=a.measurement_id;
   ANALYZE;`);
  const diff=await db.query(`(SELECT id FROM reporting_runs EXCEPT ALL SELECT id FROM previous_reporting_runs)
   UNION ALL (SELECT id FROM previous_reporting_runs EXCEPT ALL SELECT id FROM reporting_runs)`);
  assert.deepEqual(diff.rows,[],'direct + inherited membership counts stay identical');
  const plan=(await db.query('EXPLAIN (ANALYZE,FORMAT JSON) SELECT MAX(cycle_date) FROM reporting_runs WHERE project_id=51')).rows[0]['QUERY PLAN'][0];
  const nodes=[];const walk=n=>{nodes.push(n);for(const p of n.Plans||[])walk(p);};walk(plan.Plan);
  assert.equal(nodes.some(n=>n['Node Type']==='Aggregate' && n.Strategy==='Hashed' && (n['Actual Rows']||0)>1000),false);
  const scannedRuns=nodes.filter(n=>n['Relation Name']==='runs').reduce((n,p)=>n+(p['Actual Rows']+ (p['Rows Removed by Filter']||0))*(p['Actual Loops']||0),0);
  assert.ok(scannedRuns<100,`small-site query scanned ${scannedRuns} runs`);
  const oldPlan=(await db.query('EXPLAIN (ANALYZE,FORMAT JSON) SELECT MAX(cycle_date) FROM previous_reporting_runs WHERE project_id=51')).rows[0]['QUERY PLAN'][0];
  console.log(JSON.stringify({fixtureRuns:20001,beforeMs:oldPlan['Execution Time'],afterMs:plan['Execution Time'],scannedRuns}));
  // Exercise an upgrade on populated data, not just a fresh installation.
  await db.exec(`CREATE OR REPLACE VIEW reporting_runs AS SELECT r.* FROM runs r
   JOIN measurement_answers a ON a.run_id=r.id JOIN published_measurements b ON b.id=a.measurement_id;`);
  await db.exec(schema);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM reporting_runs')).rows[0].n,20001);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM runs')).rows[0].n,20001);
 } finally {await db.close();}
});
