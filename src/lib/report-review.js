import { reportNotePreview } from './report-note.js';
/** Match comparisons to the report's exact measurement. Retrospective rows never enter trend tables. */
export async function reportReview(projectId, measurement, many) {
 const saved=await many(`SELECT n.decision_snapshot,n.title,n.notes,n.selected_at,n.recommendation_id,r.id,r.project_id,r.title AS current_title,r.notes AS current_notes,r.review_decision FROM report_review_notes n
 JOIN recommendations r ON r.id=n.recommendation_id WHERE n.project_id=$1 AND r.project_id=$1 ORDER BY n.selected_at DESC,n.recommendation_id`,[projectId]);
 const notes=saved.map(n=>({decision_snapshot:n.decision_snapshot,title:n.title,notes:n.notes,selected_at:n.selected_at,recommendation_id:n.recommendation_id,
   outdated:reportNotePreview({id:n.id,project_id:n.project_id,title:n.current_title,notes:n.current_notes,review_decision:n.review_decision},n).changed}));
 const decisions=await many(`SELECT type,evidence->>'prompt_id' AS prompt_id,review_decision->>'stage' AS stage,review_decision->>'reviewed_at' AS reviewed_at
 FROM recommendations WHERE project_id=$1 AND review_decision->>'stage' IN ('ready','no_change','investigate')`,[projectId]);
 if(!measurement) return {notes,decisions,comparisons:[]};
 const measured=await many(`SELECT e.id,e.name,e.domain,e.kind,
 COUNT(m.run_id)::int AS measured,COUNT(m.run_id) FILTER(WHERE m.mentioned)::int AS named,
 CASE WHEN e.domain IS NULL OR e.domain='' THEN NULL ELSE COUNT(m.run_id) FILTER(WHERE EXISTS(SELECT 1 FROM citations c WHERE c.run_id=m.run_id AND (lower(regexp_replace(c.domain,'^www[.]',''))=lower(regexp_replace(e.domain,'^www[.]','')) OR lower(c.domain) LIKE '%.'||lower(regexp_replace(e.domain,'^www[.]','')))))::int END AS cited
 FROM entities e LEFT JOIN mentions m ON m.entity_id=e.id AND m.run_id IN(
 SELECT r.id FROM measurement_answers a JOIN runs r ON r.id=a.run_id WHERE a.measurement_id=$2 AND r.project_id=$1 AND r.ok AND length(trim(r.response_text))>0)
 WHERE e.project_id=$1 GROUP BY e.id ORDER BY e.kind,e.name`,[projectId,measurement.id]);
 const baselines=await many(`SELECT b.entity_id,b.analysis FROM competitor_baselines b JOIN entities e ON e.id=b.entity_id WHERE e.project_id=$1 AND b.measurement_id=$2`,[projectId,measurement.id]);
 const comparisons=measured.map(row=>{
  if(row.measured>0) return {...row,method:'Measured in this cycle'};
  const b=baselines.find(b=>String(b.entity_id)===String(row.id))?.analysis;
  if(b?.measured>0) return {...row,name:b.entity.name,domain:b.entity.domain,measured:b.measured,named:b.named,cited:b.cited,method:'Retrospective analysis',reviewedAt:b.reviewedAt,limited:!!b.limited};
  return {...row,measured:0,named:null,cited:null,method:'Not measured in this cycle'};
 });
 return {notes,decisions,comparisons};
}
