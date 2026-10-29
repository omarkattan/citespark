import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db=new PGlite();
const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
await db.exec("CREATE TABLE users(id serial primary key,org_id integer,email text,password_hash text); INSERT INTO users(org_id,email) VALUES(1,'existing@example.test');");
const migration=schema.match(/ALTER TABLE users ADD COLUMN IF NOT EXISTS product_tour_status[\s\S]*?;/)[0];
await db.exec(migration);await db.exec(migration);
test('repeatable migration leaves existing users opt-in and actual registration SQL marks new users pending',async()=>{
 const sql=server.match(/"(INSERT INTO users \(org_id, email, password_hash, product_tour_status\)[^"]+)"/)[1];
 await db.query(sql,[2,'new@example.test','test-hash']);
 assert.deepEqual((await db.query('SELECT product_tour_status FROM users ORDER BY id')).rows.map(r=>r.product_tour_status),['not_required','pending']);
});
let route;
const auth=()=>{},ctx=vm.createContext({app:{post:(path,...handlers)=>{route={path,handlers};}},requireAuth:auth,wrap:fn=>fn,query:(sql,params)=>db.query(sql,params)});
vm.runInContext(server.slice(server.indexOf("app.post('/api/product-tour'"),server.indexOf("app.post('/api/product-tour'" )+server.slice(server.indexOf("app.post('/api/product-tour'")).indexOf('\n}));')+6),ctx);
async function request(status,userId=1,json=true){const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};await route.handlers.at(-1)({is:()=>json,body:{status,userId:2},session:{userId}},res);return res;}
test('tour preference uses authentication and the session user, not a supplied account ID',async()=>{
 assert.equal(route.handlers[0],auth);assert.equal((await request('skipped')).code,200);
 assert.equal((await db.query('SELECT product_tour_status FROM users WHERE id=1')).rows[0].product_tour_status,'skipped');
 assert.equal((await db.query('SELECT product_tour_status FROM users WHERE id=2')).rows[0].product_tour_status,'pending');
});
test('only final tour statuses and JSON requests can be stored',async()=>{
 assert.equal((await request('pending')).code,400);assert.equal((await request('completed',1,false)).code,415);
 assert.equal((await request('completed')).code,200);
 assert.equal((await db.query('SELECT product_tour_status FROM users WHERE id=1')).rows[0].product_tour_status,'completed');
});
test.after(()=>db.close());
