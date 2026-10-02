import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {summariseEvidence} from '../src/lib/report-evidence.js';
import {reportActions} from '../src/lib/report-actions.js';
import {executiveReportHtml} from '../src/lib/report-executive-html.js';
const rows=Array.from({length:30},(_,i)=>['chatgpt','claude','perplexity','ai_mode','ai_overview'].map((engine,j)=>({id:i*5+j+1,prompt_id:i+1,text:i%2?'ما البنوك في الأردن التي تتيح فتح حساب جاري بالكامل من تطبيق الهاتف؟':`Which banks offer suitable accounts and clear transfer options for customer group ${i+1}?`,source:i<2?'gsc':i<12?'generated':'custom',engine,ok:!(j===4&&i<2),mentioned:i===2?false:j<3,cited:j<3,response_text:'A complete sample answer.',source_links:[{url:'https://example.test/accounts',owned:true},{url:'https://other.test/accounts',owned:false}]}))).flat();
const summary=summariseEvidence(rows,{coverage:{expected:150,missing:0,basis:'recorded-plan'}});
const fixture=()=>({project:{id:28,name:'Presentation test',domain:'example.test'},generatedAt:'2026-09-29',trend:{comparable:false},executive:{...summary,priorities:reportActions(summary,rows),measurement:{id:43,started_at:'2026-09-29',settings:{maxTokens:2000}}}});
test('partial collection is disclosed without displacing actions from complete question samples',()=>{
 const f=fixture(),html=executiveReportHtml(f);
 const plan=html.slice(html.indexOf('What still needs checking'),html.indexOf('<p class="kicker">Supporting evidence'));
 assert.match(plan,/site is cited but your brand is not named/);assert.doesNotMatch(plan,/Resolve incomplete evidence/);
 assert.match(html,/148 measured answers from 150 expected checks/);assert.match(html,/2 failed calls excluded/);
 assert.match(html,/id="collection-review"/);assert.match(html,/Affected question/);assert.doesNotMatch(html,/0 measured answers may be cut short/);
 assert.equal(f.executive.totals.measured,148);assert.equal(f.executive.priorities[0].owner,'Measurement owner');
});
test('all-failed and wrong-locale samples keep measurement work prominent',()=>{
 const f=fixture();const failedRows=rows.map(x=>({...x,ok:false}));const s=summariseEvidence(failedRows);f.executive={...f.executive,...s,priorities:reportActions(s,failedRows)};
 let html=executiveReportHtml(f);assert.match(html,/Resolve incomplete evidence/);assert.match(html,/Not measured/);assert.doesNotMatch(html,/Your cited pages/);
 f.executive={...fixture().executive,localeWarnings:['Wrong country']};html=executiveReportHtml(f);assert.match(html,/Rerun before presenting/);assert.match(html,/Repeat the measurement with corrected/);assert.doesNotMatch(html,/Your cited pages/);
});
test('unknown coverage and short-answer caveats stay explicit',()=>{
 const f=fixture();f.executive={...f.executive,totals:{...summary.totals,missingChecks:null,expectedChecks:null,possiblyTruncated:1}};
 const html=executiveReportHtml(f);assert.match(html,/Planned coverage is unknown/);assert.match(html,/1 possibly short answers remain included/);assert.match(html,/absence in those answers is not conclusive/);
});
test('legacy print parameter no longer opens a dialog on load and report links keep date filters',()=>{
 const html=executiveReportHtml(fixture(),{print:true});assert.match(html,/onclick="window.print\(\)"/);assert.doesNotMatch(html,/addEventListener\("load"/);
 const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');assert.doesNotMatch(app,/report\?print=1/);assert.match(app,/Open client report/);
 const {start,end}= {start:app.indexOf("document.addEventListener('change', (e) => {\n  if (e.target.id !== 'repFrom'"),end:app.indexOf("document.addEventListener('input', (e) => {\n  if (e.target.id === 'pcSearch'")};
 assert.ok(start>=0&&end>start);let callback;const state={projectId:28};const nodes={repFrom:{value:'2026-09-01'},repTo:{value:'2026-09-29'},repOpen:{},repCsv:{},repPrepare:{}};
 new Function('document','state','$',app.slice(start,end))({addEventListener:(_,cb)=>callback=cb},state,id=>nodes[id]);callback({target:{id:'repFrom'}});
 assert.equal(nodes.repOpen.href,'/api/projects/28/report/open?from=2026-09-01&to=2026-09-29');assert.equal(nodes.repPrepare.href,'/api/projects/28/report/prepare?from=2026-09-01&to=2026-09-29');assert.equal(nodes.repCsv.href,'/api/projects/28/report?format=csv&from=2026-09-01&to=2026-09-29');
 nodes.repFrom.value='';nodes.repTo.value='';callback({target:{id:'repTo'}});assert.equal(nodes.repOpen.href,'/api/projects/28/report/open');
});
if(process.env.REPORT_PREVIEW){
 const f=fixture();f.review={notes:[{title:'Reviewed recommendation: improve transfer choices on existing pages',selected_at:'2026-09-29',notes:process.env.REPORT_NOTE?readFileSync(process.env.REPORT_NOTE,'utf8'):'A short selected note.'}],comparisons:[{name:'Example bank',kind:'owned',measured:148,named:73,cited:73,method:'Measured in this cycle'},{name:'Example competitor',kind:'competitor',measured:148,named:77,cited:53,method:'Measured in this cycle'}]};
 f.methodNotes=[{at:'2026-09-29',note:'Question set expanded',detail:'The sample changed from 10 to 30 questions. Compare only the same question-and-engine cohort.'}];f.caveats=['Counts come from stored answers. Unmeasured is not zero.','A citation does not establish relevance or explain selection. Review the exact question, answer and page.'];
 writeFileSync(process.env.REPORT_PREVIEW,executiveReportHtml(f));
}
