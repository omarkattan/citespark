export const TRAFFIC_METHOD='ai_referral_v2';
export function trafficSummary(project,rows,{days=90,now=new Date()}={}){
 const n=Math.max(1,Math.min(365,Math.floor(Number(days)||90)));
 const end=new Date(now);end.setUTCDate(end.getUTCDate()-1);
 const start=new Date(end);start.setUTCDate(start.getUTCDate()-(n-1));
 const from=start.toISOString().slice(0,10),to=end.toISOString().slice(0,10),info=project.ga4_sync_info;
 const empty={days:n,from,to,total:null,conversions:null,revenue:null,sources:[],pages:[],trend:[],syncedAt:project.ga4_synced_at||null,currency:null,method:TRAFFIC_METHOD};
 if(!project.ga4_property_id)return {...empty,state:'disconnected',why:'Choose an Analytics property for this project. Search Console is a separate connection.'};
 if(!info||info.version!==2||String(info.propertyId)!==String(project.ga4_property_id))return {...empty,state:'needs_sync',why:'Sync Analytics to verify this property, remove overlapping classifications and record coverage. Older traffic totals are not shown.'};
 const coveredFrom=info.from>from?info.from:from,coveredTo=info.to<to?info.to:to;
 if(coveredFrom>coveredTo)return {...empty,state:'needs_sync',why:'No verified sync covers this reporting period. Sync Analytics.'};
 const picked=rows.filter(r=>r.classification_method===TRAFFIC_METHOD&&String(r.date instanceof Date?r.date.toISOString().slice(0,10):r.date)>=coveredFrom&&String(r.date instanceof Date?r.date.toISOString().slice(0,10):r.date)<=coveredTo);
 const sources=new Map(),pages=new Map();let total=0,conversions=0,revenue=0;
 for(const r of picked){const sessions=Number(r.sessions),events=Number(r.conversions),money=Number(r.revenue);total+=sessions;conversions+=events;revenue+=money;
  for(const [map,key] of [[sources,r.platform],[pages,r.landing_page||'(not set)']]){const v=map.get(key)||{source:key,page:key,landing_page:key,sessions:0,conversions:0,revenue:0};v.sessions+=sessions;v.conversions+=events;v.revenue+=money;map.set(key,v);}
 }
 return {...empty,state:coveredFrom===from&&coveredTo===to?'ready':'partial',why:null,coveredFrom,coveredTo,total,conversions,revenue,currency:info.currency||null,sources:[...sources.values()].sort((a,b)=>b.sessions-a.sessions),pages:[...pages.values()].sort((a,b)=>b.sessions-a.sessions),trend:picked};
}
