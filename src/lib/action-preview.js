// A free opportunity preview never includes implementation copy or evidence payloads.
export function previewActions(rows){
 return rows.filter(r=>r.evidence?.action_plan).sort((a,b)=>(a.evidence.action_plan.position||99)-(b.evidence.action_plan.position||99)).slice(0,3).map(r=>({id:r.id,title:r.title,previewOnly:true,evidence:{action_plan:{title:r.evidence.action_plan.title||r.title,position:r.evidence.action_plan.position,generation:r.evidence.action_plan.generation}}}));
}
