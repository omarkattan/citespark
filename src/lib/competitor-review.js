import { analyseRun } from './analyze.js';
export function domainKey(value) {
  if (!value) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || !u.hostname.includes('.')) return '';
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}
const bankLike = s => /bank|بنك|مصرف/i.test(s);
const compact=s=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function competitorCandidates(rows, entities, ignored = []) {
  const found = new Map(), hidden = new Set(ignored);
  const names = new Set(entities.flatMap(e => [e.name, ...(e.aliases || [])]).map(s => s.toLowerCase()));
  const domains = entities.map(e => domainKey(e.domain)).filter(Boolean);
  function add(name, domain, row, url) {
    name = name.replace(/[*#\[\]]/g, '').trim().slice(0,120);
    domain = domainKey(domain);
    if (!name || names.has(name.toLowerCase()) || (domain && domains.some(d => domain === d || domain.endsWith('.'+d)))) return;
    const key = domain ? `domain:${domain}` : `name:${name.toLowerCase()}`;
    if (!found.has(key)) found.set(key, {key,name,domain,bank:bankLike(name+' '+domain),evidence:[],ignored:hidden.has(key)});
    const c = found.get(key);
    if (!c.evidence.some(e=>e.id===row.id)) c.evidence.push({id:row.id,engine:row.engine,question:row.question,url:url || null});
  }
  const bankNames=[...new Set(rows.flatMap(row=>{
    const text=row.response_text;
    const bold=[...text.matchAll(/\*\*([^*\n]{3,100})\*\*/g)].map(m=>m[1].replace(/^\d+[.)]\s*/, '').split(/[:(]/)[0].trim());
    const plain=[...text.matchAll(/\b(?:Bank of [A-Z][a-z]+(?: [A-Z][a-z]+)?|[A-Z][a-z]+(?: [A-Z][a-z]+){0,2} Bank)\b/g)].map(m=>m[0]);
    return [...bold,...plain].filter(name=>bankLike(name)&&name.split(/\s+/).length<=8&&!/best|banking|transfer|account|أفضل|حساب/i.test(name));
  }))];
  const paired=new Map();
  for (const row of rows) for (const c of row.citations || []) {
    const domain=domainKey(c.domain||c.url),stem=domain.split('.')[0];
    const matches=bankNames.filter(n=>compact(n)===compact(stem));
    const name=matches[0]||domain;
    if(matches.length) paired.set(name,domain);
    add(name,domain,row,c.url);
  }
  for(const row of rows) for(const name of bankNames) {
    if(row.response_text.includes(name)) add(name,paired.get(name)||'',row);
  }
  return [...found.values()].sort((a,b)=>Number(b.bank)-Number(a.bank)||b.evidence.length-a.evidence.length||a.name.localeCompare(b.name));
}
export async function retrospective(rows, entity) {
  const results=[];
  for (const r of rows) {
    const [m]=await analyseRun({text:r.response_text,entities:[entity],useModel:false});
    if (!m) continue;
    const d=domainKey(entity.domain);
    results.push({runId:r.id,engine:r.engine,named:m.mentioned,cited:!!d&&(r.citations||[]).some(c=>{const x=domainKey(c.domain||c.url);return x===d||x.endsWith('.'+d);})});
  }
  return {version:1,reviewedAt:new Date().toISOString(),entity:{name:entity.name,domain:entity.domain,aliases:entity.aliases,ambiguous_name:entity.ambiguous_name},measured:results.length,named:results.filter(r=>r.named).length,cited:entity.domain ? results.filter(r=>r.cited).length : null,results};
}
export async function reviewSample(db, projectId) {
  const b=(await db.query(`SELECT id,cycle_date FROM published_measurements WHERE project_id=$1 ORDER BY cycle_date DESC LIMIT 1`,[projectId])).rows[0];
  if (!b) return {measurement:null,rows:[],limited:false};
  const rows=(await db.query(`SELECT r.id,r.engine,r.response_text,p.text AS question,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('domain',c.domain,'url',c.url)) FROM citations c WHERE c.run_id=r.id),'[]') AS citations
    FROM measurement_answers a JOIN runs r ON r.id=a.run_id JOIN prompts p ON p.id=r.prompt_id
    WHERE a.measurement_id=$1 AND r.project_id=$2 AND r.ok AND length(trim(r.response_text))>0
    AND EXISTS(SELECT 1 FROM mentions m JOIN entities e ON e.id=m.entity_id WHERE m.run_id=r.id AND e.project_id=$2 AND e.kind='owned')
    ORDER BY r.id LIMIT 251`,[b.id,projectId])).rows;
  return {measurement:b,rows:rows.slice(0,250),limited:rows.length>250};
}
