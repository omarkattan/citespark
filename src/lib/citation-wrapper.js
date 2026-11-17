/** Exact wrapper hosts only. Never fetch arbitrary publisher or private URLs. */
const wrappers = new Map([
 ['vertexaisearch.cloud.google.com',null],['vertexaisearch.google.com',null],
 ['google.com',['/url','/goto']],['www.google.com',['/url','/goto']],['bing.com','/ck'],['www.bing.com','/ck'],
 ['r.search.yahoo.com',null],['duckduckgo.com','/l'],['l.facebook.com',null],['t.co',null],['lnkd.in',null]
]);
export function isWrapper(value) {
 try {const u=new URL(value),path=wrappers.get(u.hostname.toLowerCase());
  return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&wrappers.has(u.hostname.toLowerCase())&&
   (!path||(Array.isArray(path)?path:[path]).some(prefix=>u.pathname===prefix||u.pathname.startsWith(prefix+'/')));
 }catch{return false;}
}
export function publicDestination(value) {
 try {const u=new URL(value),host=u.hostname.toLowerCase();
  return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&(!u.port||['80','443'].includes(u.port))&&
   host.includes('.')&&!/[:\[\]]/.test(host)&&!/^\d+(?:\.\d+)*$/.test(host)&&!/(^|\.)(localhost|local|internal|test|invalid)$/.test(host);
 }catch{return false;}
}
