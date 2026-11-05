import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {applySchema} from '../src/db/migrate.js';
import {schemaUpgrades} from '../src/db/upgrades.js';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8');
const previous=schema.replace(/CREATE OR REPLACE VIEW reporting_runs AS[\s\S]*?CREATE INDEX IF NOT EXISTS measurement_members_run ON measurement_members\(run_id,measurement_id\);/,
 `CREATE OR REPLACE VIEW reporting_runs AS
 SELECT r.* FROM runs r JOIN measurement_answers a ON a.run_id=r.id
 JOIN published_measurements b ON b.id=a.measurement_id;`);
const digest=sql=>createHash('sha256').update(sql).digest('hex');
const opts={upgrades:schemaUpgrades,log:()=>{},sleep:async()=>{}};
function adapter(db,calls) {
 return {connect:async()=>({query:async(sql,params)=>{
  calls.push(sql);
  if(sql===schema){await db.exec(sql);return {rows:[]};}
  return db.query(sql,params);
 },release:()=>{}})};
}
test('recorded production schema upgrades without historical backfills and retains direct/inherited answers',async()=>{
 assert.equal(digest(previous),schemaUpgrades[0].from);
 assert.equal(digest(schema),schemaUpgrades[0].to);
 const db=new PGlite(),calls=[];
 try {
  await db.exec(previous);
  await db.exec(`CREATE TABLE cited_schema_migrations(schema_hash TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
   INSERT INTO orgs(id,name) VALUES(1,'Fixture');
   INSERT INTO projects(id,org_id,name,domain,brand_name,runs_per_cycle) VALUES(1,1,'Fixture','example.test','Fixture',3);
   INSERT INTO prompts(id,project_id,text) VALUES(1,1,'Who are the best providers?');
   INSERT INTO measurement_batches(id,project_id,cycle_date,status,completed_at) VALUES
    (1,1,'2026-11-04','completed',now()),(2,1,'2026-11-05','completed',now());
   INSERT INTO runs(id,project_id,prompt_id,engine,cycle_date,ok,response_text,measurement_id) VALUES
    (1,1,1,'chatgpt','2026-11-04',true,'Inherited answer',1),
    (2,1,1,'chatgpt','2026-11-05',true,'Direct answer',2);
   INSERT INTO measurement_members VALUES(2,1),(2,2);`);
  await db.query('INSERT INTO cited_schema_migrations(schema_hash) VALUES($1)',[digest(previous)]);
  const before=(await db.query('SELECT id,response_text FROM reporting_runs ORDER BY id')).rows;
  const result=await applySchema(adapter(db,calls),schema,opts);
  assert.equal(result.applied,true);
  assert.ok(!calls.includes(schema));
  assert.ok(!calls.some(sql=>/^\s*(ALTER|UPDATE|DELETE)\b/i.test(sql)));
  assert.deepEqual((await db.query('SELECT id,response_text FROM reporting_runs ORDER BY id')).rows,before);
  assert.equal((await db.query('SELECT runs_per_cycle FROM projects')).rows[0].runs_per_cycle,3,'does not reset a customer-selected repeat count');
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM runs')).rows[0].n,2);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM pg_indexes WHERE indexname IN ('measurement_members_run','measurement_published_lookup')")).rows[0].n,2);
  calls.length=0;
  assert.equal((await applySchema(adapter(db,calls),schema,opts)).applied,false);
  assert.ok(!calls.some(sql=>sql.includes('CREATE OR REPLACE VIEW')));
 } finally {await db.close();}
});
test('fresh installations still apply the complete schema and create a receipt',async()=>{
 const db=new PGlite(),calls=[];
 try {
  assert.equal((await applySchema(adapter(db,calls),schema,opts)).applied,true);
  assert.ok(calls.includes(schema));
  assert.equal((await db.query('SELECT schema_hash FROM cited_schema_migrations')).rows[0].schema_hash,digest(schema));
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM reporting_runs')).rows[0].n,0);
 } finally {await db.close();}
});
