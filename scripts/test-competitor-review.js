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
 const invoke=async(body,auth=async()=>({id:28}),analyse=retrospective,sample=reviewSample)=>{
 let response,status=200;const res={status:n=>{status=n;return res;},json:x=>response=x};
 await route({body},res,auth,client.query,pool,domainKey,sample,analyse);return {response,status};};
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
 await db.exec("INSERT INTO measurement_batches(id,project_id,cycle_date,status) VALUES(41,28,'2026-09-28','completed')");
 const pgSample=async()=>({measurement:{id:'41'},rows:[],limited:false});
 const request={action:'track',measurementId:41,items:[{name:'String ID Bank'}]};
 assert.equal((await invoke(request,undefined,undefined,pgSample)).status,200);
 assert.equal((await invoke({...request,measurementId:'40'},undefined,undefined,pgSample)).status,409);
 assert.deepEqual((await invoke({action:'track',items:[{name:'البنك العربي'}]})).response.skipped,['البنك العربي']);
 }finally{await db.close();}
});
test('real scan generic phrases are not promoted to competitor names',()=>{
 const phrases=['bank','Jordanian bank','Jordanian banks','البنك المناسب','اختيار البنك','اسم البنك','Basic Bank','Central Bank','All Operating Banks','Primary Bank','Many banks pay very low base savings rates','البطاقة الفضية من البنك العربي','تطبيق بنك الاتحاد','بنكًا تقليديًا واسع الانتشار','By bank, from the results'];
 const c=competitorCandidates([{...row,response_text:phrases.map(p=>`**${p}**`).join('\n'),citations:[]}],[]);
 assert.deepEqual(c,[]);
});
test('same bank name across domains and direction marks becomes one review card',()=>{
 const c=competitorCandidates([{...row,response_text:'**Arab Bank** **\u200fArab Bank\u200f**',citations:[{domain:'arabbank.jo'},{domain:'arabbank.com'},{domain:'arabbank.com.jo'}]}],[]);
 assert.equal(c.length,1);assert.equal(c[0].evidence.length,1);assert.equal(c[0].domains.length,3);assert.equal(c[0].bulkEligible,true);
 const unknown=competitorCandidates([{...row,response_text:'A bank',citations:[{domain:'unknownbank.jo'}]}],[]);
 assert.equal(unknown[0].bulkEligible,false);
});
test('bulk-selection UI excludes unnamed domains and sends edited bilingual aliases',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);
 const dom=new JSDOM(`<button id="selectNamedCandidates">Select</button><button id="clearNamedCandidates">Clear</button><button id="trackSelectedCompetitors">Track</button>
 ${[0,1].map(i=>`<input type="checkbox" data-candidate-select="${i}"><details data-candidate-edit="${i}"></details><input data-candidate-name="${i}" value="Arab Bank"><input data-candidate-domain="${i}" value="arabbank.jo"><textarea data-candidate-aliases="${i}">البنك العربي</textarea><input type="checkbox" data-candidate-ambiguous="${i}">`).join('')}`);
 const source=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');const start=source.indexOf("document.addEventListener('click',async event=>{",source.indexOf('async function saveCompetitorReview'));
 const listener=source.slice(start,source.indexOf('\nasync function viewSetup()',start));
 let saved;new Function('document','state','saveCompetitorReview','toast','$',listener)(dom.window.document,{competitorReview:{measurement:{id:'41'},candidates:[{bulkEligible:true},{bulkEligible:false}]}},x=>saved=x,()=>{},id=>dom.window.document.getElementById(id));
 const doc=dom.window.document;doc.getElementById('selectNamedCandidates').click();assert.equal(doc.querySelectorAll(':checked').length,1);assert.equal(doc.querySelector('details').open,true);
 doc.getElementById('trackSelectedCompetitors').click();assert.equal(saved.items.length,1);assert.deepEqual(saved.items[0].aliases,['البنك العربي']);assert.equal(saved.measurementId,'41');
 doc.getElementById('clearNamedCandidates').click();assert.equal(doc.querySelectorAll(':checked').length,0);
});
test('agency names pair with cited domains without promoting generic headings or unmatched names',()=>{
 const candidates=competitorCandidates([{...row,question:'Which marketing agencies should I compare?',response_text:'**Nexa** and **Digital Gravity**. **Best marketing agencies**. **Unverified Agency**',citations:[{domain:'nexa.com'},{domain:'digitalgravity.ae'},{domain:'directory.example'}]}],[]);
 assert.equal(candidates.find(c=>c.domain==='nexa.com').name,'Nexa');
 assert.equal(candidates.find(c=>c.domain==='digitalgravity.ae').bulkEligible,true);
 assert.equal(candidates.find(c=>c.domain==='directory.example').bulkEligible,false);
 assert.ok(!candidates.some(c=>c.name==='Unverified Agency'||c.name==='Best marketing agencies'));
 const owned=competitorCandidates([{...row,response_text:'**Sandstorm Digital**',citations:[{domain:'sandstormdigital.com'}]}],[{name:'Sandstorm Digital',domain:'sandstormdigital.com'}]);
 assert.deepEqual(owned,[]);
});
test('competitor screen uses industry-neutral labels for every project',()=>{
 const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
 const screen=app.slice(app.indexOf('async function viewCompetitorReview'),app.indexOf('async function viewSetup',app.indexOf('async function viewCompetitorReview')));
 assert.doesNotMatch(screen,/bank-shaped|named bank|Possible bank|SuggestedBanks/i);
 assert.match(screen,/A cited source is not necessarily a competitor/);
});
test('generic services remain domain-only even when bold text matches a cited domain',()=>{
 for(const [name,domain] of [['SEO','seo.com'],['SEO agency','seoagency.ae'],['Search Engine Optimization','searchengineoptimization.com'],['التسويق الرقمي','التسويقالرقمي.com']]) {
  const c=competitorCandidates([{...row,response_text:`**${name}**`,citations:[{domain}]}],[]);
  assert.equal(c.length,1);assert.equal(c[0].name,c[0].domain);assert.equal(c[0].bulkEligible,false);
 }
 const branded=competitorCandidates([{...row,response_text:'**United SEO**',citations:[{domain:'unitedseo.ae'}]}],[]);
 assert.equal(branded[0].name,'United SEO');assert.equal(branded[0].bulkEligible,true);
});
test('name counts exclude citation-only answers, URL strings and substrings',()=>{
 const rows=[{...row,id:1,response_text:'**Digital Gravity**',citations:[{domain:'digitalgravity.ae'}]},
 {...row,id:2,response_text:'Another business',citations:[{domain:'digitalgravity.ae'}]},
 {...row,id:3,response_text:'digital gravity is listed here',citations:[]},
 {...row,id:4,response_text:'Digital GravityWorks https://digitalgravity.ae',citations:[]}];
 const c=competitorCandidates(rows,[])[0];assert.equal(c.namedAnswers,2);assert.equal(c.citedAnswers,2);
 assert.deepEqual(c.evidence.map(e=>e.id).sort(),[1,2,3]);
 assert.equal(c.evidence.find(e=>e.id===2).named,false);
});
test('a name and matching domain in unrelated answers do not establish a pairing',()=>{
 const c=competitorCandidates([{...row,id:1,response_text:'**Example Agency**',citations:[]},{...row,id:2,response_text:'Unrelated advice',citations:[{domain:'exampleagency.com'}]}],[]);
 assert.equal(c[0].name,'exampleagency.com');assert.equal(c[0].bulkEligible,false);
});
