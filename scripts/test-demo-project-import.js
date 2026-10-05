import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {PGlite}=await import(process.env.PGLITE_MODULE);
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const start=server.indexOf('  const entitlements = setupEntitlements;');
const body=server.slice(start,server.indexOf('\n  res.json({ ok: true, project, promptsAdded: added, questionGenerationWarning });',start));
const run=new Function('query','demoQuestions','setupEntitlements','project','generatePrompts','generate','MARKET_NAMES',`return (async()=>{${body};return {added,questionGenerationWarning};})()`);
test('selected questions use allowance first, preserve exact wording and remain unmeasured',async()=>{
 const db=new PGlite();await db.exec(`CREATE TABLE prompts(id serial,project_id int,text text,cluster text,intent text,ai_search_volume int,source text DEFAULT 'generated',origin_details jsonb,UNIQUE(project_id,text));CREATE TABLE runs(prompt_id int);`);
 const q='Which agency suits a UAE ecommerce business?';let requested;
 const result=await run((s,p)=>db.query(s,p).then(r=>({...r,rowCount:r.affectedRows})),[q],{plan:{questions:3}},{id:1,market:'AE'},async({count})=>{requested=count;return [{text:q},{text:'A different buyer question?',cluster:'test',intent:'commercial',ai_search_volume:1}];},true,{});
 assert.equal(requested,2);const rows=(await db.query('SELECT * FROM prompts ORDER BY id')).rows;
 assert.equal(rows.length,2);assert.equal(rows[0].text,q);assert.equal(rows[0].ai_search_volume,null);assert.equal(rows[0].source,'custom');assert.equal(rows[0].origin_details.measurementImported,false);assert.equal((await db.query('SELECT * FROM runs')).rows.length,0);assert.equal(result.added,2);await db.close();
});
