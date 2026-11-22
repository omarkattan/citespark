import {coverageFor} from './measurement-coverage.js';
import {citationFacts} from './citation-evidence.js';
import {introductionOnly} from './answer-eligibility.js';
export async function measurementRows(db,projectId,id) {
 return (await db.query(`SELECT r.*,COALESCE((SELECT item->>'text' FROM measurement_batches b,
  jsonb_array_elements(b.collection_plan) item WHERE b.id=$1 AND (item->>'prompt_id')::int=r.prompt_id LIMIT 1),p.text) AS text,
  p.source,p.cluster,p.origin_details,
  (SELECT m.mentioned FROM mentions m JOIN entities e ON e.id=m.entity_id WHERE m.run_id=r.id AND e.kind='owned' ORDER BY e.id LIMIT 1) AS mentioned,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('url',c.url,'domain',c.domain,'original_url',c.original_url,'title',c.title,'resolution_status',c.resolution_status,'metadata',c.metadata)) FROM citations c WHERE c.run_id=r.id),'[]'::jsonb) AS citations
  FROM measurement_answers a JOIN runs r ON r.id=a.run_id JOIN prompts p ON p.id=r.prompt_id
  WHERE a.measurement_id=$1 AND r.project_id=$2 ORDER BY r.prompt_id,r.engine,r.run_index,r.id`,[id,projectId])).rows;
}
export function measurementStatus(batch,rows,domain) {
 const coverage=coverageFor(rows,batch),usable=rows.filter(r=>r.ok&&String(r.response_text||'').trim()&&!introductionOnly(r.response_text)).length;
 const failed=rows.filter(r=>!r.ok).length,noAnswer=rows.filter(r=>r.ok&&r.no_overview).length;
 const incomplete=rows.length-usable-failed-noAnswer;
 const citations=citationFacts(rows,domain);
 return {id:batch.id,status:batch.status,startedAt:batch.started_at,completedAt:batch.completed_at,planned:coverage.expected,
  retained:rows.length,usable,failed,missing:coverage.missing,noAnswer,incomplete,
  provisional:batch.status!=='completed'||failed>0||coverage.missing>0||incomplete>0,
  canRecover:!batch.legacy && ['partial','failed','interrupted'].includes(batch.status) &&
    Array.isArray(batch.collection_plan) && batch.collection_plan.length>0 && (failed>0 || coverage.missing>0 || incomplete>0),
  citationComplete:citations.complete,citations,failureDetail:batch.failure_detail||null,recoveryOf:batch.recovery_of||null};
}
export async function projectMeasurementState(db,project) {
 const batches=(await db.query(`SELECT * FROM measurement_batches WHERE project_id=$1 AND purpose='monitoring'
  AND (status='running' OR status='completed' OR jsonb_array_length(COALESCE(collection_plan,'[]'::jsonb))>0 OR EXISTS(SELECT 1 FROM measurement_answers a WHERE a.measurement_id=measurement_batches.id))
  ORDER BY started_at DESC,id DESC`,[project.id])).rows;
 const latest=batches[0],completed=batches.find(b=>b.status==='completed');
 if(!latest)return {latest:null,lastCompleted:null};
 const rows=await measurementRows(db,project.id,latest.id);
 return {latest:measurementStatus(latest,rows,project.domain),lastCompleted:completed?{id:completed.id,startedAt:completed.started_at,completedAt:completed.completed_at}:null};
}
