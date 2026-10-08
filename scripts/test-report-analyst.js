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
 assert.equal(request.model,'analyst-only');assert.equal(request.max_tokens,6000);assert.match(request.system,/untrusted DATA/);assert.equal(result.usage.output_tokens,3000);assert.equal(result.stop_reason,'max_tokens');
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
 vm.runInContext(src+'\nthis.api={reportPacket,currentAnalysis,generateAnalysis,approveAnalysis,recoverAnalysis,editAnalysis,analysisInclusionStatus};',context);return context.api;
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
 const old=db.query;db.query=async(sql,args)=>sql.includes("status='draft'")?{rows:[{id:8,analysis:draft(analyst.analystPacket(r))}]}:old(sql,args);
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
 await db.exec('CREATE TABLE orgs(id int PRIMARY KEY); CREATE TABLE projects(id int PRIMARY KEY); INSERT INTO projects VALUES(31),(99);');
 const sql=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8').split('-- Batch 85:')[1];
 const migration='-- Batch 85:'+sql;await db.exec(migration);await db.exec(migration);
 await db.query("INSERT INTO report_analyst_drafts(project_id,evidence_hash,packet,status,requested_model,usage,cost_estimate) VALUES($1,'hash','{}','failed','test',$2,$3)",[31,{input_tokens:100,output_tokens:10},{usd:0.1}]);
 const r=await db.query('SELECT usage,cost_estimate FROM report_analyst_drafts WHERE project_id=$1',[31]);assert.equal(r.rows[0].usage.input_tokens,100);assert.equal(r.rows[0].cost_estimate.usd,0.1);
 assert.equal((await db.query('SELECT * FROM report_analyst_drafts WHERE project_id=99')).rows.length,0);
 }finally{await db.close();}
});
test('large source tables fit the analyst budget without changing totals, dates or nulls',()=>{
 const r=report();
 const queries=Array.from({length:5000},(_,i)=>'a detailed search query '+i);
 r.executive.questions=Array.from({length:28},(_,i)=>({id:i+1,text:'Buyer question '+i,source:'gsc',measured:6,named:0,cited:null,originDetails:{property:'https://www.arada.com/',querySet:queries,gscSnapshot:{property:'https://www.arada.com/',startDate:'2026-07-01',endDate:'2026-09-30',impressions:42000,clicks:0,matchedQueries:5000,storedQueries:5000,returnedRows:20000,rows:queries}}}));
 r.traffic.pages=Array.from({length:10000},(_,i)=>({page:'/page-'+i,sessions:10,conversions:0}));
 const answers=Array.from({length:24},(_,i)=>({id:i,engine:'chatgpt',question:'Buyer question '+i,response_text:'An answer. '.repeat(2000)}));
 assert.ok(JSON.stringify(r).length>1e6);
 const p=analyst.analystPacket(r,answers);assert.ok(JSON.stringify(p).length<=110000);assert.equal(p.limits.questionsIncluded,28);
 const traffic=JSON.parse(p.records.find(x=>x.id==='traffic').text);assert.equal(traffic.total,3065);assert.equal(traffic.conversions,209);assert.equal(traffic.coveredFrom,'2026-07-04');assert.equal(traffic.pages.length,12);assert.equal(traffic.detailCoverage.pages.total,10000);
 const q=JSON.parse(p.records.find(x=>x.id==='q-1').text);assert.equal(q.cited,null);assert.equal(q.named,0);assert.equal(q.originDetails.gscSnapshot.impressions,42000);assert.equal(q.originDetails.gscSnapshot.clicks,0);assert.equal(q.originDetails.queryExamples.length,3);assert.equal(q.originDetails.queryExamplesTotal,5000);
 const hash=analyst.packetHash(p);r.traffic.pages[9999].sessions++;
 assert.notEqual(analyst.packetHash(analyst.analystPacket(r,answers)),hash,'Changes in omitted evidence invalidate old approvals');
});
test('budget admits complete records only and accurately discloses omitted excerpts',()=>{
 const r=report();r.executive.questions=Array.from({length:100},(_,i)=>({id:i,text:'A long buyer question '.repeat(100),measured:6,named:0,cited:0}));
 const answers=Array.from({length:24},(_,i)=>({id:i,response_text:'answer '.repeat(500)}));
 const p=analyst.analystPacket(r,answers);assert.ok(JSON.stringify(p).length<=110000);assert.ok(p.limits.omittedRecordCount>0);
 assert.equal(p.limits.questionsIncluded,p.records.filter(x=>x.id.startsWith('q-')).length);
 assert.equal(p.limits.answerExcerpts,p.records.filter(x=>x.id.startsWith('answer-')).length);
 for(const record of p.records)assert.doesNotThrow(()=>JSON.parse(record.text));
});

test('a 470-character implication is retained in full; missing and excessive text identify the field',()=>{
 const p=analyst.analystPacket(report()),d=draft(p);d.findings[0].implication='A'.repeat(470);
 assert.equal(analyst.validateAnalysis(d,p).findings[0].implication.length,470);
 d.findings[0].implication='A'.repeat(901);assert.throws(()=>analyst.validateAnalysis(d,p),/finding 1.implication has 901 characters; the hard limit is 900/);
 d.findings[0].implication='';assert.throws(()=>analyst.validateAnalysis(d,p),/missing finding 1.implication/);
 d.findings[0].implication='A'.repeat(470);d.findings[0].evidence[0].quote='fabricated quote that never appeared';assert.throws(()=>analyst.validateAnalysis(d,p),/unverified/);
});
test('recovery reuses stored output without billing or approval and refuses stale, incomplete or false evidence',async()=>{
 const r=report(),p=analyst.analystPacket(r),d=draft(p);d.findings[0].implication='A'.repeat(470);
 const row={id:2,project_id:31,status:'failed',stop_reason:'end_turn',packet:p,evidence_hash:analyst.packetHash(p),raw_response:JSON.stringify(d)};
 let updates=0;
 const api=store({many:async()=>[],one:async(sql,args)=>{
  assert.equal(args[1],31);
  if(sql.startsWith('SELECT'))return row;
  assert.doesNotMatch(sql,/approved_|usage|cost_estimate|raw_response/);updates++;return {...row,status:'draft',analysis:args[2]};
 },requestAnalysis:async()=>assert.fail('Recovery must not call AI')});
 const result=await api.recoverAnalysis(r,2);assert.equal(result.analysis.findings[0].implication.length,470);assert.equal(updates,1);
 row.stop_reason='max_tokens';await assert.rejects(api.recoverAnalysis(r,2),/incomplete/);
 row.stop_reason='end_turn';row.evidence_hash='stale';await assert.rejects(api.recoverAnalysis(r,2),/evidence has changed/);
 row.evidence_hash=analyst.packetHash(p);d.findings[0].evidence[0].quote='invented evidence reference';row.raw_response=JSON.stringify(d);await assert.rejects(api.recoverAnalysis(r,2),/unverified/);assert.equal(updates,1);
});
test('real Masaar quote matches omitted Markdown bold without altering words',()=>{
 const excerpt='- Overview: **Masaar 3** (also referred to as Phase 3 of the Masaar master community, named **Layan** or **Laura** in specific district rollouts) is a major residential launch by developer **Arada** in Sharjah, UAE.';
 const quote='Masaar 3 (also referred to as Phase 3 of the Masaar master community, named Layan or Laura in specific district rollouts)';
 const record={id:'answer-18063',text:JSON.stringify({engine:'ai_mode',question:'What is Masaar 3?',excerpt})};
 assert.equal(analyst.evidenceQuoteMatch(record,quote),'formatting-normalised');
 for(const invalid of [quote.replace('Phase 3','Phase 2'),quote.replace('Layan','Layan Hills'),quote.replace(' or ',' and '),quote.replace('specific ','')])assert.equal(analyst.evidenceQuoteMatch(record,invalid),null);
 const p=analyst.analystPacket(report());p.records.push(record);const d=draft(p);d.findings[0].evidence=[{id:record.id,quote}];
 const checked=analyst.validateAnalysis(d,p);assert.equal(checked.findings[0].evidence[0].quote,quote);assert.equal(checked.findings[0].evidence[0].sourceMatch,'formatting-normalised');
 assert.match(analystFindingsHtml({packet:p,analysis:checked}),/Quotation formatting normalised/);
});
test('format matching stays within answer prose and preserves negation, punctuation and numerical values',()=>{
 const record={id:'answer-1',text:JSON.stringify({question:'**An unrelated quoted question**',excerpt:'Prices are **not** confirmed.\nThe price is AED **1.8 million**. [Source](https://example.com)'})};
 assert.equal(analyst.evidenceQuoteMatch(record,'Prices are not confirmed. The price is AED 1.8 million.'),'formatting-normalised');
 assert.equal(analyst.evidenceQuoteMatch(record,'Prices are confirmed. The price is AED 1.8 million.'),null);
 assert.equal(analyst.evidenceQuoteMatch(record,'The price is AED 18 million.'),null);
 assert.equal(analyst.evidenceQuoteMatch(record,'An unrelated quoted question'),null);
 assert.equal(analyst.evidenceQuoteMatch({...record,id:'decision-1'},'Prices are not confirmed.'),null);
 assert.equal(analyst.evidenceQuoteMatch(record,'The price is AED 1.8 million. Source'),null);
});
test('review prompts flag risky wording privately without pretending to verify meaning',()=>{
 const p=analyst.analystPacket(report()),a=draft(p),f=a.findings[0];
 f.implication='This visibility translates to measurable referral traffic.';
 f.done_when='FAQ schema is deployed with one set of prices.';
 f.follow_up='Track cost per qualified lead.';
 assert.equal(analyst.analysisReviewWarnings(f).length,4);
 const row={packet:p,analysis:a};
 assert.match(analystFindingsHtml(row,{review:true}),/Check before inclusion/);
 assert.match(analystFindingsHtml(row,{review:true}),/not a verdict/);
 assert.doesNotMatch(analystFindingsHtml(row),/Check before inclusion/);
 assert.deepEqual(analyst.analysisReviewWarnings(draft(p).findings[0]),[]);
});
test('analysis policy update invalidates earlier approval without changing measured evidence',()=>{
 const p=analyst.analystPacket(report()),old=structuredClone(p);delete old.analysisPolicy;delete old.definitions;
 assert.notEqual(analyst.packetHash(p),analyst.packetHash(old));
 assert.deepEqual(p.records,old.records);
 assert.equal(p.sourceFingerprint,old.sourceFingerprint);
 assert.match(p.definitions.traffic,/No question-level attribution/);
});
test('editing preserves original response and references, archives wording, clears approval and rejects stale saves',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE),db=new PGlite(),r=report(),p=analyst.analystPacket(r),a=draft(p);
 try{
 await db.exec('CREATE TABLE orgs(id int PRIMARY KEY); CREATE TABLE projects(id int PRIMARY KEY); INSERT INTO projects VALUES(31);');
 await db.exec('-- Batch 85:'+readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8').split('-- Batch 85:')[1]);
 await db.query("INSERT INTO report_analyst_drafts(id,project_id,evidence_hash,packet,status,requested_model,analysis,raw_response,approved_at) VALUES(7,31,$1,$2,'draft','test',$3,'original raw',now())",[analyst.packetHash(p),p,a]);
 const api=store({many:async()=>[],pool:{connect:async()=>({query:(sql,args)=>db.query(sql,args),release(){}})},one:async(sql,args)=>(await db.query(sql,args)).rows[0],query:async(sql,args)=>{const out=await db.query(sql,args);return {rowCount:out.affectedRows};}});
 const changes=structuredClone(a);changes.findings[0].title='Review developer attribution';changes.findings[0].evidence=[{id:'fabricated',quote:'do not accept this'}];changes.findings[0].kind='proposed_change';
 await api.editAnalysis(r,7,42,0,changes);
 const row=(await db.query('SELECT * FROM report_analyst_drafts WHERE id=7')).rows[0];
 assert.equal(row.raw_response,'original raw');assert.equal(row.edit_revision,1);assert.equal(row.approved_at,null);assert.equal(row.edited_by,42);
 assert.deepEqual(row.edit_history[0].analysis,a);assert.deepEqual(row.analysis.findings[0].evidence,a.findings[0].evidence);assert.equal(row.analysis.findings[0].kind,'investigate');
 await assert.rejects(api.editAnalysis(r,7,42,0,changes),/Someone edited/);
 await assert.rejects(api.approveAnalysis(r,7,42,0),/draft has changed/);
 await api.approveAnalysis(r,7,42,1);
 assert.ok((await db.query('SELECT approved_at FROM report_analyst_drafts WHERE id=7')).rows[0].approved_at);
 const invalid=structuredClone(changes);invalid.findings[0].title='';await assert.rejects(api.editAnalysis(r,7,42,1,invalid),/missing/);
 assert.equal((await db.query('SELECT edit_revision FROM report_analyst_drafts WHERE id=7')).rows[0].edit_revision,1);
 await assert.rejects(api.editAnalysis({...r,project:{id:99}},7,42,1,changes),/not found/);
 const changed=structuredClone(r);changed.project.name='Updated project name';
 await api.editAnalysis(changed,7,42,1,changes);
 const older=(await db.query('SELECT * FROM report_analyst_drafts WHERE id=7')).rows[0];
 assert.equal(older.edit_revision,2);assert.equal(older.approved_at,null);
 assert.deepEqual(older.packet,p);assert.equal(older.evidence_hash,analyst.packetHash(p));
 await assert.rejects(api.approveAnalysis(changed,7,42,2),/evidence has changed/i);
 }finally{await db.close();}
});
test('editor escapes values, keeps evidence outside text fields and includes review version',()=>{
 const p=analyst.analystPacket(report()),a=draft(p);a.findings[0].title='</textarea><script>bad</script>';
 const row={id:7,packet:p,analysis:a,status:'draft',evidence_hash:analyst.packetHash(p),edit_revision:2,raw_response:'<script>raw</script>'};
 const html=analystPageHtml(report().project,new URLSearchParams(),{...p,hash:row.evidence_hash},[row],'test');
 assert.match(html,/data-analysis-editor/);assert.match(html,/data-revision="2"/);assert.doesNotMatch(html,/<script>bad|<script>raw/);assert.doesNotMatch(html,/data-field="evidence"/);
});

test('older drafts keep a prominent editor but cannot be included',()=>{
 const p=analyst.analystPacket(report()),row={id:7,packet:p,analysis:draft(p),status:'draft',evidence_hash:'older'};
 const html=analystPageHtml(report().project,new URLSearchParams(),{...p,hash:'current'},[row],'test');
 assert.ok(html.indexOf('data-open-editor')<html.indexOf('Latest attempt'));
 assert.match(html,/id="analysis-editor"/);assert.match(html,/data-analysis-editor/);
 assert.match(html,/Editing does not refresh its evidence/);
 assert.doesNotMatch(html,/data-operation="approve"/);
});
test('top edit button opens the editor and focuses the title without a request',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);
 const dom=new JSDOM('<button data-open-editor aria-expanded="false"></button><details id="analysis-editor"><form data-analysis-editor><textarea></textarea></form></details>',{runScripts:'outside-only'});
 try{
 dom.window.HTMLElement.prototype.scrollIntoView=function(){};
 dom.window.fetch=()=>{throw Error('Editing entry must not make a request');};
 dom.window.eval(readFileSync(new URL('../src/public/report-analyst.js',import.meta.url),'utf8'));
 dom.window.document.querySelector('button').click();
 assert.equal(dom.window.document.querySelector('details').open,true);
 assert.equal(dom.window.document.activeElement.tagName,'TEXTAREA');
 assert.equal(dom.window.document.querySelector('button').getAttribute('aria-expanded'),'true');
 }finally{dom.window.close();}
});

test('preparation status agrees with report approval checks without making paid requests',async()=>{
 const r=report(),p=analyst.analystPacket(r),a=draft(p);
 let rows=[],latest=null;
 const api=store({many:async sql=>sql.includes('approved_at IS NOT NULL')?rows:[],one:async sql=>sql.includes('evidence_hash=$2')?(latest?.status==='draft'&&latest.evidence_hash===analyst.packetHash(p)?latest:null):latest,requestAnalysis:()=>{throw Error('No paid calls');}});
 assert.equal((await api.analysisInclusionStatus(r)).state,'none');
 latest={id:1,status:'draft',packet:p,analysis:a,evidence_hash:analyst.packetHash(p)};
 assert.equal((await api.analysisInclusionStatus(r)).state,'draft');
 latest.evidence_hash='old';assert.equal((await api.analysisInclusionStatus(r)).state,'stale');
 latest.status='failed';assert.equal((await api.analysisInclusionStatus(r)).state,'failed');
 latest.status='generating';assert.equal((await api.analysisInclusionStatus(r)).state,'generating');
 rows=[{id:2,analysis:a,packet:p,evidence_hash:analyst.packetHash(p),edit_revision:3}];
 const status=await api.analysisInclusionStatus(r);assert.equal(status.state,'included');assert.equal(status.draftId,2);assert.equal(status.revision,3);
 rows[0].analysis={findings:[]};await assert.rejects(api.analysisInclusionStatus(r));
});

test('matching saved analysis remains prominent after a failed or different-period attempt',()=>{
 const p=analyst.analystPacket(report()),hash=analyst.packetHash(p);
 const current={id:6,packet:p,analysis:draft(p),status:'draft',evidence_hash:hash,requested_model:'different-model'};
 const failed={id:7,status:'failed',evidence_hash:hash,error:'Failed attempt',requested_model:'test'};
 const page=analystPageHtml(report().project,new URLSearchParams(),{...p,hash},[failed,current],'test');
 assert.match(page,/Review saved analysis \(no AI charge\)/);assert.doesNotMatch(page,/data-operation="generate"/);assert.match(page,/data-operation="regenerate"/);assert.match(page,/data-operation="approve" data-id="6"/);assert.match(page,/Draft 7/);
 const outsideRecent=analystPageHtml(report().project,new URLSearchParams(),{...p,hash},[failed],'test',current);
 assert.match(outsideRecent,/data-operation="approve" data-id="6"/);
 const empty=analystPageHtml(report().project,new URLSearchParams(),{...p,hash},[],'test');assert.match(empty,/Generate analysis \(paid\)/);assert.doesNotMatch(empty,/Review saved analysis/);
});
test('real reuse query is scoped by project and evidence, independent of model and API configuration',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE),db=new PGlite();
 const r=report(),p=analyst.analystPacket(r),hash=analyst.packetHash(p);
 try{
 await db.exec('CREATE TABLE report_analyst_drafts(id int,project_id int,evidence_hash text,status text,requested_model text,analysis jsonb,created_at timestamptz default now());');
 for(const [id,projectId,h,status] of [[6,31,hash,'draft'],[7,99,hash,'draft'],[8,31,'different','draft'],[9,31,hash,'failed']])await db.query('INSERT INTO report_analyst_drafts(id,project_id,evidence_hash,status,requested_model,analysis) VALUES($1,$2,$3,$4,$5,$6)',[id,projectId,h,status,'benchmark-candidate',JSON.stringify(draft(p))]);
 const api=store({process:{env:{}},many:async()=>[],pool:{connect:async()=>({release(){},query:(sql,args)=>sql.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,args)})},requestAnalysis:()=>assert.fail('No provider request for saved evidence')});
 assert.equal((await api.generateAnalysis(r,1)).id,6);
 await assert.rejects(api.generateAnalysis(r,1,{regenerate:true}),/not configured/);
 await db.exec("UPDATE report_analyst_drafts SET evidence_hash='old' WHERE id=6");
 await assert.rejects(api.generateAnalysis(r,1),/not configured/);
 }finally{await db.close();}
});
test('preparation finds a current saved draft behind a later failed attempt',async()=>{
 const r=report(),p=analyst.analystPacket(r),matching={id:6,status:'draft',analysis:draft(p),evidence_hash:analyst.packetHash(p),edit_revision:2};
 const api=store({many:async()=>[],one:async(sql,args)=>{assert.equal(args[0],31);if(sql.includes('evidence_hash=$2')){assert.equal(args[1],matching.evidence_hash);return matching;}return {id:7,status:'failed'};},requestAnalysis:()=>assert.fail('No provider request')});
 const result=await api.analysisInclusionStatus(r);assert.equal(result.state,'draft');assert.equal(result.draftId,6);assert.equal(result.revision,2);
});

test('summary recovery restores only omitted metadata and then requires an exact source substring',()=>{
 const source='{"all":{"measuredAnswers":89,"questionsWithUnknownMeasurement":0,"named":{"answers":0,"measuredAnswerDenominator":89,"rate":0,"eligibleQuestionCount":20,"excludedQuestionCount":0,"zeroInMeasuredAnswersQuestionCount":20}}}';
 const record={id:'question-summary',text:source,label:'Totals',link:'#totals'};
 const quote='"measuredAnswers":89,"named":{"answers":0,"measuredAnswerDenominator":89,"rate":0,"eligibleQuestionCount":20,"excludedQuestionCount":0,"zeroInMeasuredAnswersQuestionCount":20';
 const p=analyst.analystPacket(report());p.records.push(record);
 const d=draft(p);d.findings[0].evidence=[{id:record.id,quote}];
 const checked=analyst.validateAnalysis(d,p),ref=checked.findings[0].evidence[0];
 assert.equal(ref.sourceMatch,'source-excerpt-restored');assert.ok(source.includes(ref.quote));assert.equal(d.findings[0].evidence[0].quote,quote);
 assert.match(analystFindingsHtml({analysis:checked,packet:p},{review:true}),/omitted source field was restored/);
 for(const bad of [quote.replace('89','88'),quote.replace('"answers":0','"answers":1'),quote.replace(',"rate":0','')]){
  d.findings[0].evidence[0].quote=bad;assert.throws(()=>analyst.validateAnalysis(d,p),/unverified/);
 }
 assert.equal(analyst.restoreSummaryExcerpt({...record,id:'traffic'},quote),null);
});
test('short quote hints are exact and leave evidence hashes unchanged',()=>{
 const p=analyst.analystPacket(report()),hash=analyst.packetHash(p),hints=analyst.summaryQuoteHints(p);
 assert.equal(hints.length,2);assert.equal(analyst.packetHash(p),hash);
 for(const hint of hints)assert.ok(p.records.find(r=>r.id===hint.id).text.includes(hint.quote));
});

test('all stitched or reordered quotes are rejected together rather than one per recheck',()=>{
 const p=analyst.analystPacket(report()),d=draft(p);
 p.records.push({id:'answer-test',text:JSON.stringify({excerpt:'NEXA is described first. M3 Agency appears next. AdGrow appears last.'})});
 d.findings[0].evidence=[{id:'answer-test',quote:'NEXA... M3 Agency... AdGrow'},{id:'answer-test',quote:'AdGrow... NEXA is described first.'}];
 assert.throws(()=>analyst.validateAnalysis(d,p),e=>/2 unverified/.test(e.message)&&/finding 1: answer-test; finding 1: answer-test/.test(e.message));
});
test('analyst receives measured-engine facts and dated causes without treating no overview as failure',()=>{
 const r=report();r.executive.engineCoverage=[{engine:'chatgpt',measured:20,failed:0},{engine:'gemini',measured:0,failed:12},{engine:'ai_overview',measured:13,unmeasured:7}];
 r.methodNotes=[{at:'2026-10-06',note:'Gemini unavailable',detail:'12 rate-limit failures; 8 remaining checks skipped.'}];
 const p=analyst.analystPacket(r),scope=JSON.parse(p.records.find(x=>x.id==='scope').text);
 assert.deepEqual(scope.measuredEngines,['chatgpt','ai_overview']);
 assert.match(p.records.find(x=>x.id==='collection-notes').text,/rate-limit failures/);
 assert.match(analyst.ANALYST_SYSTEM,/Do not suggest changing question wording/);
 assert.match(analyst.ANALYST_SYSTEM,/Never stitch fragments/);
});
test('source passage selection inserts saved text and rejects invented or mixed references',()=>{
 const p=analyst.analystPacket(report(),[{id:99,engine:'chatgpt',question:'Agency?',response_text:'Raj Digital offers ecommerce services. No certification is stated in this evidence.'}]);
 const d=draft(p);d.findings[0].evidence=[{id:'answer-99',passage:1}];
 const raw=JSON.stringify(d),result=analyst.validateAnalysis(d,p);
 assert.equal(result.findings[0].evidence[0].quote,'Raj Digital offers ecommerce services. No certification is stated in this evidence.');
 assert.equal(JSON.stringify(d),raw);assert.deepEqual(analyst.validateAnalysis(result,p),result);
 for(const ref of [{id:'answer-99',passage:999},{id:'answer-99',passage:0},{id:'answer-99',passage:'1'},{id:'answer-elsewhere',passage:1},{id:'answer-99',passage:1,quote:'Google Premier Partner'}]){
  d.findings[0].evidence=[ref];assert.throws(()=>analyst.validateAnalysis(d,p),/invalid evidence passage/);
 }
});
test('numbered passages preserve Arabic, punctuation and full context within the request budget',async()=>{
 const text=('• وكالة دبي **خدمات** 😀. '.repeat(150))+'Final fact.';
 const p=analyst.analystPacket(report(),[{id:99,engine:'chatgpt',question:'Agency?',response_text:text}]);
 const record=p.records.find(r=>r.id==='answer-99'),parts=analyst.evidencePassages(record);
 assert.equal(parts.map(x=>x.text).join(''),JSON.parse(record.text).excerpt);
 assert.ok(parts.every(x=>x.text.length<=350&&x.text.trim().length>=12));
 let sent;await analyst.requestAnalysis(p,{key:'test',fetcher:async(url,opts)=>{sent=JSON.parse(JSON.parse(opts.body).messages[0].content);return {ok:true,json:async()=>({content:[],stop_reason:'end_turn'})};}});
 const answer=sent.records.find(r=>r.id==='answer-99');assert.equal(answer.context.question,'Agency?');assert.deepEqual(answer.passages,parts);assert.equal(answer.text,undefined);
 assert.ok(JSON.stringify(sent).length<=110000);
});
test('oversized saved evidence is refused before a provider charge',async()=>{
 let called=false;const p={records:[{id:'scope',text:'x'.repeat(110001)}]};
 await assert.rejects(analyst.requestAnalysis(p,{key:'test',fetcher:async()=>{called=true;}}),/No AI request/);assert.equal(called,false);
});
test('provider request enforces JSON schema without changing model, spend limits or retrying',async()=>{
 const p=analyst.analystPacket(report());let calls=0,body;
 await analyst.requestAnalysis(p,{key:'test',model:'claude-sonnet-4-5',fetcher:async(url,opts)=>{
  calls++;body=JSON.parse(opts.body);return {ok:true,json:async()=>({stop_reason:'end_turn',content:[{type:'text',text:'{}'}]})};
 }});
 assert.equal(calls,1);assert.equal(body.model,'claude-sonnet-4-5');assert.equal(body.max_tokens,6000);
 assert.equal(body.output_config.format.type,'json_schema');
 const schema=body.output_config.format.schema;
 assert.deepEqual(schema.required,['findings','limitations']);
 const evidence=schema.properties.findings.items.properties.evidence.items;
 assert.deepEqual(evidence.required,['id','passage']);assert.equal(evidence.properties.passage.type,'integer');assert.equal(evidence.additionalProperties,false);
 assert.doesNotMatch(JSON.stringify(schema),/"(?:maxItems|maxLength|minLength|minimum|maximum)":/);
 assert.match(analyst.ANALYST_SYSTEM,/revised or expanded question set is NOT like-for-like/);
 assert.match(analyst.ANALYST_SYSTEM,/Re-querying the identical historical dates checks data refresh only/);
});
test('review flags changed-cohort comparisons and historical-window outcome claims',()=>{
 const d=draft(analyst.analystPacket(report())).findings[0];
 d.follow_up='Repeat with revised questions, keeping models consistent for like-for-like comparison.';
 assert.ok(analyst.analysisReviewWarnings(d).some(w=>w.includes('cohort comparability')));
 d.follow_up='Repeat the same date range after visibility improvements.';
 assert.ok(analyst.analysisReviewWarnings(d).some(w=>w.includes('comparison dates')));
});
test('projects without an eligible reviewed decision can generate investigations only',()=>{
 const p=analyst.analystPacket(report());
 const kinds=p=>analyst.analystOutputSchema(p).properties.findings.items.properties.kind.enum;
 assert.deepEqual(kinds(p),['investigate']);
 for(const text of ['{}','{"supportedChange":false}','{"supportedChange":"true"}','bad JSON']){
  assert.deepEqual(kinds({...p,records:[...p.records,{id:'decision-1',text}]}),['investigate']);
 }
 assert.deepEqual(kinds({...p,records:[...p.records,{id:'decision-1',text:'{"supportedChange":true}'}]}),['investigate','proposed_change']);
 assert.deepEqual(analyst.ANALYST_OUTPUT_SCHEMA.properties.findings.items.properties.kind.enum,['investigate','proposed_change']);
});
test('failed raw responses are escaped and inspectable without inclusion controls',()=>{
 const p=analyst.analystPacket(report());p.hash=analyst.packetHash(p);
 const html=analystPageHtml(report().project,new URLSearchParams(),p,[{id:10,status:'failed',evidence_hash:p.hash,raw_response:'<script>alert(1)</script>',error:'Rejected',stop_reason:'end_turn'}],'test');
 assert.match(html,/Inspect failed response \(no AI charge\)/);
 assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
 assert.doesNotMatch(html,/<script>alert|data-operation="approve"|data-open-editor/);
});
test('multiple passages per source retain all evidence while source and total limits stay bounded',()=>{
 const p=analyst.analystPacket(report()),d=draft(p);
 p.records.push(...['review-a','review-b','review-c'].map(id=>({id,text:('Saved '+id+' evidence. ').repeat(30)})));
 d.findings[0].evidence=[{id:'review-a',passage:1},{id:'review-a',passage:2},{id:'review-b',passage:1},{id:'review-b',passage:2},{id:'review-c',passage:1}];
 assert.equal(analyst.validateAnalysis(d,p).findings[0].evidence.length,5);
 d.findings[0].evidence=Array.from({length:13},()=>({id:'scope',passage:1}));
 assert.throws(()=>analyst.validateAnalysis(d,p),/1-12 supporting passages/);
 const sources=Array.from({length:5},(_,i)=>({id:`source-${i}`,text:'A stored source passage with verified text.'}));
 p.records.push(...sources);d.findings[0].evidence=sources.map(r=>({id:r.id,passage:1}));
 assert.throws(()=>analyst.validateAnalysis(d,p),/four distinct/);
 d.findings[0].evidence=[{id:'scope',passage:1},{id:'scope',passage:999}];
 assert.throws(()=>analyst.validateAnalysis(d,p),/invalid evidence passage/);
});

test('production candidate uses benchmark effort while keeping structured output and limits',async()=>{
 const p=analyst.analystPacket(report());let body;
 await analyst.requestAnalysis(p,{model:'claude-sonnet-5-5',key:'test',fetcher:async(url,opts)=>{body=JSON.parse(opts.body);return {ok:true,json:async()=>({model:'claude-sonnet-5-5',stop_reason:'end_turn',content:[]})};}});
 assert.equal(body.output_config.effort,'medium');assert.equal(body.output_config.format.type,'json_schema');assert.equal(body.max_tokens,6000);
 assert.deepEqual(analyst.analystModelSettings('claude-sonnet-4-5'),{});
});
test('candidate estimates use verified standard rates including separate cache write durations',()=>{
 const cost=analyst.analystCost('claude-sonnet-5-5',{input_tokens:1000,output_tokens:1000,cache_read_input_tokens:1000,cache_creation_input_tokens:2000,cache_creation:{ephemeral_1h_input_tokens:1000}});
 assert.equal(cost.usd,.0186);assert.equal(cost.verified,'2026-10-08');
 assert.equal(analyst.analystCost('claude-sonnet-5-5',{input_tokens:50504,output_tokens:1765}).usd,.118658);
 assert.equal(analyst.analystCost('claude-sonnet-5-5',{input_tokens:0,output_tokens:0}).usd,0);
 assert.equal(analyst.analystCost('claude-sonnet-5-5',{output_tokens:10}),null);
 assert.equal(analyst.analystCost('claude-sonnet-5-5-unknown',{input_tokens:10,output_tokens:10}),null);
});
