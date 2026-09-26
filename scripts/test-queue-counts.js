import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const db=new PGlite();
await db.exec(`CREATE TABLE recommendations (id int, project_id int,type text,status text,evidence jsonb,priority numeric,due_date date,assignee text);
CREATE TABLE projects(id int,org_id int); CREATE TABLE users(email text,org_id int);
INSERT INTO projects VALUES (1,1),(2,2);
INSERT INTO recommendations SELECT n,1,'content_gap',CASE WHEN n<=105 THEN 'open' ELSE 'done' END,'{"prompt_id":7}',1000-n,NULL,NULL FROM generate_series(1,110) n;
INSERT INTO recommendations VALUES (200,1,'source_gap','open','{}',1,NULL,NULL),(201,1,'source_gap','doing','{}',1,NULL,NULL),(202,1,'competitor_comparison','dismissed','{"prompt_id":9}',1,NULL,NULL),(203,1,'entity_authority','open','{}',1,NULL,NULL),(204,1,'engine_gap','doing','{"prompt_id":12}',1,NULL,NULL),(300,2,'content_gap','open','{}',1,NULL,NULL);`);
let handler;
const h=vm.createContext({app:{get:(_path,_auth,fn)=>handler=fn},requireAuth:()=>{},wrap:f=>f,assertProject:async()=>({id:1}),attachSourceReviews:async(_p,rows)=>rows,many:async(sql,args)=>(await db.query(sql,args)).rows,one:async(sql,args)=>(await db.query(sql,args)).rows[0]});
const start=server.indexOf("app.get('/api/projects/:id/recommendations'");vm.runInContext(server.slice(start,server.indexOf('\n/**',start)),h);
async function request(query){let result,code=200;await handler({query,session:{orgId:1}},{status:n=>{code=n;return {json:d=>result=d};},json:d=>result=d});return {result,code};}
test('server filters before the 100-card limit and counts the full selected focus',async()=>{
 const {result:r}=await request({status:'active',kind:'questions'});assert.equal(r.tasks.length,100);assert.equal(r.counts.open,105);assert.equal(r.counts.doing,1);assert.equal(r.counts.done,5);assert.equal(r.counts.total,111);assert.equal(r.focusCounts.questions,106);assert.equal(r.focusCounts.sources,2);assert.equal(r.focusCounts.all,109);
 assert.ok(r.tasks.every(t=>t.project_id===1 && t.type==='content_gap'));
});
test('source filter is not starved by a hundred higher-priority question tasks',async()=>{
 const {result:r}=await request({status:'active',kind:'sources'});assert.equal(r.tasks.length,2);assert.equal(r.counts.total,2);assert.equal(r.counts.open,1);assert.equal(r.counts.doing,1);
});
test('empty status still includes focus recovery counts and totals for other statuses',async()=>{
 const {result:r}=await request({status:'done',kind:'sources'});assert.equal(r.tasks.length,0);assert.equal(r.counts.total,2);assert.equal(r.focusCounts.questions,5);assert.equal(r.focusCounts.sources,0);
});
test('competitor classification takes precedence over a question id',async()=>{
 const {result:r}=await request({status:'dismissed',kind:'competitors'});assert.equal(r.tasks.length,1);assert.equal(r.counts.dismissed,1);
});
test('invalid status or focus is rejected',async()=>{
 assert.equal((await request({status:'bad'})).code,400);assert.equal((await request({status:'all',kind:"sources' OR true"})).code,400);
});
test('full queue uses server focus counts, scoped tabs and a limit notice',async()=>{
 const {result:data}=await request({status:'active',kind:'questions'});
 const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
 const v=vm.createContext({state:{projectId:1,opportunityProject:1,opportunityKind:'questions'},esc:s=>String(s??''),api:async url=>{assert.match(url,/status=active&kind=questions/);return data;},taskCard:t=>`<article>${t.id}</article>`});
 vm.runInContext(app.slice(app.indexOf('function opportunityKind('),app.indexOf('const STATUS_LABEL')),v);
 const document=new JSDOM(await v.viewActions()).window.document;
 assert.match(document.querySelector('[data-task-filter="active"]').textContent,/Open work\s+106/);
 assert.match(document.getElementById('queueCount').textContent,/100 shown of 106/);
 assert.match(document.getElementById('opportunityKind').textContent,/Question reviews \(106\)/);
});
test.after(()=>db.close());
