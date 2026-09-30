/** Presentation only: do not infer implementation readiness from free-form notes. */
export function reportTitle(value, limit=120) {
 const text=String(value || '').trim().replace(/\s+/g,' ');
 if(text.length<=limit)return text;
 const cut=text.slice(0,limit-1);
 const boundary=cut.lastIndexOf(' ');
 return (boundary>limit/2 ? cut.slice(0,boundary) : cut)+'…';
}
export function leadershipBrief(r,readout) {
 const trend=r.trend || {};
 const notes=r.review?.notes || [];
 const setupError=!!r.executive.localeWarnings?.length;
 return {
  change: setupError ? 'Correct the collection settings before making performance claims.' : trend.comparable && trend.change!=null
   ? `Comparable visibility changed by ${trend.change>0?'+':''}${(trend.change*100).toFixed(1)} percentage points across ${trend.cycles} selected cycles. This uses common question-and-engine pairs, not necessarily the headline sample.`
   : 'Use this as a baseline. No comparable movement is established for the selected period.',
  matters:setupError ? 'This measurement is diagnostic, not a validated baseline for the intended market.' : readout.gap
   ? `Review “${readout.gap.text}”. Your brand was named in ${readout.gap.named} / ${readout.gap.measured} answers and your website cited in ${readout.gap.cited} / ${readout.gap.measured}. This is a question to investigate, not proof of a content problem.`
   : 'Confirm the question sample reflects your buyers before using these results to prioritise content work.',
  next:setupError ? 'Repeat the measurement with corrected settings.' : notes.length
   ? `Review the ${notes.length} selected recommendation${notes.length===1?'':'s'} below, confirm the scope and assign an owner. Selection for this report does not mean implementation is approved or complete.`
   : 'No team recommendations have been selected for this report yet. Review the investigations below before commissioning changes.'
 };
}
