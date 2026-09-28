import test from 'node:test';
import assert from 'node:assert/strict';
import {summariseEvidence} from '../src/lib/report-evidence.js';
import {reportActions,evidenceUrl} from '../src/lib/report-actions.js';
import {executiveReportHtml} from '../src/lib/report-executive-html.js';
import {measurementHtml} from '../src/lib/measurement-archive.js';
const base={id:1,prompt_id:1,text:'Best mobile banking apps in Jordan',engine:'chatgpt',ok:true,mentioned:false,cited:true,response_text:'A complete answer.',source_links:[{url:'https://bank.example/app',owned:true},{url:'https://other.example/app',owned:false}]};
const row=(props={})=>({...base,...props});
function fixture(rows){const s=summariseEvidence(rows);return {project:{id:28,name:'Example',domain:'bank.example'},generatedAt:'2026-09-28',trend:{comparable:false},executive:{...s,priorities:reportActions(s,rows),measurement:{id:41,started_at:'2026-09-28',settings:{maxTokens:2000}}}};}
test('citation without naming is actionable and repeat URL citations count once per answer',()=>{
 const rows=[row({source_links:[...base.source_links,...base.source_links]}),row({id:2,engine:'claude'})];const p=fixture(rows).executive.priorities[0];
 assert.match(p.do,/site is cited but your brand is not named/);assert.equal(p.evidence.ownPages[0].answers,2);assert.equal(p.evidence.otherPages[0].answers,2);assert.equal(p.evidence.measured,2);
 assert.equal(p.evidence.engines[0].named,0);assert.deepEqual(p.evidence.engines[0].runIds,[1]);
});
test('no failed or unmatched answer turns into an omission task or source example',()=>{
 const rows=[row(),row({id:2,engine:'claude',ok:false}),row({id:3,engine:'perplexity',mentioned:null})];const plan=fixture(rows).executive.priorities;
 assert.equal(plan[0].owner,'Measurement owner');assert.ok(plan.every(p=>!p.evidence));
});
test('two distinct questions receive weakness and asset tasks without duplicate actions',()=>{
 const rows=[row(),row({id:2,engine:'claude'}),row({id:3,prompt_id:2,text:'Which banks offer savings accounts?',mentioned:true}),row({id:4,prompt_id:2,text:'Which banks offer savings accounts?',engine:'claude',mentioned:true})];
 const ps=fixture(rows).executive.priorities;assert.equal(ps.length,2);assert.deepEqual(ps.map(p=>p.evidence.questionId),[1,2]);assert.match(ps[1].do,/Protect/);
 const html=executiveReportHtml(fixture(rows));assert.match(html,/measurements\/41#run-1/);assert.match(html,/https:\/\/bank.example\/app/);assert.match(html,/2 \/ 2 measured answers for this question/);assert.match(html,/not automatically competitors/);
});
test('single-engine and incomplete samples do not acquire specific content actions',()=>{
 for(const rows of [[row(),row({id:2})],[row(),row({id:2,engine:'claude',response_text:'x'.repeat(7500)})]]) assert.ok(fixture(rows).executive.priorities.every(p=>!p.evidence));
});
test('unsafe URLs are omitted, text escaped, and missing URLs are disclosed',()=>{
 const rows=[row({text:'<img src=x>',source_links:[{url:'javascript:alert(1)',owned:true},{url:'https://user:password@example.com',owned:true}]}),row({id:2,engine:'claude',source_links:[]})];
 const html=executiveReportHtml(fixture(rows));assert.doesNotMatch(html,/href="javascript:|user:password|<img src=x>/);assert.match(html,/No usable page URL was retained/);
 assert.equal(evidenceUrl('data:text/html,hi'),null);
});
test('locale warnings override content actions and archive links reveal the specific retained answer',()=>{
 const f=fixture([row(),row({id:2,engine:'claude'})]);f.executive.localeWarnings=['Wrong location'];const html=executiveReportHtml(f);assert.match(html,/Repeat the measurement/);assert.doesNotMatch(html,/Your cited pages/);
 const archive=measurementHtml(f.project,{id:41,status:'completed',settings:{}},[row()]);assert.match(archive,/id="run-1"/);assert.match(archive,/row.open=true/);
});
