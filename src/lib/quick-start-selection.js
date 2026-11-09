// Retain historical entities while honoring the user's selection in future scans.
export function selectedEntities(project,entities){
 const selected=project.quick_start_options?.competitors;
 if(!Array.isArray(selected))return entities;
 const names=new Set(selected.map(c=>c.name.toLowerCase()));
 return entities.filter(e=>e.kind==='owned'||names.has(e.name.toLowerCase()));
}
