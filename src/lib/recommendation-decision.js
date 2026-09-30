export const DECISION_LABELS = {investigate:'Needs investigation', ready:'Ready to implement', no_change:'No change needed'};
export function validateDecision(input) {
  if (!input || !DECISION_LABELS[input.stage]) throw new Error('Choose a review decision.');
  const result={stage:input.stage};
  for (const key of ['page','evidence','change']) {
    if (typeof input[key] !== 'string' || input[key].length > 4000) throw new Error('Use text of 4,000 characters or fewer for each field.');
    result[key]=input[key].trim();
  }
  if(input.title !== undefined) {
    if(typeof input.title !== 'string' || input.title.length>120) throw new Error('Use an action title of 120 characters or fewer.');
    result.title=input.title.trim().replace(/\s+/g,' ');
  }
  for (const key of ['purpose','suggested_owner','completion','follow_up']) {
    if(input[key] !== undefined) {
      if(typeof input[key] !== 'string' || input[key].length>1500) throw new Error('Use text of 1,500 characters or fewer for each delivery field.');
      result[key]=input[key].trim();
    }
  }
  if(result.page) {
    let url; try {url=new URL(result.page);} catch {throw new Error('Use a full http or https page URL.');}
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a full http or https page URL without credentials.');
  }
  if(result.stage==='ready' && (!result.page || !result.evidence || !result.change)) throw new Error('Ready to implement needs a page URL, supporting evidence and a specific change.');
  if(result.stage==='no_change' && (!result.evidence || !result.change)) throw new Error('Record the evidence reviewed and why no change is needed.');
  return result;
}
export const DELIVERY_LABELS={purpose:'Purpose',suggested_owner:'Suggested owner (not an assignment)',completion:'Completion checks',follow_up:'Follow-up measurement'};
export function decisionReportText(decision) {
  if(!decision?.stage) return '';
  return `Review decision: ${DECISION_LABELS[decision.stage] || 'Needs investigation'}\n${decision.page ? `Page: ${decision.page}\n` : ''}Evidence reviewed: ${decision.evidence || 'Not recorded'}\nChange or decision: ${decision.change || 'Not recorded'}\n${Object.entries(DELIVERY_LABELS).filter(([key])=>decision[key]).map(([key,label])=>`${label}: ${decision[key]}\n`).join('')}Reviewed: ${decision.reviewed_at || 'Not recorded'}\nThis is an editorial decision, not a measured outcome.\n\n`;
}
