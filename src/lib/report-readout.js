import { resolvedReportQuestions } from './report-decisions.js';
/** Editorial readout from existing measured facts. No detection, trend or model calls. */
export function reportReadout(executive, review={}) {
 const qs=executive.questions || [];
 const languages=new Map();const origins=new Map();
 for(const q of qs){
  const ar=(String(q.text).match(/[\u0621-\u064a\u066e-\u06d3]/g)||[]).length;
  const latin=(String(q.text).match(/[a-z]/gi)||[]).length;
  const language=ar>latin?'Arabic':latin>ar?'Latin-script':'Other / mixed';
  const source=/gsc/i.test(q.source||'')?'Search Console-derived':['manual','custom'].includes(q.source)?'Manually selected':q.source==='generated'?'Site suggestions':'Other / unrecorded';
  for(const [map,key] of [[languages,language],[origins,source]]){
   const row=map.get(key)||{label:key,questions:0,measured:0,named:0,cited:0};
   row.questions++;row.measured+=q.measured||0;row.named+=q.named||0;row.cited+=q.cited||0;map.set(key,row);
  }
 }
 const clean=qs.filter(q=>q.measured>0 && q.engines?.length>=2 && !q.failed && !q.unmeasured && !q.missing && !q.possiblyTruncated);
 const strength=[...clean].filter(q=>q.cited>0).sort((a,b)=>b.cited/b.measured-a.cited/a.measured||b.named/b.measured-a.named/a.measured||a.id-b.id)[0]||null;
 const resolved=resolvedReportQuestions(review,executive.measurement);
 const gap=[...clean].filter(q=>!resolved.has(String(q.id)) && q.named<q.measured && q.id!==strength?.id).sort((a,b)=>a.named/a.measured-b.named/b.measured||a.cited/a.measured-b.cited/b.measured||a.id-b.id)[0]||null;
 const own=(review.comparisons||[]).find(c=>c.kind==='owned'&&c.method==='Measured in this cycle'&&c.measured===executive.totals.measured&&c.measured>0);
 const peers=own?(review.comparisons||[]).filter(c=>c.kind==='competitor'&&c.method==='Measured in this cycle'&&c.measured===own.measured).sort((a,b)=>b.named-a.named||a.name.localeCompare(b.name)):[];
 return {languages:[...languages.values()],origins:[...origins.values()],strength,gap,own,leader:peers[0]||null};
}
