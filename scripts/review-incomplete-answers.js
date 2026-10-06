import {many,pool} from '../src/db/index.js';
import {introductionOnly} from '../src/lib/answer-eligibility.js';
try {
 const rows=await many(`SELECT r.id,r.project_id,p.name,r.engine,r.model,r.created_at,r.response_text,
   EXISTS(SELECT 1 FROM mentions m WHERE m.run_id=r.id) AS scored
   FROM runs r JOIN projects p ON p.id=r.project_id
   WHERE r.ok AND r.created_at >= now()-interval '30 days'
     AND length(trim(r.response_text)) BETWEEN 1 AND 599
   ORDER BY r.id DESC LIMIT 10001`);
 const capped=rows.length>10000, checked=rows.slice(0,10000), groups=new Map();
 for(const r of checked.filter(r=>introductionOnly(r.response_text))){
  const key=`${r.project_id}:${r.engine}:${r.model}`;
  if(!groups.has(key))groups.set(key,{projectId:r.project_id,project:r.name,engine:r.engine,model:r.model,flagged:0,previouslyScored:0,runIds:[]});
  const g=groups.get(key);g.flagged++;g.previouslyScored+=Number(r.scored);g.runIds.push(r.id);
 }
 console.log(JSON.stringify({window:'Last 30 days',shortAnswersChecked:checked.length,capped,groups:[...groups.values()]},null,2));
 console.log('Read-only review. No AI calls, evidence changes or charges. This rule detects short list introductions, not every incomplete answer. Older reports and fixed snapshots are unchanged.');
} catch(error){console.error(error.message);process.exitCode=1;} finally {await pool.end();}
