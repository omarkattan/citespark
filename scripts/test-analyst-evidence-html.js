import test from 'node:test';
import assert from 'node:assert/strict';
import {analystEvidenceHtml} from '../src/lib/report-analyst-evidence-html.js';
const render=(id,data,refs,review=false)=>analystEvidenceHtml(refs||[{id,quote:'Exact saved evidence fragment'}],new Map([[id,{id,text:JSON.stringify(data),label:'Source',link:'/api/projects/31/report#evidence'}]]),{review});
test('GA4 aggregate leads, rates use its denominator, and totals remain distinct',()=>{
 const html=render('traffic',{state:'ready',total:3088,conversions:211,coveredFrom:'2026-07-05',coveredTo:'2026-10-02',quality:{state:'ready',sessions:3082,sessionKeyEventRate:0.0613238}});
 assert.ok(html.indexOf('3,082')<html.indexOf('3,088'));assert.match(html,/6.1% of 3,082 sessions/);assert.match(html,/211. Events are not verified leads/);assert.doesNotMatch(html,/Exact saved evidence/);
});
test('unknowns are not zero and unavailable quality is not used',()=>{
 const unknown=render('traffic',{state:'disconnected',total:null,conversions:null});assert.match(unknown,/Not connected/);assert.doesNotMatch(unknown,/> 0|key event rate/);
 const mismatch=render('traffic',{state:'ready',total:0,conversions:0,quality:{state:'mismatch',sessions:99,sessionKeyEventRate:.1}});assert.match(mismatch,/detailed-row total/);assert.doesNotMatch(mismatch,/99|10.0%/);
 assert.match(render('q-1',{text:'Question',named:0,cited:null,measured:5}),/Website citation:<\/b> Not measured/);
});
test('repeated source passages group once and exact references are retained only in review',()=>{
 const refs=[{id:'q-1',quote:'first exact fragment'},{id:'q-1',quote:'second exact fragment'}],data={text:'Which brand?',named:0,cited:0,measured:6};
 const html=render('q-1',data,refs,true);assert.equal((html.match(/View source/g)||[]).length,1);assert.match(html,/first exact fragment/);assert.match(html,/second exact fragment/);
 assert.doesNotMatch(render('q-1',data,refs),/exact fragment/);
});
test('saved reviews retain dates, qualifications and escaping without modifying input',()=>{
 const data={notes:'Reviewed 1 Oct. <script>bad</script> May describe different phases.',outdated:true};const before=JSON.stringify(data);
 const html=render('decision-1',data,undefined,true);assert.match(html,/Reviewed 1 Oct/);assert.match(html,/Marked outdated/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.equal(JSON.stringify(data),before);
});
test('answer quotations and legacy unknown records are preserved, unsafe links are not active',()=>{
 const records=new Map([['answer-1',{id:'answer-1',label:'Answer',text:'{}',link:'javascript:alert(1)'}]]);
 const html=analystEvidenceHtml([{id:'answer-1',quote:'Saved answer <img src=x>'}],records);assert.match(html,/Saved answer &lt;img/);assert.doesNotMatch(html,/href=|<img/);
});

test('evidence dates are readable and timezone-stable',()=>{
 const html=render('question-summary',{cycle:'2026-10-01T00:00:00.000Z',all:{}});
 assert.match(html,/1 Oct 2026/);assert.doesNotMatch(html,/T00:00/);
 const traffic=render('traffic',{state:'ready',from:'2026-07-05',to:'2026-10-02'});assert.match(traffic,/5 Jul 2026 to 2 Oct 2026/);
});

test('client references omit duplicate editorial prose while review retains it',()=>{
 const data={title:'Verify phase facts',notes:'Long saved review with all original qualifications.',outdated:true};
 const refs=[{id:'decision-1',quote:'original qualifications'}];
 const records=new Map([['decision-1',{id:'decision-1',text:JSON.stringify(data),label:'Selected editorial decision',link:'/api/projects/31/report#selected-action-1'}]]);
 const before=JSON.stringify([...records]);
 const client=analystEvidenceHtml(refs,records),review=analystEvidenceHtml(refs,records,{review:true});
 assert.match(client,/Verify phase facts/);assert.match(client,/Marked outdated/);
 assert.match(client,/report#selected-action-1/);assert.doesNotMatch(client,/Long saved review/);
 assert.match(review,/Long saved review/);assert.match(review,/original qualifications/);
 assert.equal(JSON.stringify([...records]),before);
});

test('client answer passages simplify Markdown without inventing a sentence ending',()=>{
 const quote='**Masaar** costs $490,000 (AED 1.8 million).[[1]](https://example.com/page) ليس مؤكداً forest-adjacent';
 const data={id:'answer-1',label:'Stored answer excerpt',text:JSON.stringify({excerpt:quote}),link:'/api/projects/31/measurements/47#run-1'};
 const records=new Map([[data.id,data]]),refs=[{id:data.id,quote}],before=JSON.stringify([data,refs]);
 const client=analystEvidenceHtml(refs,records),review=analystEvidenceHtml(refs,records,{review:true});
 assert.match(client,/Masaar costs \$490,000 \(AED 1.8 million\)\.\[1\]/);
 assert.match(client,/ليس مؤكداً forest-adjacent<\/blockquote>/);
 assert.match(client,/may begin or end mid-sentence/);
 assert.doesNotMatch(client,/\*\*Masaar|https:\/\/example/);
 assert.match(review,/\*\*Masaar\*\*/);assert.match(review,/https:\/\/example/);
 assert.equal(JSON.stringify([data,refs]),before);
});
test('answer formatting never turns embedded HTML or unsafe links into executable markup',()=>{
 const html=render('answer-1',{},[{id:'answer-1',quote:'<img onerror=alert(1)> [click](javascript:alert(1)) **not verified**'}]);
 assert.doesNotMatch(html,/<img|href="javascript/);assert.match(html,/&lt;img/);assert.match(html,/not verified/);
});
