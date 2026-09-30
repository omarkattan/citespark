// A decision applies to the exact question version and evidence collected before review.
// Source-specific reviews cannot close a broader question investigation.
export function resolvedReportQuestions(review, measurement) {
 const start=Date.parse(measurement?.started_at);
 if(!Number.isFinite(start))return new Set();
 const groups=new Map();
 for(const d of review?.decisions || []) {
  if(!['content_gap','engine_gap'].includes(d.type) || !d.prompt_id)continue;
  const at=Date.parse(d.reviewed_at);
  if(!Number.isFinite(at) || at<start)continue;
  const id=String(d.prompt_id),group=groups.get(id)||[];group.push(d.stage);groups.set(id,group);
 }
 return new Set([...groups].filter(([,stages])=>stages.length && stages.every(s=>['ready','no_change'].includes(s))).map(([id])=>id));
}
export function reviewedReportPriorities(priorities,review,measurement) {
 const resolved=resolvedReportQuestions(review,measurement);
 return priorities.filter(p=>p.reviewKind!=='question_review' || !resolved.has(String(p.evidence?.questionId)));
}
