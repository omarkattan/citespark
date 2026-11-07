import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mountQuickStart} from '../src/lib/quick-start.js';
import {schemaUpgrades} from '../src/db/upgrades.js';
const {PGlite}=await import(process.env.PGLITE_MODULE);
const db=new PGlite();
const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8');
await db.exec(schema);
const q=async(sql,args)=>{const r=await db.query(sql,args);return {...r,rowCount:/^SELECT/i.test(sql)?r.rows.length:(r.affectedRows??r.rows.length)};};
const one=async(sql,args)=>(await q(sql,args)).rows[0];
const many=async(sql,args)=>(await q(sql,args)).rows;
await db.exec("INSERT INTO orgs(id,name,quick_start_enabled) VALUES(1,'Quick account',true),(2,'Other account',false); INSERT INTO projects(id,org_id,name,domain,brand_name,category,market,quick_start) VALUES(1,1,'Example','example.com','Example','accountants','AE',true),(2,2,'Other','other.com','Other','accountants','AE',true)");
const routes=new Map();
mountQuickStart({get:(path,...handlers)=>routes.set('GET '+path,handlers.at(-1)),post:(path,...handlers)=>routes.set('POST '+path,handlers.at(-1))},{requireAuth:()=>{},assertProject:async(req,res)=>{const p=await one('SELECT * FROM projects WHERE id=$1 AND org_id=$2',[req.params.id,req.session.orgId]);if(!p)res.status(404).json({error:'Not found'});return p;},getEntitlements:async()=>({advanced:false}),query:q,one,many,generate:async()=>Array.from({length:20},(_,i)=>({text:`Which providers offer accounting service ${i} in Abu Dhabi?`,cluster:'discovery',intent:'discovery'})),pool:{connect:async()=>({query:q,release:()=>{}})}});
async function request(path,body,id=1){const res={code:200,status(c){this.code=c;return this;},json(b){this.body=b;return this;}};await routes.get(path)({params:{id},session:{orgId:1},body},res,e=>{throw e;});return res;}
const questions=Array.from({length:20},(_,i)=>`Which accountants provide service ${i} in Dubai?`);
test('new schema supports Quick Start and upgrade hash matches the actual schema',async()=>{
 const last=schemaUpgrades.at(-1);assert.equal(last.to,createHash('sha256').update(schema).digest('hex'));
 await db.exec(last.steps[0].sql); // safe to retry
 assert.equal((await one('SELECT quick_start_enabled FROM orgs WHERE id=2')).quick_start_enabled,false);
});
test('question save is persisted, idempotent, and tenant scoped',async()=>{
 const path='POST /api/projects/:id/quick-start/questions';
 assert.equal((await request(path,{questions})).code,200);
 assert.equal((await request(path,{questions})).code,200);
 assert.equal((await one('SELECT count(*)::int AS n FROM prompts WHERE project_id=1 AND active')).n,20);
 assert.equal((await request(path,{questions},2)).code,404);
 const edited=[...questions];edited[0]='Who are the best accountants for retail businesses in Dubai?';
 assert.equal((await request(path,{questions:edited})).code,200);
 assert.equal((await one('SELECT count(*)::int AS n FROM prompts WHERE project_id=1 AND active')).n,20);
});
test('correcting business details replaces questions atomically before the first report',async()=>{
 const path='POST /api/projects/:id/quick-start/profile';
 const body={brandName:'Example New',category:'accounting',market:'AE',language:'en',locationName:'Abu Dhabi',qualifier:'Retailers'};
 assert.equal((await request(path,body,2)).code,404);
 assert.equal((await request(path,body)).code,200);
 const p=await one('SELECT * FROM projects WHERE id=1');
 assert.equal(p.brand_name,'Example New');assert.equal(p.location_name,'Abu Dhabi');
 const current=await many('SELECT text FROM prompts WHERE project_id=1 AND active');
 assert.equal(current.length,20);assert.ok(current.every(p=>p.text.includes('Abu Dhabi')));
});
test('free report reservation cannot be duplicated or reset by deleting a project',async()=>{
 const sql='INSERT INTO quick_start_reports(org_id,project_id) VALUES($1,$2) ON CONFLICT(org_id) DO NOTHING RETURNING org_id';
 assert.equal((await q(sql,[1,1])).rows.length,1);
 assert.equal((await q(sql,[1,1])).rows.length,0);
 assert.equal((await request('POST /api/projects/:id/quick-start/questions',{questions})).code,409);
 assert.equal((await request('POST /api/projects/:id/quick-start/profile',{brandName:'No change',category:'accounting',market:'AE',language:'en'})).code,409);
 await q('DELETE FROM projects WHERE id=1');
 const claim=await one('SELECT * FROM quick_start_reports WHERE org_id=1');assert.ok(claim);assert.equal(claim.project_id,null);
});
test.after(()=>db.close());
