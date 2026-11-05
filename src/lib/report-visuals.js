import {collectionDisplayText} from './collection-display.js';
const esc=v=>collectionDisplayText(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={chatgpt:'ChatGPT',perplexity:'Perplexity',claude:'Claude',gemini:'Gemini',ai_mode:'Google AI Mode',ai_overview:'Google AI Overview'};
const rate=(n,d)=>Number.isFinite(n)&&d>0?100*n/d:null;
export const reportRate=(n,d)=>rate(n,d)==null?'Not measured':n>0&&rate(n,d)<.1?'&lt;0.1%':`${Math.round(rate(n,d)*10)/10}%`;
const fmt=(n,d)=>rate(n,d)==null?'Not measured':`${reportRate(n,d)} · ${n} / ${d}`;
const width=(n,d)=>Math.max(0,Math.min(100,rate(n,d)||0));
function pair(label,row,sub=''){
 return `<div class="vis-row"><div class="vis-row-title"><b dir="auto">${esc(label)}</b>${sub?`<small>${esc(sub)}</small>`:''}</div><div class="vis-pair">${['named','cited'].map((key,i)=>`<div class="vis-line"><span class="vis-line-label">${i?'Cited':'Named'}</span><span class="vis-track" aria-hidden="true"><span class="vis-fill ${key}" style="width:${width(row[key],row.measured)}%"></span></span><strong>${fmt(row[key],row.measured)}</strong></div>`).join('')}</div></div>`;
}
export function reportVisualGroups(questions=[]){
 const topics=new Map(),languages=new Map();
 for(const q of questions){
  const topic=String(q.cluster||'Unclassified').trim()||'Unclassified';
  const recorded=q.originDetails?.language;
  const language=recorded==='ar'?'Arabic':recorded==='en'?'English / Latin script':/[\u0621-\u064a]/u.test(q.text||'')?'Arabic':/[a-z]/i.test(q.text||'')?'English / Latin script':'Other / mixed';
  for(const [map,label] of [[topics,topic],[languages,language]]){
   const group=map.get(label)||{label,questions:0,measured:0,named:0,cited:0};
   group.questions++;for(const key of ['measured','named','cited'])group[key]+=Number(q[key])||0;map.set(label,group);
  }
 }
 return {topics:[...topics.values()].sort((a,b)=>b.questions-a.questions||a.label.localeCompare(b.label)),languages:[...languages.values()]};
}
export function reportVisualOverview(e,{compact=false}={}){
 const groups=reportVisualGroups(e.questions),engines=e.engineCoverage||[];
 const limit=compact?8:12,topics=groups.topics.slice(0,limit);
 const expected=e.totals?.expectedChecks,measured=e.totals?.measured||0;
 const enginesHtml=engines.length?engines.map(x=>pair(names[x.engine]||x.engine,x,`${x.measured} measured · ${(x.failed||0)+(x.unmeasured||0)} failed / unmeasured${x.missingChecks?` · ${x.missingChecks} missing`:''}`)).join(''):'<p class="vis-note">Engine breakdown is unavailable for this saved report.</p>';
 return `<div class="vis-overview"><div class="vis-intro"><div><span class="vis-kicker">Evidence at a glance</span><h2>Where are you being found?</h2></div><div class="vis-scope"><strong>${measured.toLocaleString('en-GB')}</strong><span>measured answers${expected!=null?` of ${expected.toLocaleString('en-GB')} planned`:''}</span></div></div>
 <p class="vis-note">Each bar uses its own measured-answer denominator. Naming and website citations overlap. Missing checks are excluded, never scored as zero.</p>
 <div class="vis-grid"><section class="vis-panel"><h3>By AI surface</h3>${enginesHtml}</section><section class="vis-panel"><h3>By buyer topic</h3>${topics.length?topics.map(x=>pair(x.label,x,`${x.questions} questions`)).join(''):'<p class="vis-note">No question evidence available.</p>'}${groups.topics.length>limit?`<p class="vis-note">Showing ${limit} of ${groups.topics.length} topics by question count. See the question appendix for the remainder.</p>`:''}</section></div>
 <div class="vis-language"><h3>Language coverage</h3>${groups.languages.map(x=>`<div><b>${esc(x.label)}</b><strong>${x.questions}</strong><small>questions · ${x.measured} measured answers</small><span>Named ${fmt(x.named,x.measured)} · Cited ${fmt(x.cited,x.measured)}</span></div>`).join('')}</div><p class="vis-note">Language labels use recorded import metadata where available, otherwise question script. Topics and languages can contain different questions, so comparisons do not isolate cause.</p></div>`;
}
export function comparisonVisual(rows=[]){
 return rows.length?`<div class="vis-comparison" aria-label="Matched competitor visibility chart">${rows.map(x=>pair(x.name+(x.kind==='owned'?' · your brand':''),x,x.domain||'')).join('')}</div>`:'';
}
export const reportVisualCss=`
.vis-overview{margin:24px 0}.vis-intro{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.vis-kicker{display:block;color:#087e83;font-size:10px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;margin-bottom:10px}.vis-intro h2{font-family:inherit;font-size:30px;letter-spacing:-.04em;font-weight:750;margin:0 0 14px}.vis-scope{text-align:right;min-width:135px}.vis-scope strong{display:block;font-size:32px;letter-spacing:-.04em}.vis-scope span{display:block;font-size:11px;color:#526a6f}.vis-note{font-size:11px;line-height:1.5;color:#526a6f;margin:10px 0 16px}.vis-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.vis-panel{margin:0;padding:20px;border:1px solid #d9e3e1;border-radius:12px;background:white}.vis-panel h3{font-size:16px;margin:0 0 18px}.vis-row{margin-bottom:16px;break-inside:avoid}.vis-row:last-child{margin-bottom:0}.vis-row-title{display:flex;justify-content:space-between;gap:10px;align-items:baseline;margin-bottom:7px;font-size:12px}.vis-row-title b{text-transform:capitalize}.vis-row-title small{font-size:9px;color:#526a6f}.vis-line{display:grid;grid-template-columns:33px minmax(40px,1fr) 99px;align-items:center;gap:7px;margin:4px 0}.vis-line-label{font-size:9px;color:#526a6f}.vis-line strong{font-size:10px;text-align:right;white-space:nowrap;font-weight:650}.vis-track{height:7px;display:block;background:#e9efee;border-radius:8px;overflow:hidden}.vis-fill{height:100%;display:block;background:#087e83;border-radius:8px}.vis-fill.cited{background:#7757b5}.vis-language{display:flex;gap:18px;margin-top:20px;padding:16px 20px;background:#edf4f2;border-radius:12px;align-items:center;flex-wrap:wrap}.vis-language h3{font-size:13px;width:110px;margin:0}.vis-language>div{flex:1;min-width:150px;display:grid;grid-template-columns:1fr auto;gap:3px 12px}.vis-language strong{font-size:20px;grid-column:2;grid-row:1/3}.vis-language b{font-size:11px}.vis-language small{font-size:10px}.vis-language span{font-size:9px;grid-column:1/3}.vis-comparison{margin:22px 0}.vis-comparison .vis-row{border-bottom:1px solid #e3eae8;padding:0 0 15px}.vis-comparison .vis-row:first-child{background:#edf4f2;padding:16px;border-radius:10px}.vis-comparison .vis-line{grid-template-columns:40px 1fr 120px}.vis-comparison .vis-line strong{font-size:12px}.vis-comparison .vis-track{height:9px}
@media(max-width:700px){.vis-grid{grid-template-columns:1fr}.vis-intro{display:block}.vis-scope{text-align:left;margin-bottom:15px}.vis-row-title{display:block}.vis-row-title small{display:block}.vis-panel{padding:15px}}
@media print{.vis-overview{margin:12px 0}.vis-panel{padding:12px}.vis-grid{gap:14px;grid-template-columns:1fr 1fr}.vis-row{margin-bottom:10px}.vis-row-title{font-size:9px;display:block}.vis-row-title small{font-size:8px;display:block}.vis-line{grid-template-columns:27px minmax(20px,1fr) 78px;gap:4px}.vis-line strong{font-size:8px}.vis-line-label{font-size:8px}.vis-track{height:5px}.vis-note{font-size:9px;margin:8px 0 12px}.vis-panel h3{font-size:12px;margin-bottom:12px}.vis-intro h2{font-size:22px}.vis-language{padding:12px;margin-top:14px}.vis-language h3{width:80px}.vis-language>div{min-width:120px}.vis-comparison .vis-row{margin-bottom:8px;padding-bottom:9px}.vis-comparison .vis-row:first-child{padding:12px}.vis-comparison .vis-line strong{font-size:10px}.vis-comparison .vis-track{height:7px}}
`;
