import {collectionDisplayText} from './collection-display.js';
const esc=v=>collectionDisplayText(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=v=>typeof v==='number'&&Number.isFinite(v)?v.toLocaleString('en-US'):'Not measured';
const count=(n,d)=>typeof n==='number'&&typeof d==='number'?`${number(n)} of ${number(d)} measured answers`:'Not measured';
const line=(label,value)=>`<p><b>${esc(label)}:</b> ${esc(value)}</p>`;
// Presentation only. Never rewrite the packet, selected quotations or approved prose.
function savedFacts(record){
 let d;try{d=JSON.parse(record.text);}catch{return null;}
 if(!d||typeof d!=='object')return null;
 if(record.id.startsWith('q-'))return line('Question',d.text)+line('Brand naming',count(d.named,d.measured))+line('Website citation',count(d.cited,d.measured))+line('Failed requests',number(d.failed));
 if(record.id.startsWith('decision-'))return line('Saved review',d.title)+line('Review context',d.outdated?'Marked outdated. Historical editorial evidence.':'Saved editorial evidence, not an independently verified page inspection.')+`<p style="white-space:pre-wrap">${esc(d.notes)}</p>`+(d.notesExcerptOnly?'<p class="small note">Saved note excerpt only.</p>':'');
 if(record.id==='traffic'){
  if(d.state!=='ready')return line('Analytics',d.state==='disconnected'?'Not connected':'Data unavailable')+(d.why?line('Detail',d.why):'');
  const q=d.quality||{},ready=q.state==='ready'&&typeof q.sessions==='number'&&Number.isFinite(q.sessions);
  let html=line('Observed period',`${d.coveredFrom||d.from||'Unknown'} to ${d.coveredTo||d.to||'Unknown'}`)+line(ready?'AI referral sessions (period aggregate)':'AI referral sessions (detailed-row total)',number(ready?q.sessions:d.total));
  if(ready&&d.total!=null&&d.total!==q.sessions)html+=line('Detailed-row total',`${number(d.total)} sessions. Different query totals are disclosed separately. The cause is not established.`);
  html+=line('Key events',`${number(d.conversions)}. Events are not verified leads.`);
  if(ready&&typeof q.sessionKeyEventRate==='number'&&Number.isFinite(q.sessionKeyEventRate))html+=line('Sessions with a key event',`${(100*q.sessionKeyEventRate).toFixed(1)}% of ${number(q.sessions)} sessions`);
  if(d.events?.length)html+=line('Recorded event types',d.events.map(e=>`${e.name}: ${number(e.count)}`).join(' · '));
  return html;
 }
 if(record.id==='question-summary'){
  const a=d.all||{};
  return line('Measurement date',d.cycle||'Unknown')+line('Questions summarised',`${number(d.questionsSummarized)} of ${number(d.questionsTotal)}`)+line('Brand naming',count(a.named?.answers,a.named?.measuredAnswerDenominator))+line('Website citation',count(a.cited?.answers,a.cited?.measuredAnswerDenominator))+'<p class="small note">Measured sample only. Naming and citation overlap. Collection sources are not intent classifications.</p>';
 }
 if(record.id==='competitors')return '<p class="small note">Tracked entities in this saved sample, not a market ranking.</p>'+((d.rows||[]).map(c=>line(c.name||c.domain||'Tracked entity',`Naming: ${count(c.named,c.measured)}. Citation: ${count(c.cited,c.measured)}.`)).join('')||'<p>No tracked competitor results supplied.</p>');
 if(record.id==='trend')return line('Trend',d.comparable===true?'Comparable results available':d.comparable===false?'No comparable trend available':'Comparability unknown')+line('Recorded cycles',number(d.cycles));
 if(record.id==='scope')return line('Measurement date',d.cycle||'Unknown')+((d.engineCoverage||[]).map(e=>line(e.engine,`${number(e.measured)} measured · ${number(e.failed)} failed · ${number(e.unmeasured)} unmeasured`)).join(''));
 if(record.id==='collection-notes')return (d.notes||[]).map(n=>line(n.at||'Date unknown',`${n.note||''} ${n.detail||''}`)).join('')||'<p>No collection notes supplied.</p>';
 return null;
}
export function analystEvidenceHtml(evidence,records,{review=false}={}){
 const groups=new Map();for(const ref of evidence){if(!groups.has(ref.id))groups.set(ref.id,[]);groups.get(ref.id).push(ref);}
 return [...groups].map(([id,refs])=>{
  const record=records.get(id);
  if(!record)return '<p>Saved supporting evidence unavailable.</p>';
  const facts=savedFacts(record);
  const quotes=refs.map(ref=>`<blockquote dir="auto">${esc(ref.quote)}</blockquote>${ref.sourceMatch==='source-excerpt-restored'?'<p class="small note">An omitted source field was restored. The displayed quotation matches the saved evidence exactly.</p>':ref.sourceMatch==='formatting-normalised'?'<p class="small note">Quotation formatting normalised. Wording matched to the stored answer excerpt.</p>':''}`).join('');
  // Links come from the saved packet, but never allow an executable scheme.
  const href=typeof record.link==='string'&&/^\/(?!\/)/.test(record.link)?record.link:null;
  return `<section class="analyst-evidence" style="border-left:3px solid #cad8d4;padding:4px 16px;margin:16px 0;overflow-wrap:anywhere"><p>${href?`<a href="${esc(href)}">${esc(record.label)} · View source</a>`:esc(record.label)}</p>${facts!==null?`<p class="small note">Context from the saved source. This is a readable summary, not a quotation.</p>${facts}${review?`<details class="analyst-exact-evidence"><summary>Exact selected passages</summary>${quotes}</details>`:''}`:quotes}</section>`;
 }).join('');
}
