import {isWrapper} from './citation-wrapper.js';
import {introductionOnly} from './answer-eligibility.js';
/** URL destinations, never strings inside a path or query, establish ownership. */
export function citationHost(value) {
 try {const u=new URL(value);return /^https?:$/.test(u.protocol)?u.hostname.toLowerCase().replace(/^www\./,''):null;}catch{return null;}
}
export const opaqueCitation = isWrapper;
export function citationFacts(rows, ownedDomain) {
 const root=String(ownedDomain||'').toLowerCase().replace(/^www\./,'');
 const hosts=new Map(),engines=new Map(),owned=new Set();
 for(const r of rows) {
  if(!r.ok||!String(r.response_text||'').trim()||introductionOnly(r.response_text))continue;
  const e=engines.get(r.engine)||{engine:r.engine,answers:0,attributable:0,noCitationReturned:0,unavailable:0,unresolved:0,ownedAnswers:0};e.answers++;
  const links=r.citations||r.source_links||[];
  const unknown=links.some(c=>c.resolution_status==='unresolved'||opaqueCitation(c.url));
  const destinations=links.filter(c=>!opaqueCitation(c.url)&&c.resolution_status!=='unresolved').map(c=>citationHost(c.url)).filter(Boolean);
  if(destinations.length)e.attributable++;
  if(unknown)e.unresolved++;
  if(r.citation_evidence?.citationCollection!=='recorded')e.unavailable++;
  else if(!links.length)e.noCitationReturned++;
  const ownHosts=[...new Set(destinations.filter(h=>h===root||h.endsWith('.'+root)))];
  if(ownHosts.length){owned.add(r.id);e.ownedAnswers++;}
  for(const h of ownHosts){const set=hosts.get(h)||new Set();set.add(r.id);hosts.set(h,set);}
  engines.set(r.engine,e);
 }
 const perEngine=[...engines.values()].map(e=>({...e,complete:e.unavailable===0&&e.unresolved===0,citationRate:e.unavailable||e.unresolved?null:e.ownedAnswers/e.answers}));
 return {version:1,complete:perEngine.length>0&&perEngine.every(e=>e.complete),engines:perEngine,ownedAnswers:owned.size,
  ownedHosts:[...hosts].map(([host,answers])=>({host,answers:answers.size,scope:host===root?'main':host==='blog.'+root?'blog':'other owned host'})),
  note:'LLM API responses are separate from consumer sessions. Web search requested does not guarantee search was used or citations returned. Unresolved and unavailable source evidence cannot establish zero citations.'};
}
