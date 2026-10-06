import test from 'node:test';
import assert from 'node:assert/strict';
import {repairIncompleteAnswers} from '../src/lib/repair-incomplete-answers.js';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
async function fixture(){const db=new PGlite();await db.exec(`
CREATE TABLE projects(id int primary key,name text);INSERT INTO projects VALUES(24,'A'),(26,'B');
CREATE TABLE runs(id int,project_id int,ok boolean,response_text text,cost_usd numeric);INSERT INTO runs VALUES(1,24,true,'Here are providers:',.04),(2,24,true,'A full answer.',.03),(3,26,true,'Other providers:',.04);
CREATE TABLE mentions(run_id int,entity_id int,mentioned boolean);INSERT INTO mentions VALUES(1,1,false),(1,2,true),(2,1,false),(3,3,false);
CREATE TABLE citations(run_id int,url text);INSERT INTO citations VALUES(1,'https://example.com');
CREATE TABLE measurement_batches(id int,project_id int,settings jsonb);INSERT INTO measurement_batches VALUES(10,24,'{"model":"pin"}');
CREATE TABLE measurement_answers(measurement_id int,run_id int);INSERT INTO measurement_answers VALUES(10,1),(10,2);
CREATE TABLE method_notes(project_id int,note text,detail text);`);return db;}
test('targeted repair previews, archives, preserves raw evidence and is idempotent',async()=>{
const db=await fixture();try{
assert.equal((await repairIncompleteAnswers(db,24,[1])).verdicts,2);
assert.equal((await db.query('SELECT * FROM mentions')).rows.length,4);
await repairIncompleteAnswers(db,24,[1],{apply:true});
assert.equal((await db.query('SELECT * FROM mentions')).rows.length,2);
assert.equal((await db.query('SELECT * FROM runs')).rows.length,3);
assert.equal((await db.query('SELECT * FROM citations')).rows.length,1);
assert.equal((await db.query('SELECT SUM(cost_usd) AS cost FROM runs')).rows[0].cost,'0.11');
const audit=(await db.query('SELECT before_rows FROM measurement_repairs')).rows[0].before_rows;
assert.equal(audit.mentions.length,2);assert.equal(audit.batches[0].settings.model,'pin');
assert.match((await db.query('SELECT settings FROM measurement_batches')).rows[0].settings.answerEligibilityRepair,/batch-10/);
assert.equal((await repairIncompleteAnswers(db,24,[1],{apply:true})).verdicts,0);
assert.equal((await db.query('SELECT * FROM measurement_repairs')).rows.length,1);
}finally{await db.close();}});
test('wrong project, complete text and write failures cannot partially repair evidence',async()=>{
const db=await fixture();try{
for(const ids of [[3],[2],[1,999]])await assert.rejects(()=>repairIncompleteAnswers(db,24,ids,{apply:true}));
const failing={query:(sql,args)=>{if(sql.startsWith('INSERT INTO method_notes'))throw Error('write failure');return db.query(sql,args);}};
await assert.rejects(()=>repairIncompleteAnswers(failing,24,[1],{apply:true}),/write failure/);
assert.equal((await db.query('SELECT * FROM mentions')).rows.length,4);
assert.deepEqual((await db.query('SELECT settings FROM measurement_batches')).rows[0].settings,{model:'pin'});
}finally{await db.close();}});
