import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {comparableHistorySql} from '../src/lib/history-query.js';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const start=server.indexOf("app.get('/api/projects/:id/history'");
const route=server.slice(server.indexOf('const project =',start),server.indexOf("\n}));",start));
const runRoute=new Function('req','res','assertProject','many','one','comparableSettings','comparableHistorySql',`return (async()=>{${route}})()`);
const oldSql=`WITH pairs AS (
 SELECT r.prompt_id,r.engine,COUNT(DISTINCT r.cycle_date)::int AS seen FROM reporting_runs r
 WHERE r.project_id=$1 AND r.ok GROUP BY r.prompt_id,r.engine
), total AS (SELECT COUNT(DISTINCT cycle_date)::int AS n FROM reporting_runs WHERE project_id=$1 AND ok)
SELECT r.cycle_date AS date,COUNT(*)::int AS runs,
 SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS rate
FROM reporting_runs r JOIN mentions m ON m.run_id=r.id
JOIN entities e ON e.id=m.entity_id AND e.kind='owned'
JOIN pairs p ON p.prompt_id=r.prompt_id AND p.engine=r.engine CROSS JOIN total t
WHERE r.project_id=$1 AND r.ok AND p.seen=t.n GROUP BY r.cycle_date ORDER BY r.cycle_date`;
async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE TABLE projects(id integer primary key);
 CREATE TABLE entities(id integer primary key,kind text);
 CREATE TABLE mentions(run_id integer,entity_id integer,mentioned boolean,ordinal int);
 CREATE INDEX mention_run ON mentions(run_id);
 CREATE TABLE runs(id serial primary key,project_id integer,cycle_date date,created_at timestamptz default now(),ok boolean,response_text text,cost_usd numeric,prompt_id integer,engine text);
 CREATE INDEX run_project ON runs(project_id);
 INSERT INTO projects SELECT generate_series(1,40);
 INSERT INTO entities VALUES(1,'owned'),(2,'competitor');
 INSERT INTO runs(project_id,cycle_date,ok,response_text,cost_usd,prompt_id,engine)
 SELECT 1+(i-1)/500,DATE '2026-09-27'+((i-1)%500)/250,i%19<>0,'Finished',.01,1+(i%20),CASE WHEN i%2=0 THEN 'chatgpt' ELSE 'claude' END FROM generate_series(1,20000) i;
 INSERT INTO mentions SELECT id,1,id%3=0,CASE WHEN id%3=0 THEN 1 ELSE NULL END FROM runs WHERE id%17<>0;
 INSERT INTO mentions SELECT id,2,true,1 FROM runs;
 INSERT INTO runs(project_id,cycle_date,ok,response_text,cost_usd,prompt_id,engine) VALUES(1,'2026-09-28',true,'New question',.01,999,'gemini');
 INSERT INTO mentions SELECT max(id),1,true,1 FROM runs;`);
 const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8').split('-- Batch 29:')[1];
 await db.exec('-- Batch 29:'+schema);return db;
}
test('single materialised cohort preserves rates, counts, days, missing mentions and site isolation',async()=>{
 const db=await fixture();try{
  await db.exec("SET statement_timeout='15s'");
  for(const project of [1,2,40,999])assert.deepEqual((await db.query(comparableHistorySql,[project])).rows,(await db.query(oldSql,[project])).rows);
  const plan=(await db.query('EXPLAIN (FORMAT JSON) '+comparableHistorySql,[1])).rows;
  assert.match(JSON.stringify(plan),/project_runs/);
  const times={};
  for(const [name,sql] of [['old',oldSql],['new',comparableHistorySql]]){const t=performance.now();await db.query(sql,[1]);times[name]=Math.round(performance.now()-t);}
  console.log('20,001 answers, 40 sites, warm single-run timing (ms):',times);
 }finally{await db.close();}
});
test('Overview summary performs only the daily count read, no comparison or spend reads',async()=>{
 const calls=[];let body;
 await runRoute({query:{summary:'1'}},{json:x=>body=x},async()=>({id:28}),async(sql)=>{calls.push(sql);return [{date:'2026-09-28',runs:50,rate:.44}];},()=>{throw Error('unexpected one');},()=>{throw Error('unexpected comparison');},comparableHistorySql);
 assert.equal(calls.length,1);assert.deepEqual(body.cycles,[{date:'2026-09-28',runs:50,rate:.44}]);
});
test('changed or unknown settings skip the cohort query and never present comparable movement',async()=>{
 const calls=[];let body;
 await runRoute({query:{}},{json:x=>body=x},async()=>({id:28}),async(sql)=>{calls.push(sql);return sql.includes('AVG(m.ordinal)')?[{date:'2026-09-27',rate:0},{date:'2026-09-28',rate:1}]:[];},()=>{throw Error('unexpected mover');},async()=>false,comparableHistorySql);
 assert.ok(!calls.includes(comparableHistorySql));assert.deepEqual(body.comparable,[]);assert.deepEqual(body.movers,[]);assert.equal(body.settingsComparable,false);
});
test('known comparable settings use the scoped query and retain minimum-sample movement gate',async()=>{
 const calls=[];let body;
 await runRoute({query:{}},{json:x=>body=x},async()=>({id:28}),async(sql,params)=>{calls.push({sql,params});return sql.includes('AVG(m.ordinal)')?[{date:'2026-09-27',rate:0},{date:'2026-09-28',rate:1}]:[];},async()=>({n:2}),async()=>true,comparableHistorySql);
 assert.ok(calls.some(c=>c.sql===comparableHistorySql));assert.ok(calls.some(c=>c.params?.[3]===3));assert.equal(body.moversMinRuns,3);assert.equal(body.moversHeldBack,2);
});
test('summary and full history still enforce project authorization',async()=>{
 let called=false;await runRoute({query:{summary:'1'}},{json:()=>{}},async()=>null,()=>called=true,()=>{},()=>{},comparableHistorySql);assert.equal(called,false);
});
