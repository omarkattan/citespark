import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {ceoReportHtml,reportViewUrl} from '../src/lib/report-ceo.js';
import {reportHtml} from '../src/lib/report-html.js';
import {reportPreparationHtml} from '../src/lib/report-preparation.js';
import {decisionReportText} from '../src/lib/recommendation-decision.js';
import {summariseEvidence} from '../src/lib/report-evidence.js';
const answers=Array.from({length:30},(_,i)=>({prompt_id:i+1,text:i%2?'هل يمكن للمقيم فتح حساب بنكي في الأردن؟':'Which bank offers easy transfers?',source:i%3?'manual':'gsc',engine:'chatgpt',ok:true,mentioned:i%2===0,cited:i%2===0,response_text:'Complete answer.'}));
const executive={...summariseEvidence(answers),measurement:{id:45,started_at:'2026-09-29',settings:{maxTokens:2000}},cycle:'2026-09-29',priorities:[]};
const d={stage:'ready',title:'Link the app page to existing transfer options',page:'https://bank.example/app',change:'Add “Compare transfer options” beside Payments on the English app page. Add “قارن خيارات التحويل” on the Arabic page. Keep the existing how-to link. Do not introduce unverified claims about fees, speed or eligibility.',evidence:'Two engines cited the existing page. The current transfer hub already lists the available options.',purpose:'Help customers compare existing transfer information without creating another hub.',suggested_owner:'Web content and digital product. A named owner still needs to be assigned.',completion:'Check both language links on mobile and desktop.',follow_up:'Repeat the same questions and engines after publication.',reviewed_at:'2026-09-30'};
const note={status:'open',recommendation_id:8502,title:d.title,notes:decisionReportText(d),decision_snapshot:d,selected_at:'2026-09-30'};
const brand=(name,kind='competitor',props={})=>({name,kind,domain:'bank.example',method:'Measured in this cycle',measured:30,named:15,cited:10,...props});
const r={project:{id:28,name:'Example Bank',domain:'bank.example'},generatedAt:'2026-10-01',executive,trend:{comparable:false},period:{chosen:true,from:'2026-09-01',to:'2026-09-30'},review:{notes:[note],comparisons:[brand('Example Bank','owned'),brand('Bank A'),brand('Bank B')]}};
test('brief preserves denominator, separates outcomes and has date-preserving evidence links',()=>{
 const html=reportHtml(r,{ceo:true});assert.match(html,/CEO BRIEF/);assert.match(html,/15 \/ 30 measured answers/);assert.match(html,/Naming and citation overlap/);assert.match(html,/No comparable movement/);assert.match(html,/#selected-action-8502/);assert.match(html,/from=2026-09-01&amp;to=2026-09-30/);assert.equal(reportViewUrl(r,'ceo'),'/api/projects/28/report?view=ceo&from=2026-09-01&to=2026-09-30');
 assert.match(reportHtml(r),/id="selected-action-8502"/);assert.match(reportHtml(r),/view=ceo/);
});
test('only same-cycle full comparisons enter CEO table and tied leaders are explicit',()=>{
 const html=ceoReportHtml({...r,review:{...r.review,comparisons:[...r.review.comparisons,brand('PARTIAL','competitor',{measured:3}),brand('RETRO','competitor',{method:'Retrospective'}),brand('LIMITED','competitor',{limited:true})]}});
 assert.match(html,/Joint highest/);assert.match(html,/Bank A, Bank B/);assert.doesNotMatch(html,/PARTIAL|RETRO|LIMITED/);
 assert.match(ceoReportHtml({...r,review:{notes:[],comparisons:[]}}),/No matched competitor comparison/);
});
test('shortened decisions use selected snapshot, never current edits, and warn when outdated',()=>{
 const html=ceoReportHtml({...r,review:{notes:[{...note,outdated:true},note,note,{...note,title:'FOURTH'}]}});
 assert.match(html,/this report copy differs/);assert.match(html,/1 additional selected decision/);assert.doesNotMatch(html,/FOURTH/);assert.match(html,/shortened reading notes/);assert.match(html,/قارن خيارات التحويل/);
 const legacy=ceoReportHtml({...r,review:{notes:[{...note,notes:'Saved legacy text',decision_snapshot:{...d,change:'UNSAVED CHANGE'}}]}});
 assert.match(legacy,/Saved legacy text/);assert.doesNotMatch(legacy,/UNSAVED CHANGE/);
});
test('unknown and zero remain distinct, bad setup stays visible, no decisions fabricated',()=>{
 const empty={...r,executive:{...executive,totals:{...executive.totals,measured:0,named:0,cited:0,expectedChecks:null},localeWarnings:['Wrong locale']},review:{notes:[],comparisons:[]}};
 const html=ceoReportHtml(empty);assert.match(html,/Not measured/);assert.match(html,/Planned coverage unknown/);assert.match(html,/Diagnostic results only/);assert.match(html,/No reviewed decisions selected/);
 assert.match(ceoReportHtml({...r,executive:{...executive,totals:{...executive.totals,named:0}}}),/0 \/ 30 measured answers/);
});
test('preparation heading follows reviewed decision without rewriting saved report copy',()=>{
 const html=reportPreparationHtml(r.project,[{id:1,status:'open',title:'Invisible for: Old question',saved_title:'Old selected title',saved_notes:'Old copy',selected_at:'2026-09-30',review_decision:{stage:'no_change',change:'Keep the existing document checklist.'}}]);
 assert.match(html,/<h3 dir="auto">Keep the existing document checklist\.<\/h3>/);assert.doesNotMatch(html,/<h3[^>]*>Invisible/);assert.match(html,/Preview executive brief/);
});
test('escapes fields and renders fixture for visual review',()=>{
 assert.doesNotMatch(ceoReportHtml({...r,project:{...r.project,name:'<img src=x>'}}),/<img src=x>/);
 if(process.env.CEO_PREVIEW){writeFileSync(process.env.CEO_PREVIEW,ceoReportHtml({...r,review:{...r.review,notes:[note,note,note]}}));writeFileSync(process.env.CEO_PREVIEW.replace('.html','-long.html'),ceoReportHtml({...r,review:{...r.review,notes:[{...note,title:'قرار مراجعة محتوى التحويلات البنكية',notes:'مراجعة المحتوى والتحقق من الروابط والأدلة. '.repeat(150),decision_snapshot:null}]}}));}
});

test('retrospective checks have a separate alphabetical table, review dates and their own denominators',()=>{
 const html=ceoReportHtml({...r,review:{notes:[],comparisons:[brand('Example Bank','owned'),brand('Zeta','competitor',{method:'Retrospective analysis',measured:12,named:0,cited:null,reviewedAt:'2026-10-01'}),brand('<Alpha>','competitor',{method:'Retrospective analysis',measured:30,named:20,cited:0,reviewedAt:'2026-09-30'})]}});
 assert.match(html,/Competitors checked after collection/);assert.match(html,/No full-sample competitor comparison from the original measurement/);
 const table=html.split('aria-label="Retrospective competitor checks"')[1].split('</table>')[0];
 assert.ok(table.indexOf('&lt;Alpha&gt;')<table.indexOf('Zeta'));assert.doesNotMatch(table,/Example Bank/);
 assert.match(table,/0 \/ 12/);assert.match(table,/0 \/ 30/);assert.match(table,/Not measured/);assert.match(table,/1 Oct 2026/);assert.match(table,/30 Sept 2026/);
 assert.match(html,/do not establish a trend/);assert.match(html,/do not prove identical answer coverage/);assert.doesNotMatch(html,/Highest competitor|Joint highest|No matched competitor comparison/);
});
test('mixed evidence keeps original leaders separate and excludes limited or unmeasured rechecks',()=>{
 const html=ceoReportHtml({...r,review:{...r.review,comparisons:[...r.review.comparisons,brand('Later check','competitor',{method:'Retrospective analysis',named:29}),brand('Limited recheck','competitor',{method:'Retrospective analysis',limited:true}),brand('Empty recheck','competitor',{method:'Retrospective analysis',measured:0})]}});
 assert.match(html,/Joint highest[^<]*<b>Bank A, Bank B/);assert.match(html,/Later check/);assert.doesNotMatch(html,/Limited recheck|Empty recheck/);
 const table=html.split('aria-label="Retrospective competitor checks"')[1].split('</table>')[0];assert.doesNotMatch(table,/Bank A|Bank B/);
});
test('retrospective display is bounded without silently omitting other checked brands',()=>{
 const peers=Array.from({length:7},(_,i)=>brand('Peer '+i,'competitor',{method:'Retrospective analysis'}));
 const html=ceoReportHtml({...r,review:{notes:[],comparisons:peers}});assert.match(html,/2 more in the full report/);assert.match(html,/Peer 4/);assert.doesNotMatch(html,/Peer 5|Peer 6/);
 if(process.env.CEO_PREVIEW)writeFileSync(process.env.CEO_PREVIEW.replace('.html','-retrospective.html'),ceoReportHtml({...r,review:{...r.review,comparisons:peers}}));
});

test('CEO saved decisions retain their text with current work status and escaped owner',()=>{
 const html=ceoReportHtml({...r,review:{notes:[{...note,status:'done',assignee:'<img src=x>'}]}});
 assert.match(html,/Current work status: Marked complete/);assert.match(html,/&lt;img src=x&gt;/);assert.match(html,/not a verified visibility improvement/);assert.doesNotMatch(html,/<img src=x>/);assert.match(html,/No selected work remains open/);assert.match(html,/Keep the existing how-to link/);
});
test('contents links resolve once in both formats, including optional sections, with printable navigation',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);
 for(const full of [r,{...r,review:{notes:[],comparisons:[]},executive:{...r.executive,questions:[],totals:{...r.executive.totals,failed:1}}}])for(const ceo of [true,false]){
  const html=reportHtml(full,{ceo}),doc=new JSDOM(html).window.document;
  const nav=doc.querySelector('nav[aria-label="Report contents"]');assert.ok(nav);assert.ok(nav.querySelectorAll('a').length>=4);
  for(const link of nav.querySelectorAll('a'))assert.equal(doc.querySelectorAll(link.getAttribute('href')).length,1,link.textContent);
  assert.equal(doc.querySelector('.report-back-top').getAttribute('href'),'#report-contents');assert.equal(doc.querySelector('.report-back-top').getAttribute('aria-label'),'Back to report contents');
  assert.match(html,/@media print\{\.report-back-top\{display:none!important/);assert.match(html,/prefers-reduced-motion:no-preference/);
 }
});
