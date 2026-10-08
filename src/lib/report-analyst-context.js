// Derived guidance only. Source records, passage numbers and saved approvals stay intact.
const record=(packet,id)=>{try{return JSON.parse(packet.records.find(r=>r.id===id)?.text||'null');}catch{return null;}};
const known=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
export function analystContext(packet){
 const scope=record(packet,'scope'),t=scope?.totals||{},traffic=record(packet,'traffic'),q=traffic?.quality;
 const fields=['measured','failed','unmeasured','missingChecks','expectedChecks'];
 const counts=Object.fromEntries(fields.map(k=>[k,known(t[k])?t[k]:null]));
 const sum=fields.slice(0,4).every(k=>known(t[k]))?t.measured+t.failed+t.unmeasured+t.missingChecks:null;
 return {
  coverage:{...counts,accountedChecks:sum,agreesWithExpected:sum!==null&&known(t.expectedChecks)?sum===t.expectedChecks:null,
   noOverviewWithinUnmeasured:known(t.noOverview)?t.noOverview:null,
   rule:'Measured, failed, unmeasured and missing checks are separate categories. No-overview outcomes are INCLUDED in unmeasured, never additional checks. Do not add no-overview to the total again. Unknown counts remain unknown.',
   enginesWithFailedRequests:(scope?.engineCoverage||[]).filter(e=>known(e.failed)&&e.failed>0).map(e=>({engine:e.engine,failed:e.failed})),
   disclosure:'When summarising coverage, include every engine with failed requests. No-overview is not an API failure.'},
  analytics:{state:traffic?.state??'unknown',
   sessionKeyEventRate:q?.state==='ready'&&known(q.sessionKeyEventRate)?q.sessionKeyEventRate:null,
   rateDenominatorSessions:q?.state==='ready'&&known(q.sessions)?q.sessions:null,
   rule:'Lead with the period aggregate when available. Every session key-event percentage must state its period and session denominator. Do not divide key-event counts by sessions to create this rate.',
   eventPageDimension:'landingPage',
   eventPageRule:'eventPages groups key events by the SESSION LANDING PAGE, not the page where the event fired. Say events associated with sessions beginning on that page. Never say clicks occurred on that page. Event location and sales/recruitment/broker purpose are unverified. This also applies to pages rows.'}
 };
}
