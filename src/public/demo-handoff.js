/* Browser-local setup hints only. Never import these values as measurements. */
(function(){
 const key='cited.demo.handoff.v1',ttl=24*60*60*1000;
 function read(){try{const d=JSON.parse(localStorage.getItem(key));if(!d||!Number.isFinite(d.savedAt)||Date.now()-d.savedAt>ttl||d.savedAt>Date.now()+60000||typeof d.site?.domain!=='string')return null;return d;}catch{return null;}}
 function save(site,results){try{const old=read();const merged=new Map();if(old?.site?.domain===site.domain)for(const r of old.results||[])merged.set(r.question,r);for(const r of results)merged.set(r.question,r);results=merged.values();localStorage.setItem(key,JSON.stringify({savedAt:Date.now(),site:{domain:site.domain,brandName:site.brandName,category:site.category,qualifier:site.qualifier,market:site.market},results:[...results].slice(-10).map(r=>({question:r.question,status:r.status,engine:r.engine,runs:r.runs,mentions:r.mentions,collectedAt:r.collectedAt,excerpt:r.excerpt}))}));return true;}catch{return false;}}
 function clear(){try{localStorage.removeItem(key);}catch{}}
 window.CitedDemoHandoff={read,save,clear};
})();
