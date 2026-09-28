import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {competitorCandidates,retrospective,reviewSample,domainKey} from '../src/lib/competitor-review.js';
const row={id:1,engine:'chatgpt',question:'Best apps?',response_text:'**Arab Bank** and Capital Bank, بنك الاتحاد. **Best banking apps**',citations:[{domain:'www.arabbank.jo',url:'https://arabbank.jo/app'},{domain:'apps.apple.com',url:'https://apps.apple.com/x'}]};
test('merges a named bank with its domain and keeps publishers unselected',()=>{
 const c=competitorCandidates([row,{...row,id:2}],[]);
 const arab=c.find(x=>x.domain==='arabbank.jo');assert.equal(arab.name,'Arab Bank');assert.equal(arab.evidence.length,2);
 assert.equal(c.filter(x=>x.name==='Arab Bank').length,1);assert.equal(c.find(x=>x.domain==='apps.apple.com').bank,false);
 assert.ok(!c.some(x=>x.name==='Best banking apps'));
});
test('tracked names, aliases and owned subdomains excluded; ignore survives rediscovery',()=>{
 const c=competitorCandidates([row],[{name:'Arab Bank',domain:'arabbank.jo',aliases:['Capital Bank']}],['domain:apps.apple.com']);
 assert.equal(c.length,1);assert.equal(c[0].ignored,true);
 assert.equal(competitorCandidates([{...row,citations:[{domain:'news.arabbank.jo'}],response_text:'text'}],[{name:'Arab',domain:'arabbank.jo'}]).length,0);
});
test('retrospective uses literal EN/AR detection and independent citation counts',async()=>{
 const result=await retrospective([row,{...row,id:2,response_text:'Other banks',citations:[]}],{id:5,name:'Bank al Etihad',aliases:['بنك الاتحاد'],domain:'bankaletihad.com',ambiguous_name:false});
 assert.equal(result.named,1);assert.equal(result.cited,0);assert.equal(result.measured,2);
 assert.equal((await retrospective([row],{id:6,name:'Absent',aliases:[],domain:null})).cited,null);
 assert.equal((await retrospective([{...row,response_text:''}],{id:6,name:'Absent'})).measured,0);
});
test('unsafe domains rejected',()=>{assert.equal(domainKey('https://user:pass@example.com'),'');assert.equal(domainKey('javascript:alert(1)'),'');assert.equal(domainKey('https://www.example.com/path'),'example.com');});
test('schema migration repeatable and baseline storage separate',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();
 try {const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8');await db.exec(schema);await db.exec(schema);
 assert.equal((await reviewSample(db,999)).rows.length,0);
 const tables=(await db.query("SELECT tablename FROM pg_tables WHERE tablename LIKE 'competitor_%'")).rows;assert.equal(tables.length,2);
 }finally{await db.close();}
});
test('new routes enforce project authorization and never rewrite original mentions',()=>{
 const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');const routes=server.slice(server.indexOf("app.get('/api/projects/:id/competitor-review'"),server.indexOf("app.post('/api/projects/:id/entities'"));
 assert.equal((routes.match(/assertProject\(req,res\)/g)||[]).length,2);assert.ok(!/INSERT INTO mentions|UPDATE mentions|DELETE FROM mentions/.test(routes));assert.match(routes,/FOR UPDATE/);assert.match(routes,/ROLLBACK/);
 const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');assert.match(app,/competitorReview:'evidence'/);assert.match(app,/esc\(c.name\)/);
});
test('review query uses selected published measurement and excludes failed, blank and unmeasured answers',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();
 try {
 await db.exec(`CREATE TABLE published_measurements(id int,project_id int,cycle_date date);CREATE TABLE measurement_answers(measurement_id int,run_id int);
 CREATE TABLE runs(id int,project_id int,prompt_id int,engine text,response_text text,ok boolean);CREATE TABLE prompts(id int,text text);CREATE TABLE citations(run_id int,domain text,url text);CREATE TABLE mentions(run_id int,entity_id int);CREATE TABLE entities(id int,project_id int,kind text);
 INSERT INTO published_measurements VALUES(41,28,'2026-09-28'),(40,28,'2026-09-27'),(42,99,'2026-09-28');INSERT INTO prompts VALUES(1,'Best bank?');INSERT INTO entities VALUES(1,28,'owned');
 INSERT INTO runs VALUES(1,28,1,'chatgpt','Arab Bank',true),(2,28,1,'gemini','',true),(3,28,1,'claude','Failed',false),(4,28,1,'chatgpt','Unmeasured',true),(5,99,1,'chatgpt','Other site',true),(6,28,1,'chatgpt','Old',true);
 INSERT INTO measurement_answers VALUES(41,1),(41,2),(41,3),(41,4),(42,5),(40,6);INSERT INTO mentions VALUES(1,1),(2,1),(3,1),(6,1);`);
 const sample=await reviewSample(db,28);assert.equal(sample.measurement.id,41);assert.deepEqual(sample.rows.map(r=>r.id),[1]);assert.equal(sample.limited,false);
 }finally{await db.close();}
});
test('review HTML escapes external content, exposes ignore/restore and empty manual entry',async()=>{
 const source=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('async function viewCompetitorReview() {')+'async function viewCompetitorReview() {'.length,source.indexOf('\nasync function saveCompetitorReview'));
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const render=new AsyncFunction('api','state','esc','shortDate',body.trim().replace(/\}$/, ''));
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const data={measurement:{id:41},answers:5,candidates:[{name:'<img src=x onerror=alert(1)>',domain:'example.com',key:'domain:example.com',bank:false,evidence:[],ignored:true}],baselines:[]};
 const html=await render(async()=>data,{projectId:28},esc,x=>x);
 assert.ok(!html.includes('<img'));assert.match(html,/Restore suggestion/);assert.match(html,/customCompetitorAliases/);assert.match(html,/Retrospective starting comparisons/);
 const {JSDOM}=await import(process.env.JSDOM_MODULE);const dom=new JSDOM(html);assert.equal(dom.window.document.querySelectorAll('[data-candidate-select]:checked').length,0);assert.equal(dom.window.document.querySelector('[data-candidate-select]').disabled,true);
});
test('tracking route persists aliases, skips duplicates, isolates sites and rolls back failed analysis',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();
 const source=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
 const prefix="app.post('/api/projects/:id/competitor-review', requireAuth, wrap(async (req,res) => {";
 const body=source.slice(source.indexOf(prefix)+prefix.length,source.indexOf("app.post('/api/projects/:id/entities'" )).trim().replace(/\}\)\);$/, '');
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const route=new AsyncFunction('req','res','assertProject','query','pool','domainKey','reviewSample','retrospective',body);
 try {
 await db.exec(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
 await db.exec("INSERT INTO orgs(id,name) VALUES(1,'Test'); INSERT INTO projects(id,org_id,name,domain,brand_name) VALUES(28,1,'Bank','bank.test','Bank'),(99,1,'Other','other.test','Other');");
 const client={query:(...a)=>db.query(...a),release:()=>{}};const pool={connect:async()=>client};
 const invoke=async(body,auth=async()=>({id:28}),analyse=retrospective)=>{
 let response,status=200;const res={status:n=>{status=n;return res;},json:x=>response=x};
 await route({body},res,auth,client.query,pool,domainKey,reviewSample,analyse);return {response,status};};
 const payload={action:'track',items:[{name:'Arab Bank',domain:'arabbank.jo',aliases:['البنك العربي'],ambiguous:false}]};
 assert.deepEqual((await invoke(payload)).response.added,['Arab Bank']);
 assert.deepEqual((await invoke(payload)).response.skipped,['Arab Bank']);
 const e=(await db.query('SELECT * FROM entities')).rows;assert.equal(e.length,1);assert.deepEqual(e[0].aliases,['البنك العربي']);assert.equal(e[0].project_id,28);
 assert.equal((await db.query('SELECT * FROM competitor_baselines')).rows[0].analysis.measured,0);
 assert.equal((await db.query('SELECT * FROM mentions')).rows.length,0);
 await invoke({action:'track',items:[{name:'Other Bank'}]},async()=>null);assert.equal((await db.query('SELECT * FROM entities')).rows.length,1);
 await assert.rejects(()=>invoke({action:'track',items:[{name:'Fails'}]},undefined,async()=>{throw Error('test failure');}));
 assert.equal((await db.query("SELECT * FROM entities WHERE name='Fails'")).rows.length,0);
 await invoke({action:'ignore',key:'domain:example.com'});await invoke({action:'restore',key:'domain:example.com'});
 assert.equal((await db.query('SELECT ignored FROM competitor_review_decisions')).rows[0].ignored,false);
 assert.equal((await invoke({action:'track',items:[null]})).status,400);
 }finally{await db.close();}
});
