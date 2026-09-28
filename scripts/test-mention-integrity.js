import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyseRun } from '../src/lib/analyze.js';
import { repairMentions } from '../src/lib/repair-mentions.js';
const brand={id:1,name:'The Family Office',domain:'tfoco.com',aliases:['TFOCO'],ambiguous_name:true,kind:'owned'};
const rival={id:2,name:'Jadwa',domain:'jadwa.com',aliases:[],kind:'competitor'};
const check=async text => (await analyseRun({text,entities:[brand]}))[0];
for (const [name,text] of [
 ['Google numeric citation','Educational text [[3]](https://tfoco.com/en/article).'],
 ['brand in destination path','Read [source](https://example.com/The-Family-Office?brand=TFOCO).'],
 ['nested destination and title','Read [source](https://tfoco.com/a_(b) "The Family Office").'],
 ['reference definition','Read [1].\n\n[1]: https://tfoco.com/page "The Family Office"'],
 ['reference link','Read [source][ref].\n[ref]: https://tfoco.com/page'],
 ['image metadata','![The Family Office](https://tfoco.com/logo.png)'],
 ['HTML attribute','<a href="https://tfoco.com" title="The Family Office">Source</a>'],
 ['quoted closing parenthesis','Read [1](https://example.com "title ) The Family Office").'],
 ['quoted HTML delimiter','<a title="x > The Family Office" href="https://tfoco.com">source</a>'],
 ['bare URL','Read https://tfoco.com/page for details.'],
 ['domain path','Read tfoco.com/en/sa for details.'],
 ['URL-only link label','[tfoco.com](https://tfoco.com)'],
 ['autolink','See <https://tfoco.com>.'],
 ['truncated link destination','Read [source](https://tfoco.com/a_(b'],
 ['common phrase','The family office model helps families.']
]) test(`not named: ${name}`,async()=>{assert.equal((await check(text)).mentioned,false);assert.equal((await check(text)).snippet,null);});
for(const text of ['The Family Office serves investors.','[The Family Office](https://tfoco.com)','[**The Family Office**](https://tfoco.com/a_(b))','<a href="https://tfoco.com">The Family Office</a>','[The Family Office][ref]\n[ref]: https://tfoco.com','TFOCO serves families.','See tfoco.com for details.'])
 test(`literal name retained: ${text}`,async()=>assert.equal((await check(text)).mentioned,true));
test('hidden URL cannot take first place or drive the snippet',async()=>{
 const rows=await analyseRun({text:'[1](https://tfoco.com). Jadwa is listed. The Family Office follows.',entities:[brand,rival]});
 assert.equal(rows[0].ordinal,2);assert.equal(rows[1].ordinal,1);assert.doesNotMatch(rows[0].snippet,/https/);
});
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
async function fixture(){
 const db=new PGlite(); await db.exec(`
 CREATE TABLE projects(id int primary key,name text);
 CREATE TABLE entities(id int primary key,project_id int,name text,domain text,aliases text[],ambiguous_name boolean,kind text);
 CREATE TABLE runs(id int primary key,project_id int,ok boolean,response_text text,cycle_date date);
 CREATE TABLE mentions(run_id int,entity_id int,mentioned boolean,ordinal int,sentiment text,snippet text);
 CREATE TABLE method_notes(id serial,project_id int,note text,detail text);
 CREATE TABLE citations(run_id int,domain text);
 INSERT INTO projects VALUES(27,'TFO');
 INSERT INTO entities VALUES(1,27,'The Family Office','tfoco.com','{}',true,'owned'),(2,27,'Jadwa','jadwa.com','{}',false,'competitor');
 INSERT INTO runs VALUES(1,27,true,'[1](https://tfoco.com). Jadwa is listed.','2026-09-28'),(2,27,false,'bad','2026-09-28'),(3,27,true,NULL,'2026-09-28'),(4,27,true,'The Family Office','2026-09-28'),(5,27,true,'Jadwa, then The Family Office.','2026-09-28');
 INSERT INTO mentions VALUES(1,1,true,1,'positive','old'),(1,2,true,2,'positive','old'),(2,1,false,NULL,NULL,NULL),(3,1,true,1,'neutral','retained'),(5,1,true,1,'neutral','old');
 INSERT INTO citations VALUES(1,'tfoco.com');`);return db;
}
test('dry run is read only; apply is atomic, cohort-safe and idempotent',async()=>{
 const db=await fixture();try{
 const before=(await db.query('SELECT * FROM mentions ORDER BY run_id,entity_id')).rows;
 const s=await repairMentions(db,27);assert.equal(s.ownedBefore,2);assert.equal(s.ownedAfter,1);assert.equal(s.ownedMeasured,2);
 assert.deepEqual((await db.query('SELECT * FROM mentions ORDER BY run_id,entity_id')).rows,before);
 await repairMentions(db,27,{apply:true});
 const rows=(await db.query('SELECT * FROM mentions ORDER BY run_id,entity_id')).rows;
 assert.deepEqual(rows[0],{run_id:1,entity_id:1,mentioned:false,ordinal:null,sentiment:null,snippet:null});
 assert.equal(rows[1].ordinal,1);assert.equal(rows[1].sentiment,'positive');
 assert.deepEqual(rows[2],before[2]);assert.deepEqual(rows[3],before[3]);
 assert.equal(rows[4].ordinal,1,'unmeasured historical rival must not affect ordinal');
 assert.equal(rows.length,5,'no missing measurement invented');
 assert.equal((await db.query('SELECT * FROM citations')).rows[0].domain,'tfoco.com');
 assert.equal((await repairMentions(db,27,{apply:true})).changed,0);
 assert.equal((await db.query('SELECT * FROM method_notes')).rows.length,1);
 }finally{await db.close();}
});
test('failure to write the method note rolls back every correction',async()=>{
 const db=await fixture();try{
 const before=(await db.query('SELECT * FROM mentions ORDER BY run_id,entity_id')).rows;
 const failing={query:(sql,args)=>{if(sql.startsWith('INSERT INTO method_notes'))throw new Error('note failure');return db.query(sql,args);}};
 await assert.rejects(()=>repairMentions(failing,27,{apply:true}),/note failure/);
 assert.deepEqual((await db.query('SELECT * FROM mentions ORDER BY run_id,entity_id')).rows,before);
 }finally{await db.close();}
});
