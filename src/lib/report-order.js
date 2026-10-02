import {decisionReportText} from './recommendation-decision.js';
// Order by confirmed report content, never unconfirmed edits to the current task.
export function reportDecisionOrder(a,b){
 const rank=n=>{
  if(['done','dismissed'].includes(n.status))return 4;
  const d=n.decision_snapshot,text=n.saved_notes??n.notes;
  if(!d?.stage||decisionReportText(d).trim()!==String(text||'').trim())return 3;
  return {ready:0,investigate:1,no_change:2}[d.stage]??3;
 };
 const stamp=n=>Number.isFinite(Date.parse(n.selected_at))?Date.parse(n.selected_at):0;
 return rank(a)-rank(b)||stamp(b)-stamp(a)||Number(a.recommendation_id??a.id)-Number(b.recommendation_id??b.id);
}
