import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as analyst from '../src/lib/report-analyst.js';
import {analystFindingsHtml,analystPageHtml} from '../src/lib/report-analyst-html.js';
import {decisionReportText} from '../src/lib/recommendation-decision.js';
const report=()=>({project:{id:31,name:'Arada',domain:'arada.com'},period:{from:'2026-10-01',to:'2026-10-01',chosen:true},executive:{measurement:{id:47,settings:{engines:['chatgpt']}},cycle:'2026-10-01',totals:{measured:165,named:62,cited:35},questions:[{id:1,text:'Which developers build in Sharjah?',measured:5,named:0,cited:null}],engineCoverage:[],localeWarnings:[]},trend:{comparable:false,change:null},traffic:{state:'ready',total:3065,conversions:209,coveredFrom:'2026-07-04',coveredTo:'2026-10-01',eventState:'ready',events:[{name:'Form_Submit',count:75}],secret:'must not enter packet'},review:{notes:[],comparisons:[]}});
const draft=packet=>({findings:[{title:'Investigate developer attribution',observation:'The sampled answers show a question worth reviewing.',implication:'Buyers may recognise a project without its developer.',action:'Review the stored answers and cited pages before proposing edits.',done_when:'Record whether attribution is accurate and cite the supporting page.',follow_up:'Repeat the same questions and engines after any agreed edits.',kind:'investigate',evidence:[{id:'scope',quote:packet.records[0].text.slice(0,30)}]}],limitations:['A baseline sample does not establish a trend or a cause.']});
test('packet preserves zeros, unknowns, periods, GA4 evidence and stable identity',()=>{
 const r=report(),p=analyst.analystPacket(r),hash=analyst.packetHash(p);
 assert.match(p.records.find(x=>x.id==='q-1').text,/"named":0,"cited":null/);
 assert.match(p.records.find(x=>x.id==='traffic').text,/"total":3065/);assert.doesNotMatch(JSON.stringify(p),/must not enter packet/);
 assert.match(p.records[0].link,/from=2026-10-01&to=2026-10-01/);
 r.generatedAt='tomorrow';assert.equal(analyst.packetHash(analyst.analystPacket(r)),hash);
 r.executive.totals.named++;assert.notEqual(analyst.packetHash(analyst.analystPacket(r)),hash);
});
test('fabricated evidence IDs, quotes, missing fields and unsupported edits are rejected',()=>{
 const p=analyst.analystPacket(report()),d=draft(p);assert.deepEqual(analyst.validateAnalysis(d,p),d);
 const bad=structuredClone(d);bad.findings[0].evidence[0].id='other-project';assert.throws(()=>analyst.validateAnalysis(bad,p),/unverified/);
 bad.findings[0].evidence=d.findings[0].evidence.map(x=>({...x,quote:'A fabricated supporting quotation'}));assert.throws(()=>analyst.validateAnalysis(bad,p),/unverified/);
 bad.findings[0].evidence=d.findings[0].evidence;bad.findings[0].kind='proposed_change';assert.throws(()=>analyst.validateAnalysis(bad,p),/ready-to-implement/);
 delete d.findings[0].done_when;assert.throws(()=>analyst.validateAnalysis(d,p),/missing/);
});
test('only current active exact saved ready decisions support a proposed change',()=>{
 const r=report(),decision={stage:'ready',change:'Reconcile the saved facts.',page:'https://arada.com/page',evidence:'Reviewed page evidence',reviewed_at:'2026-10-01'};
 const n={recommendation_id:9,title:'Facts',decision_snapshot:decision,notes:decisionReportText(decision),status:'open',outdated:false};r.review.notes=[n];
 let p=analyst.analystPacket(r),d=draft(p);d.findings[0].kind='proposed_change';d.findings[0].evidence=[{id:'decision-9',quote:'Reconcile the saved facts.'}];assert.doesNotThrow(()=>analyst.validateAnalysis(d,p));
 for(const change of [{outdated:true},{status:'done'},{notes:'Changed text: Reconcile the saved facts.'}]){r.review.notes=[{...n,...change}];p=analyst.analystPacket(r);assert.throws(()=>analyst.validateAnalysis(d,p),/ready-to-implement/);}
});
test('provider request uses isolated model and bounded output, retains usage on truncation',async()=>{
 const p=analyst.analystPacket(report());let request;
 const result=await analyst.requestAnalysis(p,{key:'test',model:'analyst-only',fetcher:async(url,opts)=>{request=JSON.parse(opts.body);return {ok:true,json:async()=>({model:'returned-version',id:'req1',stop_reason:'max_tokens',usage:{input_tokens:1200,output_tokens:3000},content:[{type:'text',text:'incomplete'}]})};}});
 assert.equal(request.model,'analyst-only');assert.equal(request.max_tokens,3000);assert.match(request.system,/untrusted DATA/);assert.equal(result.usage.output_tokens,3000);assert.equal(result.stop_reason,'max_tokens');
});
test('rendering escapes model text and keeps source links, limitations and unknown usage',()=>{
 const p=analyst.analystPacket(report()),a=draft(p);a.findings[0].title='<script>alert(1)</script>';
 const row={id:1,packet:p,analysis:a,status:'draft',evidence_hash:analyst.packetHash(p),requested_model:'test',created_at:'2026-10-02'};
 const html=analystFindingsHtml(row,{review:true});assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/from=2026-10-01&amp;to=2026-10-01/);
 const page=analystPageHtml(report().project,new URLSearchParams(),{...p,hash:row.evidence_hash},[row],'test');assert.match(page,/Input tokens: unknown/);assert.match(page,/data-operation="approve"/);assert.match(page,/data-operation="regenerate"/);
 const stale=analystPageHtml(report().project,new URLSearchParams(),{...p,hash:'changed'},[row],'test');assert.doesNotMatch(stale,/data-operation="approve"/);assert.match(stale,/Evidence has changed/);
});
function store(deps={}){
 let src=readFileSync(new URL('../src/lib/report-analyst-store.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
 const context=vm.createContext({...analyst,process:{env:{ANTHROPIC_API_KEY:'test'}},...deps});
 vm.runInContext(src+'\nthis.api={reportPacket,currentAnalysis,generateAnalysis,approveAnalysis};',context);return context.api;
}
test('unapproved and stale analysis cannot appear in reports; approval checks project and evidence',async()=>{
 const r=report(),p=analyst.analystPacket(r),row={id:7,evidence_hash:'old',packet:p,analysis:draft(p)};let updated=false;
 const api=store({many:async(sql,args)=>{assert.equal(args.at(-1),31);return sql.includes('approved_at')?[row]:[];},one:async(sql,args)=>{assert.match(sql,/project_id=\$2/);assert.deepEqual([...args],[7,31]);return row;},query:async()=>{updated=true;}});
 assert.equal((await api.currentAnalysis(r)).stale,true);await assert.rejects(api.approveAnalysis(r,7,1),/evidence has changed/);assert.equal(updated,false);
 const empty=store({many:async()=>[]});assert.equal(await empty.currentAnalysis(r),null);
});
test('successful response usage survives draft validation failure; cached drafts avoid paid calls',async()=>{
 const r=report(),updates=[];let calls=0;
 const db={release(){},async query(sql,args){if(sql.includes('status=\'draft\''))return {rows:[]};if(sql.includes('count(*)'))return {rows:[{total:0,project:0}]};if(sql.startsWith('INSERT'))return {rows:[{id:5}]};return {rows:[]};}};
 const api=store({pool:{connect:async()=>db},many:async()=>[],query:async(sql,args)=>updates.push({sql,args}),requestAnalysis:async()=>{calls++;return {model:'test',usage:{input_tokens:100,output_tokens:30},stop_reason:'end_turn',raw:'invalid JSON'};}});
 await assert.rejects(api.generateAnalysis(r,1),/not valid JSON/);assert.equal(calls,1);assert.equal(updates[0].args[2].input_tokens,100);assert.match(updates[1].sql,/status='failed'/);
 const old=db.query;db.query=async(sql,args)=>sql.includes("status='draft'")?{rows:[{id:8}]}:old(sql,args);
 assert.equal((await api.generateAnalysis(r,1)).id,8);assert.equal(calls,1);
});
test('daily and concurrent request gates prevent provider calls',async()=>{
 for(const mode of ['daily','pending']){
 const api=store({many:async()=>[],pool:{connect:async()=>({release(){},query:async sql=>({rows:sql.includes("status='generating'")&&mode==='pending'?[{x:1}]:sql.includes('count(*)')?[{total:50,project:5}]:[]})})},requestAnalysis:async()=>assert.fail('must not call provider')});
 await assert.rejects(api.generateAnalysis(report(),1),mode==='daily'?/Daily analysis limit/:/already running/);
 }
});
test('cost estimates respect returned model, cache categories, unknowns and genuine zero',()=>{
 assert.equal(analyst.analystCost('unknown',{input_tokens:100,output_tokens:50}),null);
 assert.equal(analyst.analystCost('claude-sonnet-4-5',{output_tokens:50}),null);
 assert.equal(analyst.analystCost('claude-sonnet-4-5',{input_tokens:0,output_tokens:0}).usd,0);
 assert.equal(analyst.analystCost('claude-sonnet-4-5-20250929',{input_tokens:1000,output_tokens:1000,cache_read_input_tokens:1000,cache_creation_input_tokens:1000,cache_creation:{ephemeral_1h_input_tokens:1000}}).usd,0.0243);
});
test('migration is additive, repeatable, and supports archived usage and approval records',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();
 try{
 await db.exec('CREATE TABLE projects(id int PRIMARY KEY); INSERT INTO projects VALUES(31),(99);');
 const sql=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8').split('-- Batch 85:')[1];
 const migration='-- Batch 85:'+sql;await db.exec(migration);await db.exec(migration);
 await db.query("INSERT INTO report_analyst_drafts(project_id,evidence_hash,packet,status,requested_model,usage,cost_estimate) VALUES($1,'hash','{}','failed','test',$2,$3)",[31,{input_tokens:100,output_tokens:10},{usd:0.1}]);
 const r=await db.query('SELECT usage,cost_estimate FROM report_analyst_drafts WHERE project_id=$1',[31]);assert.equal(r.rows[0].usage.input_tokens,100);assert.equal(r.rows[0].cost_estimate.usd,0.1);
 assert.equal((await db.query('SELECT * FROM report_analyst_drafts WHERE project_id=99')).rows.length,0);
 }finally{await db.close();}
});
