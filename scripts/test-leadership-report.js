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
