import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {completionEmail,cleanCompetitors,mountQuickControls} from '../src/lib/quick-start-controls.js';
import {validateQuickQuestions} from '../src/lib/quick-start.js';
const {PGlite}=await import(process.env.PGLITE_MODULE);
const db=new PGlite();await db.exec(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
const query=(sql,args)=>db.query(sql,args),many=async(sql,args)=>(await query(sql,args)).rows,one=async(sql,args)=>(await many(sql,args))[0];
await db.exec("INSERT INTO orgs(id,name) VALUES(1,'Test'),(2,'Other'); INSERT INTO users(id,org_id,email,password_hash,email_verified_at) VALUES(1,1,'one@example.com','test',now()),(2,1,'two@example.com','test',now()),(3,2,'other@example.com','test',now()),(4,1,'unverified@example.com','test',null); INSERT INTO projects(id,org_id,name,domain,brand_name) VALUES(1,1,'Test','example.com','Test'); INSERT INTO quick_start_preferences(project_id,user_id,email_when_done) VALUES(1,1,true),(1,2,false),(1,3,true),(1,4,true)");
test('completion emails require opt-in, verification, same tenant and are deduplicated',async()=>{
 const sent=[],started=new Date(Date.now()-1000);const deps={many,query,send:async(to)=>{sent.push(to);return true;}};
 await completionEmail({id:1,org_id:1,name:'Test'},started,deps);await completionEmail({id:1,org_id:1,name:'Test'},started,deps);
 assert.deepEqual(sent,['one@example.com']);
});
test('failed delivery remains eligible for a retry',async()=>{
 await query('UPDATE quick_start_preferences SET notified_at=NULL WHERE user_id=1');
 await completionEmail({id:1,org_id:1,name:'Test'},new Date(),{many,query,send:async()=>false});
 assert.equal((await one('SELECT notified_at FROM quick_start_preferences WHERE user_id=1')).notified_at,null);
});
test('competitor validation rejects duplicate names and excessive lists',()=>{
 assert.throws(()=>cleanCompetitors([{name:'Example'},{name:'example'}]));assert.throws(()=>cleanCompetitors(Array(16).fill({name:'x'})));
 assert.equal(cleanCompetitors([{name:'Other',domain:'https://www.other.com/'}])[0].domain,'other.com');
});
const routes=new Map();let aiCalls=0,discoverCalls=0;
mountQuickControls({get:(p,...h)=>routes.set(p,h.at(-1)),post:(p,...h)=>routes.set(p,h.at(-1))},{requireAuth:()=>{},assertProject:async(req,res)=>{if(req.session.orgId!==1){res.status(404).json({error:'Not found'});return null;}return one('SELECT * FROM projects WHERE id=1');},many,one,query,pool:{connect:async()=>({query,release(){}})},discover:async()=>{discoverCalls++;return {competitors:[{name:'Other agency',domain:'otheragency.com'}]};},validateQuestions:validateQuickQuestions,completeText:async()=>{aiCalls++;return JSON.stringify({items:Array.from({length:20},(_,i)=>`Who offers service ${i+1} in Dubai?`)});}});
async function request(tail,body,orgId=1){const res={code:200,status(c){this.code=c;return this;},json(b){this.body=b;}};await routes.get('/api/projects/:id/quick-start/'+tail)({params:{id:1},session:{userId:1,orgId},body},res,e=>{throw e;});return res;}
test('AI returns a preview without altering questions and refuses cross-tenant access',async()=>{
 const body={scope:'questions',instruction:'Focus on Dubai',items:Array.from({length:20},(_,i)=>`Who offers service ${i+1} in UAE?`)};
 const before=await one('SELECT count(*)::int AS n FROM prompts');
 assert.equal((await request('assistant',body,2)).code,404);assert.equal(aiCalls,0);
 const result=await request('assistant',body);assert.equal(result.code,200);assert.equal(result.body.items.length,20);
 assert.deepEqual(await one('SELECT count(*)::int AS n FROM prompts'),before);
});
test('AI daily quota prevents extra model calls',async()=>{
 await query('INSERT INTO quick_start_ai_requests(user_id) SELECT 1 FROM generate_series(1,20)');const before=aiCalls;
 const result=await request('assistant',{scope:'competitors',instruction:'Remove Clutch',items:[{name:'Clutch',domain:'clutch.co'}]});
 assert.equal(result.code,429);assert.equal(aiCalls,before);
});

test.after(()=>db.close());

import {selectedEntities} from '../src/lib/quick-start-selection.js';
test('future scans exclude removed competitors while retaining owned entities',()=>{
 const entities=[{name:'Our brand',kind:'owned'},{name:'Clutch',kind:'competitor'},{name:'Agency',kind:'competitor'}];
 assert.deepEqual(selectedEntities({quick_start_options:{competitors:[{name:'agency'}]}},entities).map(e=>e.name),['Our brand','Agency']);
 assert.equal(selectedEntities({},entities).length,3);
});

test('competitor discovery is tenant scoped, cached and remains a draft',async()=>{
 assert.equal((await request('competitor-suggestions',{},2)).code,404);assert.equal(discoverCalls,0);
 const first=await request('competitor-suggestions',{});assert.equal(first.body.competitors[0].name,'Other agency');
 await request('competitor-suggestions',{});assert.equal(discoverCalls,1);
 assert.equal((await one("SELECT count(*)::int AS n FROM entities WHERE kind='competitor'")).n,0);
 await query("UPDATE projects SET quick_start_options=jsonb_set(quick_start_options,'{competitors}','[]'::jsonb) WHERE id=1");
 assert.deepEqual((await request('competitor-suggestions',{})).body.competitors,[]);assert.equal(discoverCalls,1);
});
