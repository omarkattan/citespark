import {collectionAsset} from './collection-display.js';
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
function cleanName(s) { return s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').replace(/[*#\[\]]/g,'').trim(); }
function plausibleBankName(value) {
 const s=cleanName(value);
 if(!bankLike(s)||s.split(/\s+/).length>8) return false;
 if(/^(?:banks?|البنك|بنك|مصرف|المصرف)$/i.test(s)) return false;
 if(/app|mobile|checklist|comparison|annually|primary|operating|other|many|best|banking|transfer|account|basic|central bank|jordanian banks?|choos|select|local banks?|your bank|any bank|each bank|تطبيق|بطاق|اسم |إذا |عبر |تقليدي|اختر|أفضل|حساب|اختيار|المناسب|البنوك|بنك مركزي|البنك المركزي|البنك الخاص|البنك الذي|بنكك/i.test(s)) return false;
 // Lower-case generic English wording is not an entity name.
 if(/[a-z]/i.test(s) && !/Bank|[A-Z][a-z]+bank/.test(s)) return false;
 return true;
}
const compact=s=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function competitorCandidates(rows, entities, ignored = []) {
  const found = new Map(), hidden = new Set(ignored);
  const names = new Set(entities.flatMap(e => [e.name, ...(e.aliases || [])]).map(s => cleanName(s).toLowerCase()));
  const domains = entities.map(e => domainKey(e.domain)).filter(Boolean);
  function add(name, domain, row, url) {
    name = cleanName(name).slice(0,120);
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
    return [...bold,...plain].map(cleanName).filter(plausibleBankName);
  }))];
  // Industry-neutral names are proposed only with an exact cited-domain stem match.
  // Formatting alone is not sufficient to classify a heading as a business.
  const namedCandidates=[...new Set([...bankNames,...rows.flatMap(row=>
    [...row.response_text.matchAll(/\*\*([^*\n]{3,100})\*\*/g)]
      .map(m=>cleanName(m[1].replace(/^\d+[.)]\s*/, '').split(/[:(]/)[0]))
      .filter(n=>n.length>=3 && n.split(/\s+/).length<=8 && (!bankLike(n) || plausibleBankName(n)))
  )])];
  const paired=new Map();
  for (const row of rows) for (const c of row.citations || []) {
    if(collectionAsset(c.url || c.domain)) continue;
    const domain=domainKey(c.domain||c.url),stem=domain.split('.')[0];
    const matches=namedCandidates.filter(n=>compact(n)===compact(stem));
    const name=matches[0]||domain;
    if(matches.length) paired.set(name,domain);
    add(name,domain,row,c.url);
  }
  for(const row of rows) for(const name of namedCandidates) {
    if(!bankNames.includes(name) && !paired.has(name)) continue;
    if(row.response_text.includes(name)) add(name,paired.get(name)||'',row);
  }
  // One review card per exact normalised name. Multiple cited domains remain visible for confirmation.
  const groups=new Map();
  const sorted=[...found.values()].sort((a,b)=>b.evidence.length-a.evidence.length||a.key.localeCompare(b.key));
  for(const c of sorted) {
    const key=c.name===c.domain ? c.key : `name:${compact(c.name)}`;
    if(!groups.has(key)) groups.set(key,{...c,domains:c.domain?[c.domain]:[],evidence:[...c.evidence]});
    else {
      const g=groups.get(key);
      if(c.domain&&!g.domains.includes(c.domain))g.domains.push(c.domain);
      for(const e of c.evidence)if(!g.evidence.some(x=>x.id===e.id))g.evidence.push(e);
      g.ignored ||= c.ignored;
    }
  }
  return [...groups.values()].map(c=>({...c,bulkEligible:!!c.domain&&c.name!==c.domain&&compact(c.name)===compact(c.domain.split('.')[0])}))
    .sort((a,b)=>Number(b.bulkEligible)-Number(a.bulkEligible)||b.evidence.length-a.evidence.length||a.name.localeCompare(b.name));
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
