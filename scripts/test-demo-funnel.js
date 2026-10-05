import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const {PGlite}=await import(process.env.PGLITE_MODULE);
test('records milestones once, links registration and excludes signed-in testing',async()=>{
 const db=new PGlite();await db.exec('CREATE TABLE orgs(id integer PRIMARY KEY); INSERT INTO orgs VALUES(1);');
 const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8').split('-- Batch 112:')[1];await db.exec(schema.slice(schema.indexOf('CREATE TABLE')));
 let code=readFileSync(new URL('../src/lib/demo-funnel.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export async function','async function');
 const fn=new Function('query','randomUUID',code+';return demoMilestone;')((sql,args)=>db.query(sql,args),randomUUID);
 const testReq={session:{userId:9,orgId:1}};await fn(testReq,'started','test.com');assert.equal(testReq.session.demoJourney,undefined);
 const req={session:{}};await fn(req,'started','example.com');await fn(req,'started','example.com');await fn(req,'result');await fn(req,'result');await fn(req,'signup_view');req.session.orgId=1;await fn(req,'registered');
 const {rows}=await db.query('SELECT * FROM demo_journeys');assert.equal(rows.length,1);assert.equal(rows[0].org_id,1);assert.ok(rows[0].result_at);assert.ok(rows[0].registered_at);await db.close();
});
