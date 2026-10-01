// Counts provide session entry-page context, not event triggers or deduplicated leads.
export function summariseEventContext(context,{from,to,eventState,events,pages}) {
 const unavailable={eventContextState:'needs_sync',eventPages:[]};
 if(context?.state!=='ready')return unavailable;
 if(eventState!=='ready')return {...unavailable,eventContextState:'mismatch'};
 const groups=new Map(),byName=new Map(),byPage=new Map();
 for(const row of context.rows||[]){
  if(row.date<from||row.date>to)continue;
  const count=Number(row.count),page=row.page||'(not set)',key=JSON.stringify([row.name,page]);
  if(!Number.isFinite(count)||count<0)return {...unavailable,eventContextState:'mismatch'};
  const value=groups.get(key)||{name:row.name,page,count:0};value.count+=count;groups.set(key,value);
  byName.set(row.name,(byName.get(row.name)||0)+count);byPage.set(page,(byPage.get(page)||0)+count);
 }
 const matches=(map,expected,key,value)=>{
  const wanted=new Map(expected.map(r=>[r[key],Number(r[value])]));
  return [...new Set([...map.keys(),...wanted.keys()])].every(k=>Math.abs((map.get(k)||0)-(wanted.get(k)||0))<0.000001);
 };
 if(!matches(byName,events,'name','count')||!matches(byPage,pages,'page','conversions'))return {...unavailable,eventContextState:'mismatch'};
 return {eventContextState:'ready',eventPages:[...groups.values()].sort((a,b)=>b.count-a.count)};
}
export function isCareersPath(page) {
 // An explicit path signal for review, never an inferred classification or exclusion.
 return /(?:^|\/)(?:careers?|jobs?)(?:\/|$|[?#])/i.test(String(page));
}
