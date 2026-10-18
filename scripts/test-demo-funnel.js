import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createConversionStore} from '../src/lib/conversion.js';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
test('demo milestones retain one completed sample and exclude signed-in acquisition',async()=>{
 const db=new PGlite();
 try{
  await db.exec(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('../src/db/conversion.sql',import.meta.url),'utf8'));
  await db.exec("INSERT INTO orgs(id,name) VALUES(1,'Test');");
  const store=createConversionStore(db),signedIn={session:{userId:9,orgId:1}};
  await store.milestone(signedIn,'started','test.com');assert.equal(signedIn.session.demoJourney,undefined);
  const req={session:{}};
  await store.milestone(req,'started','example.com');await store.milestone(req,'started','example.com');
  await store.milestone(req,'result',{engine:'chatgpt',runs:3,mentions:1});
  await store.milestone(req,'result',{engine:'chatgpt',runs:3,mentions:1});await store.milestone(req,'signup_view');
  req.session.orgId=1;await store.milestone(req,'registered');
  const {rows}=await db.query('SELECT * FROM demo_journeys');assert.equal(rows.length,1);assert.equal(rows[0].org_id,1);assert.ok(rows[0].result_at);assert.ok(rows[0].registered_at);
 }finally{await db.close();}
});
