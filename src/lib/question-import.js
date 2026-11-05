import {queryKey} from './gsc-query-integrity.js';

const invalid=message=>Object.assign(new Error(message),{status:400});
export function questionItems(input) {
  const values=typeof input==='string' ? input.split(/\r?\n/u).filter(x=>x.trim()) : input;
  if(!Array.isArray(values)||!values.length||values.length>500)throw invalid('Provide between 1 and 500 questions, one per line or as JSON objects.');
  return values.map(value=>{
    const p=typeof value==='string'?{text:value}:value;
    if(!p||typeof p!=='object'||Array.isArray(p))throw invalid('Each item must contain question text.');
    const text=String(p.text||'').trim();
    return {text,cluster:String(p.cluster||'custom').trim().toLowerCase().slice(0,80),
      intent:['discovery','comparison','commercial','problem'].includes(p.intent)?p.intent:'commercial',
      language:['en','ar'].includes(p.language)?p.language:(/[\u0620-\u064A]/u.test(text)?'ar':'en'),city:String(p.city||'').trim().slice(0,100)};
  });
}
export function reviewQuestionItems(input,existing=[]) {
  const seen=new Set(existing.map(p=>queryKey(p.text)));
  return questionItems(input).map(p=>{
    const error=p.text.length<10||p.text.length>500||/[\r\n]/u.test(p.text)?'Use 10–500 characters on one line.':null;
    const duplicate=seen.has(queryKey(p.text));seen.add(queryKey(p.text));
    return {...p,error,duplicate};
  });
}
export async function importQuestionItems({projectId,orgId,items,limit,source='custom'},pool) {
  source=['topic','generated'].includes(source)?source:'custom';
  const parsed=questionItems(items);
  if(parsed.some(p=>p.text.length<10||p.text.length>500||/[\r\n]/u.test(p.text)))throw invalid('Review invalid question wording before adding.');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const project=(await client.query('SELECT id FROM projects WHERE id=$1 AND org_id=$2 FOR UPDATE',[projectId,orgId])).rows[0];
    if(!project)throw Object.assign(new Error('Site not found.'),{status:404});
    const existing=(await client.query('SELECT text,active FROM prompts WHERE project_id=$1',[projectId])).rows;
    const candidates=reviewQuestionItems(parsed,existing).filter(p=>!p.duplicate);
    const room=Math.max(0,limit-existing.filter(p=>p.active).length);
    if(candidates.length>room)throw Object.assign(new Error(`There is room for ${room} more active questions. Select fewer or pause existing questions.`),{status:402});
    let added=0;
    for(const p of candidates){
      const row=(await client.query(`INSERT INTO prompts(project_id,text,cluster,intent,ai_search_volume,source,origin_details)
       VALUES($1,$2,$3,$4,NULL,$5,$6) ON CONFLICT(project_id,text) DO NOTHING RETURNING id`,
      [projectId,p.text,p.cluster,p.intent,source,JSON.stringify({entry:'reviewed_import',language:p.language,city:p.city||null})])).rows[0];
      if(row){added++;await client.query(`INSERT INTO prompt_events(project_id,prompt_id,event,text,source) VALUES($1,$2,'added',$3,$4)`,[projectId,row.id,p.text,source]);}
    }
    await client.query('COMMIT');return {added,duplicates:parsed.length-candidates.length};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function setSelectedQuestionStatus({projectId,orgId,ids,active,limit},pool) {
  if(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(id=>!Number.isSafeInteger(id)||id<1)||typeof active!=='boolean')throw invalid('Select valid questions and a status.');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const project=(await client.query('SELECT id FROM projects WHERE id=$1 AND org_id=$2 FOR UPDATE',[projectId,orgId])).rows[0];
    if(!project)throw Object.assign(new Error('Site not found.'),{status:404});
    const selected=(await client.query(`SELECT q.id,q.active,EXISTS(SELECT 1 FROM prompts n WHERE n.revises_prompt_id=q.id) AS superseded
      FROM prompts q WHERE q.project_id=$1 AND q.id=ANY($2::int[])`,[projectId,ids])).rows;
    if(active&&selected.some(p=>p.superseded))throw invalid('Some questions have newer revisions. Select their latest versions.');
    const current=(await client.query('SELECT COUNT(*)::int AS n FROM prompts WHERE project_id=$1 AND active',[projectId])).rows[0].n;
    if(active&&current+selected.filter(p=>!p.active).length>limit)throw Object.assign(new Error('Resuming these questions would exceed your active-question allowance.'),{status:402});
    const result=await client.query('UPDATE prompts SET active=$3 WHERE project_id=$1 AND id=ANY($2::int[]) AND active IS DISTINCT FROM $3',[projectId,ids,active]);
    await client.query('COMMIT');return {changed:result.rowCount};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
