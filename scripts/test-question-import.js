import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reviewQuestionItems,importQuestionItems,setSelectedQuestionStatus} from '../src/lib/question-import.js';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
await db.exec(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
await db.exec(`INSERT INTO orgs(id,name) VALUES(1,'Owner'),(2,'Other');
 INSERT INTO projects(id,org_id,name,domain,brand_name) VALUES(1,1,'One','one.test','One'),(2,2,'Two','two.test','Two');`);
const pool={connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
const add=items=>importQuestionItems({projectId:1,orgId:1,items,limit:100,source:'generated'},pool);
test('preview identifies whitespace/case duplicates including paused questions without writing',()=>{
 const rows=reviewQuestionItems('Who are the best tyre shops?\nWHO ARE THE BEST TYRE SHOPS?\nshort',[{text:'Who are the best tyre shops?',active:false}]);
 assert.equal(rows[0].duplicate,true);assert.equal(rows[1].duplicate,true);assert.ok(rows[2].error);
});
test('reviewed import keeps metadata and does not create measurements',async()=>{
 const result=await add([{text:'Who are the best tyre shops in Dubai?',language:'en',city:'Dubai',cluster:'tyres',intent:'discovery'}]);
 assert.equal(result.added,1);
 const p=await one('SELECT * FROM prompts WHERE project_id=1');
 assert.equal(p.source,'generated');assert.equal(p.ai_search_volume,null);assert.equal(p.origin_details.city,'Dubai');assert.equal(p.origin_details.language,'en');
 assert.equal((await one('SELECT COUNT(*)::int n FROM runs')).n,0);
 assert.equal((await one('SELECT COUNT(*)::int n FROM measurement_batches')).n,0);
 assert.equal((await one('SELECT COUNT(*)::int n FROM prompt_events')).n,1);
 const repeat=await add(['Who are the best tyre shops in Dubai?']);assert.equal(repeat.added,0);assert.equal(repeat.duplicates,1);
});
test('capacity and cross-account failures leave the entire set unchanged',async()=>{
 const n=(await one('SELECT COUNT(*)::int n FROM prompts')).n;
 await assert.rejects(importQuestionItems({projectId:1,orgId:1,limit:2,items:['Where can I buy tyres in Dubai?','When should I change my tyres?']},pool),e=>e.status===402);
 await assert.rejects(importQuestionItems({projectId:1,orgId:2,limit:10,items:['Where can I buy tyres in Dubai?']},pool),e=>e.status===404);
 assert.equal((await one('SELECT COUNT(*)::int n FROM prompts')).n,n);
});
test('an audit failure rolls back every new question',async()=>{
 const failing={connect:async()=>({query:(sql,args)=>{if(sql.includes('INSERT INTO prompt_events'))throw Error('audit unavailable');return db.query(sql,args);},release(){}})};
 await assert.rejects(importQuestionItems({projectId:1,orgId:1,limit:100,items:['Where can I buy tyres in Dubai?']},failing),/audit unavailable/);
 assert.equal((await one('SELECT COUNT(*)::int n FROM prompts')).n,1);
});
test('selected status changes affect only owned selected questions and enforce limits',async()=>{
 await add(['Where can I buy tyres in Dubai?']);
 const own=(await db.query('SELECT id FROM prompts WHERE project_id=1 ORDER BY id')).rows;
 const foreign=await one("INSERT INTO prompts(project_id,text) VALUES(2,'Which tyre shop should I choose?') RETURNING id");
 const result=await setSelectedQuestionStatus({projectId:1,orgId:1,ids:[own[0].id,foreign.id],active:false,limit:100},pool);
 assert.equal(result.changed,1);
 assert.equal((await one('SELECT active FROM prompts WHERE id=$1',[own[1].id])).active,true);
 assert.equal((await one('SELECT active FROM prompts WHERE id=$1',[foreign.id])).active,true);
 await assert.rejects(setSelectedQuestionStatus({projectId:1,orgId:1,ids:[own[0].id],active:true,limit:1},pool),e=>e.status===402);
 assert.equal((await one('SELECT active FROM prompts WHERE id=$1',[own[0].id])).active,false);
});
test('superseded historical questions cannot be resumed in bulk',async()=>{
 const old=await one('SELECT id FROM prompts WHERE project_id=1 AND NOT active LIMIT 1');
 await db.query("INSERT INTO prompts(project_id,text,revises_prompt_id) VALUES(1,'Which tyre shops serve Dubai motorists?',$1)",[old.id]);
 await assert.rejects(setSelectedQuestionStatus({projectId:1,orgId:1,ids:[old.id],active:true,limit:100},pool),e=>e.status===400);
});
test.after(()=>db.close());
