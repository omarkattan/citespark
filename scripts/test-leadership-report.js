import test from 'node:test';
import assert from 'node:assert/strict';
import {reportTitle,leadershipBrief} from '../src/lib/report-brief.js';
import {reportNoteDraft} from '../src/lib/report-note.js';
import {reportHtml} from '../src/lib/report-html.js';
import {summariseEvidence} from '../src/lib/report-evidence.js';
import {writeFileSync} from 'node:fs';
const executive={...summariseEvidence([{prompt_id:1,text:'Which bank offers easy transfers?',source:'manual',engine:'chatgpt',ok:true,mentioned:true,cited:false,response_text:'Complete answer.'},{prompt_id:1,text:'Which bank offers easy transfers?',source:'manual',engine:'perplexity',ok:true,mentioned:false,cited:true,response_text:'Complete answer.'}]),measurement:{id:45,started_at:'2026-09-29',settings:{maxTokens:2000}},cycle:'2026-09-29',priorities:[{do:'Inspect the transfer answers',because:'Engines gave different results.',owner:'Content team',done:'Evidence reviewed.'}]};
const r={project:{id:28,name:'Example Bank',domain:'bank.example'},generatedAt:'2026-09-30',executive,trend:{comparable:false},review:{notes:[{title:'Link the app page to existing transfer options',notes:'Review decision: Ready to implement\nPage: https://bank.example/app\nEvidence reviewed: Two measured answers. The existing transfer hub covers available options.\nChange or decision: Add a descriptive link to the existing transfer hub. Keep the instructions link.\nArabic label: قارن خيارات التحويل\nThis is an editorial decision, not a measured outcome.',selected_at:'2026-09-30'}],comparisons:[]}};
test('titles end at word boundaries with visible truncation and preserve short Arabic titles',()=>{
 const text='Add a descriptive link beside the existing payments section so customers can compare the transfer options already available from the bank';const title=reportTitle(text);assert.ok(title.length<=120);assert.ok(title.endsWith('…'));assert.ok(text.startsWith(title.slice(0,-1)+' '));assert.equal(reportTitle('قارن خيارات التحويل'),'قارن خيارات التحويل');
 assert.equal(reportNoteDraft({title:'Legacy',review_decision:{change:text,stage:'ready'}}).title,title);
});
test('brief makes no trend claim without comparable data and never treats selection as approval',()=>{
 const b=leadershipBrief(r,{});assert.match(b.change,/No comparable movement/);assert.match(b.next,/does not mean implementation is approved/);
 assert.match(leadershipBrief({...r,review:{}},{}).next,/No team recommendations/);
 assert.match(leadershipBrief({...r,trend:{comparable:true,change:0,cycles:2}},{}).change,/0.0 percentage points/);
 assert.match(leadershipBrief({...r,executive:{...executive,localeWarnings:['Wrong country']}},{}).next,/corrected settings/);
});
test('report leads with decisions, preserves saved text, separates investigations and escapes HTML',()=>{
 const html=reportHtml(r);assert.ok(html.indexOf('Leadership brief')<html.indexOf('Executive readout'));assert.ok(html.indexOf('The decisions to take forward')<html.indexOf('What still needs checking'));assert.match(html,/قارن خيارات التحويل/);assert.match(html,/1 \/ 2 measured answers/);
 const unsafe=reportHtml({...r,review:{notes:[{title:'<script>bad()</script>',notes:'<img src=x>',selected_at:'2026-09-30'}]}});assert.doesNotMatch(unsafe,/<script>bad/);assert.match(unsafe,/&lt;img/);
 if(process.env.REPORT_PREVIEW)writeFileSync(process.env.REPORT_PREVIEW,html);
});

test('summary uses measured source groups without inventing intent or a trend',()=>{
 const origins=[{label:'Search Console-derived',questions:8,measured:47,named:39,cited:31},{label:'Site suggestions',questions:20,measured:118,named:23,cited:4}];
 const b=leadershipBrief(r,{origins,gap:{text:'SINGLE QUESTION',named:0,cited:0,measured:6}});
 assert.match(b.matters,/39 \/ 47/);assert.match(b.matters,/4 \/ 118/);assert.match(b.matters,/different question sets/);assert.match(b.matters,/Review answers and cited pages for site suggestions/);assert.doesNotMatch(b.matters,/SINGLE QUESTION|development-specific|broad discovery/);
 for(const patch of [{measured:0},{questions:1},{named:null}])assert.doesNotMatch(leadershipBrief(r,{origins:[{...origins[0],...patch},origins[1]]}).matters,/Visibility differs/);
 assert.doesNotMatch(leadershipBrief(r,{origins:[origins[0],{...origins[1],named:95}]}).matters,/Visibility differs/);
 assert.doesNotMatch(leadershipBrief({...r,executive:{...executive,localeWarnings:['Wrong market']}},{origins}).matters,/Visibility differs/);
});
test('specific next step prioritises a current structured ready decision over investigation',async()=>{
 const {decisionReportText}=await import('../src/lib/recommendation-decision.js');
 const decision={stage:'ready',title:'Fix phase facts',page:'https://example.com/phase',evidence:'Reviewed page',change:'Confirm the phase and correct inconsistent facts.',suggested_owner:'Project marketing'};
 const note=d=>({title:d.title,notes:decisionReportText(d),decision_snapshot:d});
 const review={notes:[note({...decision,stage:'investigate',title:'Review enquiries'}),note(decision)]};
 const b=leadershipBrief({...r,review},{});assert.match(b.next,/First selected ready action: Fix phase facts/);assert.match(b.next,/https:\/\/example.com\/phase/);assert.match(b.next,/Suggested owner: Project marketing/);assert.match(b.next,/before approving implementation/);
 const stale={...review,notes:[{...review.notes[1],outdated:true}]};assert.match(leadershipBrief({...r,review:stale},{}).next,/Review and update/);
 const mismatch={notes:[{...review.notes[1],notes:'Unstructured legacy copy'}]};assert.doesNotMatch(leadershipBrief({...r,review:mismatch},{}).next,/First selected ready action/);
 const investigate={notes:[review.notes[0]]};assert.match(leadershipBrief({...r,review:investigate},{}).next,/First selected investigation/);assert.match(leadershipBrief({...r,review:investigate},{}).next,/before approving any content change/);
 const noChange={notes:[note({...decision,stage:'no_change'})]};assert.doesNotMatch(leadershipBrief({...r,review:noChange},{}).next,/First selected/);
 assert.match(leadershipBrief({...r,review,executive:{...executive,localeWarnings:['Wrong market']}},{}).next,/corrected settings/);
});
