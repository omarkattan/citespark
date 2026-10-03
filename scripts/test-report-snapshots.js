import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {summariseEvidence} from '../src/lib/report-evidence.js';
import {reportHtml} from '../src/lib/report-html.js';
import {reportPreparationHtml} from '../src/lib/report-preparation.js';
const id='12345678-1234-4234-8234-123456789012';
const rows=[{id:1,prompt_id:1,text:'Who builds homes?',source:'gsc',engine:'chatgpt',ok:true,mentioned:true,cited:false,response_text:'Example answer.',source_links:[]}];
const fixture=()=>({project:{id:31,name:'Arada',domain:'arada.com'},generatedAt:'2026-10-03',period:{from:'2026-10-01',to:'2026-10-01',chosen:true},trend:{comparable:false},executive:{...summariseEvidence(rows,{coverage:{expected:1,missing:0,basis:'recorded-plan'}}),priorities:[],measurement:{id:47,started_at:'2026-10-01',settings:{}}},review:{notes:[],comparisons:[]}});
function module(deps){
 const src=readFileSync(new URL('../src/lib/report-snapshots.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
 const c=vm.createContext({URL,URLSearchParams,reportHtml,...deps});vm.runInContext(src+'\nthis.api={saveReportSnapshot,snapshotDocument,snapshotIdValid,listReportSnapshots};',c);return c.api;
}
test('snapshot stores paired rendered documents and original values, retry never rebuilds',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE),db=new PGlite();
 try{
 await db.exec('CREATE TABLE projects(id int primary key); INSERT INTO projects VALUES(31),(32);');
 const migration='-- Batch 99:'+readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8').split('-- Batch 99:')[1];await db.exec(migration);await db.exec(migration);
 let report=fixture(),builds=0,approved=null;
 const api=module({one:async(sql,args)=>(await db.query(sql,args)).rows[0],many:async(sql,args)=>(await db.query(sql,args)).rows,buildReport:async()=>{builds++;return structuredClone(report);},currentAnalysis:async()=>approved});
 await api.saveReportSnapshot(report.project,id,42,{});
 const saved=(await db.query('SELECT * FROM report_snapshots WHERE id=$1',[id])).rows[0];
 assert.equal(saved.report.executive.totals.cited,0);assert.equal(saved.report.executive.totals.named,1);assert.equal(saved.analysis_state,'none');assert.match(saved.full_html,/Saved report version/);assert.match(saved.full_html,/No reviewed AI analysis included/);
 assert.match(saved.full_html,new RegExp('/snapshots/'+id+'\\?view=ceo'));
 assert.match(saved.ceo_html,new RegExp('/snapshots/'+id));
 assert.doesNotMatch(saved.full_html,/id="refresh-search"|const refreshButton|context-help.js/);
 assert.match(saved.full_html,/Live detailed evidence report/);
 assert.match(saved.full_html,/href="\/api\/projects\/31\/report\?detail=1/);
 report.project.name='Changed';report.executive.totals.named=0;
 await api.saveReportSnapshot(report.project,id,42,{});assert.equal(builds,1);
 assert.equal((await db.query('SELECT full_html FROM report_snapshots WHERE id=$1',[id])).rows[0].full_html,saved.full_html);
 assert.equal((await api.listReportSnapshots(32)).length,0);
 await assert.rejects(api.saveReportSnapshot({id:32},id,42,{}),/unavailable/);
 approved={stale:true};await api.saveReportSnapshot(report.project,'22345678-1234-4234-8234-123456789012',42,{});
 assert.equal((await db.query('SELECT analysis_state FROM report_snapshots WHERE id=$1',['22345678-1234-4234-8234-123456789012'])).rows[0].analysis_state,'stale');
 }finally{await db.close();}
});
test('verification failure prevents a snapshot write and reads stay project scoped',async()=>{
 let writes=0;
 const api=module({one:async sql=>{if(sql.startsWith('INSERT'))writes++;return null;},buildReport:async()=>fixture(),currentAnalysis:async()=>{throw Error('verification failed');}});
 await assert.rejects(api.saveReportSnapshot({id:31},id,42,{}),/verification failed/);assert.equal(writes,0);
 const src=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
 const read=src.split("app.get('/api/projects/:id/report/snapshots/:snapshotId'")[1].split('// Read-only preparation')[0];
 assert.ok(read.indexOf('assertProject')<read.indexOf('await one'));assert.match(read,/id=\$1 AND project_id=\$2/);assert.doesNotMatch(read,/buildReport|reportHtml\(/);
});
test('saving has loading feedback, reports formats and reuses failed request ID',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE),dom=new JSDOM(reportPreparationHtml({id:31,name:'Arada'},[]),{url:'https://cited.ae/api/projects/31/report/prepare',runScripts:'outside-only'}),w=dom.window;
 try{
 const requests=[];let fail=true;
 w.fetch=async(url,options)=>{if(options?.method==='POST'){requests.push(JSON.parse(options.body));return {ok:!fail,json:async()=>fail?{error:'Save interrupted'}:{id}};}return {ok:true,json:async()=>({snapshots:[]})};};
 w.eval(readFileSync(new URL('../src/public/report-snapshots.js',import.meta.url),'utf8'));
 const b=w.document.querySelector('[data-save-snapshot]'),tick=()=>new Promise(r=>setTimeout(r,0));
 b.click();assert.equal(b.disabled,true);await tick();assert.match(w.document.querySelector('[data-snapshot-status]').textContent,/Save interrupted/);
 fail=false;b.click();await tick();assert.equal(requests[0].requestId,requests[1].requestId);
 assert.match(w.document.querySelector('[data-snapshot-status]').textContent,/Saved/);
 assert.equal(w.document.querySelectorAll('[data-snapshot-status] a').length,2);
 }finally{w.close();}
});

test('included analysis is frozen without provider response, usage or editorial history',async()=>{
 let stored;
 const analysis={id:8,edit_revision:2,approved_at:'2026-10-03',raw_response:'private provider response',usage:{input_tokens:20},edit_history:[{analysis:'older'}],packet:{records:[]},analysis:{findings:[{title:'Review attribution',observation:'The brand was named in one collected answer.',implication:'This sample cannot establish a wider trend.',action:'Review the saved answer.',done_when:'Evidence reviewed.',follow_up:'Repeat the same question.',kind:'investigate',evidence:[]}],limitations:['One answer only.']}};
 const api=module({buildReport:async()=>fixture(),currentAnalysis:async()=>analysis,one:async(sql,args)=>{
  if(sql.startsWith('INSERT')){stored=args;return {id};}return stored?{id,project_id:31}:null;
 }});
 await api.saveReportSnapshot({id:31},id,42,{});
 assert.equal(stored[3],'included');assert.equal(stored[4].analyst.edit_revision,2);
 assert.equal(stored[4].analyst.raw_response,undefined);assert.equal(stored[4].analyst.usage,undefined);assert.equal(stored[4].analyst.edit_history,undefined);
 assert.match(stored[5],/Reviewed AI analysis included/);
});
