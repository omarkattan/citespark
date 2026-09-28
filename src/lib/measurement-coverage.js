/** Missing results are separate from attempted failures and successful empty responses. */
export function coverageFor(rows, measurement) {
 if (!measurement || measurement.legacy) return { missing:null, expected:null, basis:'unknown', questions:[] };
 const plan = Array.isArray(measurement.collection_plan) ? measurement.collection_plan : null;
 const questions = new Map(rows.map(r=>[r.prompt_id,{id:r.prompt_id,text:r.text,source:r.source}]));
 const expected = new Map();
 const add=(id,engine,n)=>expected.set(`${id}:${engine}`,{id,engine,n});
 if (plan) {
   for(const p of plan) {questions.set(p.prompt_id,{id:p.prompt_id,text:p.text,source:p.source});
     const key=`${p.prompt_id}:${p.engine}`;add(p.prompt_id,p.engine,(expected.get(key)?.n || 0)+1);}
 } else {
   const engines=measurement.settings?.engines, runs=measurement.settings?.runs;
   if(!Array.isArray(engines)||!Number.isInteger(runs)||runs<1) return {missing:null,expected:null,basis:'unknown',questions:[]};
   for(const id of questions.keys()) for(const engine of new Set(engines)) add(id,engine,runs);
 }
 const observed=new Map();
 for(const r of rows) {const key=`${r.prompt_id}:${r.engine}`;observed.set(key,(observed.get(key)||0)+1);}
 let missing=0,total=0;
 for(const {id,engine,n} of expected.values()) {
   const gap=Math.max(0,n-(observed.get(`${id}:${engine}`)||0));total+=n;missing+=gap;
   const q=questions.get(id);q.missing=(q.missing||0)+gap;
 }
 return {missing,expected:total,basis:plan?'recorded-plan':'recorded-questions-and-settings',questions:[...questions.values()]};
}
export function requestCounts(planned, attemptsByEngine) {
 const attempted=[...attemptsByEngine.values()].reduce((n,v)=>n+v,0);
 return {planned,attempted,skipped:Math.max(0,planned-attempted)};
}
