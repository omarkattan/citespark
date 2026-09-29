export const DECISION_LABELS = {investigate:'Needs investigation', ready:'Ready to implement', no_change:'No change needed'};
export function validateDecision(input) {
  if (!input || !DECISION_LABELS[input.stage]) throw new Error('Choose a review decision.');
  const result={stage:input.stage};
  for (const key of ['page','evidence','change']) {
    if (typeof input[key] !== 'string' || input[key].length > 4000) throw new Error('Use text of 4,000 characters or fewer for each field.');
    result[key]=input[key].trim();
  }
  if(result.page) {
    let url; try {url=new URL(result.page);} catch {throw new Error('Use a full http or https page URL.');}
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a full http or https page URL without credentials.');
  }
  if(result.stage==='ready' && (!result.page || !result.evidence || !result.change)) throw new Error('Ready to implement needs a page URL, supporting evidence and a specific change.');
  if(result.stage==='no_change' && (!result.evidence || !result.change)) throw new Error('Record the evidence reviewed and why no change is needed.');
  return result;
}
export function decisionReportText(decision) {
  if(!decision?.stage) return '';
  return `Review decision: ${DECISION_LABELS[decision.stage] || 'Needs investigation'}\n${decision.page ? `Page: ${decision.page}\n` : ''}Evidence reviewed: ${decision.evidence || 'Not recorded'}\nChange or decision: ${decision.change || 'Not recorded'}\nReviewed: ${decision.reviewed_at || 'Not recorded'}\nThis is an editorial decision, not a measured outcome.\n\n`;
}
