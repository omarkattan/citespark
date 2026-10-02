import {decisionReportText} from './recommendation-decision.js';
/** Presentation only: do not infer implementation readiness from free-form notes. */
export function reportTitle(value, limit=120) {
 const text=String(value || '').trim().replace(/\s+/g,' ');
 if(text.length<=limit)return text;
 const cut=text.slice(0,limit-1);
 const boundary=cut.lastIndexOf(' ');
 return (boundary>limit/2 ? cut.slice(0,boundary) : cut)+'…';
}
export function reportWorkStatus(n) {
 const label={open:'To do',doing:'In progress',done:'Marked complete',dismissed:'Dismissed'}[n.status]||'Status not recorded';
 return `Current work status: ${label}. Assigned owner: ${n.assignee?.trim()||'Unassigned'}.${n.status==='done'?' Completion records work, not a verified visibility improvement.':''}`;
}
export function leadershipBrief(r,readout) {
 const trend=r.trend || {};
 const notes=r.review?.notes || [];
 const setupError=!!r.executive.localeWarnings?.length;
 // Editorial grouping, not buyer-intent classification or a comparable trend.
 const groups=['Search Console-derived','Site suggestions'].map(label=>(readout.origins||[]).find(x=>x.label===label));
 const contrast=groups.every(x=>x && x.questions>=3 && x.measured>=10 && Number.isFinite(x.named) && Number.isFinite(x.cited))
  && Math.abs(groups[0].named/groups[0].measured-groups[1].named/groups[1].measured)>=0.2;
 const pattern=contrast?`Visibility differs across the question sources: ${groups.map(x=>`${x.label} (${x.questions} questions): named ${x.named} / ${x.measured}, cited ${x.cited} / ${x.measured} measured answers`).join('. ')}. These are different question sets, not a trend or proof that the source caused the difference. Review answers and cited pages for ${groups.reduce((a,b)=>a.named/a.measured<b.named/b.measured?a:b).label.toLowerCase()} before proposing edits.`:null;
 const active=notes.filter(n=>['open','doing'].includes(n.status));
 const decisions=active.filter(n=>!n.outdated && n.decision_snapshot?.change?.trim() && decisionReportText(n.decision_snapshot).trim()===n.notes?.trim());
 const ready=decisions.find(n=>n.decision_snapshot.stage==='ready' && n.decision_snapshot.page?.trim() && n.decision_snapshot.evidence?.trim());
 const investigation=decisions.find(n=>n.decision_snapshot.stage==='investigate');
 const chosen=ready||investigation;
 const d=chosen?.decision_snapshot;
 const specificNext=chosen?`${chosen.status==='doing'?'Continue selected work':ready?'First selected ready action':'First selected investigation'}: ${reportTitle(d.title||chosen.title||d.change,100)}.${d.page?` Page: ${reportTitle(d.page,160)}.`:''} ${chosen.assignee?.trim()?`Assigned owner: ${reportTitle(chosen.assignee,100)}.`:d.suggested_owner?`Suggested owner: ${reportTitle(d.suggested_owner,100)}.`:'Assign an owner.'} ${chosen.status==='doing'?'Confirm progress and completion checks below with the owner.':ready?'Confirm scope and completion checks below before approving implementation.':'Review the evidence before approving any content change.'} This is a selected next step, not a predicted impact ranking.`:null;
 return {
  change: setupError ? 'Correct the collection settings before making performance claims.' : trend.comparable && trend.change!=null
   ? `Comparable visibility changed by ${trend.change>0?'+':''}${(trend.change*100).toFixed(1)} percentage points across ${trend.cycles} selected cycles. This uses common question-and-engine pairs, not necessarily the headline sample.`
   : 'Use this as a baseline. No comparable movement is established for the selected period.',
  matters:setupError ? 'This measurement is diagnostic, not a validated baseline for the intended market.' : pattern || (readout.gap
   ? `Review “${readout.gap.text}”. Your brand was named in ${readout.gap.named} / ${readout.gap.measured} answers and your website cited in ${readout.gap.cited} / ${readout.gap.measured}. This is a question to investigate, not proof of a content problem.`
   : 'Confirm the question sample reflects your buyers before using these results to prioritise content work.'),
  next:notes.some(n=>n.outdated) && !setupError ? 'A selected report copy differs from its saved action. Review and update that copy in Opportunities before sharing this report.' : setupError ? 'Repeat the measurement with corrected settings.' : specificNext || (notes.length && !active.length ? notes.every(n=>['done','dismissed'].includes(n.status)) ? 'No selected work remains open. Review completion evidence for finished tasks and plan a comparable follow-up measurement. Dismissed tasks remain recorded for context. Task completion alone does not establish a visibility improvement.' : 'Confirm the current status of the selected tasks in Opportunities before choosing the next action.' : notes.length
   ? `Review the ${notes.length} selected recommendation${notes.length===1?'':'s'} below, confirm the scope and assign an owner. Selection for this report does not mean implementation is approved or complete.`
   : 'No team recommendations have been selected for this report yet. Review the investigations below before commissioning changes.')
 };
}
