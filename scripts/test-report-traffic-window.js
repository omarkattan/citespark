import test from 'node:test';
import assert from 'node:assert/strict';
import {trafficSummary,TRAFFIC_METHOD} from '../src/lib/traffic-summary.js';
import {analystPacket,packetHash} from '../src/lib/report-analyst.js';
import {preparationTrafficHtml} from '../src/lib/report-preparation.js';
const project={ga4_property_id:'123',ga4_synced_at:'2026-10-03T07:41:42Z',ga4_sync_info:{version:2,propertyId:'123',from:'2025-04-11',to:'2026-10-02',quality:{state:'ready',from:'2026-07-05',to:'2026-10-02',sessions:10,engagedSessions:6,engagementRate:.6,sessionKeyEventRate:.2,userEngagementDuration:100}}};
const rows=[{date:'2026-07-05',platform:'ChatGPT',landing_page:'/a',classification_method:TRAFFIC_METHOD,sessions:4,conversions:1,revenue:0},{date:'2026-10-02',platform:'ChatGPT',landing_page:'/b',classification_method:TRAFFIC_METHOD,sessions:6,conversions:1,revenue:0}];
const summary=(p=project,date='2026-10-04',data=rows)=>trafficSummary(p,data,{window:'saved',now:new Date(date)});
const report=(traffic,id=31)=>({project:{id,name:'Test project',domain:'example.com'},period:{from:'2026-10-01',to:'2026-10-01'},executive:{totals:{measured:1,named:0,cited:0},questions:[]},traffic,review:{notes:[],comparisons:[]}});
const hash=(traffic,id)=>packetHash(analystPacket(report(traffic,id)));
test('saved Analytics survives calendar rollover with identical evidence and full aggregate',()=>{
 const original=trafficSummary(project,rows,{now:new Date('2026-10-03')});
 const next=summary();assert.deepEqual(next,original);assert.equal(next.quality.state,'ready');assert.equal(next.from,'2026-07-05');assert.equal(next.to,'2026-10-02');
 for(const id of [27,28,31,999])assert.equal(hash(next,id),hash(original,id));
 assert.deepEqual(summary(project,'2026-11-10'),original);
 const html=preparationTrafficHtml({id:31},{...next,connected:true});assert.match(html,/last verified Analytics collection date/);assert.match(html,/does not include activity after that date/);assert.match(html,/2026-10-02/);
});
test('new synced dates or changed stored values invalidate analysis',()=>{
 const changed=structuredClone(project);changed.ga4_sync_info.to='2026-10-03';changed.ga4_synced_at='2026-10-04T01:00:00Z';
 assert.notEqual(hash(summary(changed)),hash(summary()));
 assert.equal(summary(changed).quality.state,'different_period');
 assert.notEqual(hash(summary(project,'2026-10-04',[{...rows[0],sessions:99},rows[1]])),hash(summary()));
});
test('operational rolling window still flags partial coverage and excludes expired rows',()=>{
 const rolling=trafficSummary(project,rows,{now:new Date('2026-10-04')});assert.equal(rolling.state,'partial');assert.equal(rolling.total,6);assert.equal(rolling.quality.state,'different_period');
});
test('missing, changed-property, malformed and future saved windows cannot publish zero or stale totals',()=>{
 for(const change of [null,{...project.ga4_sync_info,propertyId:'wrong'},{...project.ga4_sync_info,to:'invalid'},{...project.ga4_sync_info,to:'2026-10-05'},{...project.ga4_sync_info,from:'2026-02-30'},{...project.ga4_sync_info,from:'2026-10-03'}]){
  const result=summary({...project,ga4_sync_info:change});assert.equal(result.state,'needs_sync');assert.equal(result.total,null);
 }
 assert.equal(summary({...project,ga4_property_id:null}).state,'disconnected');
});
test('verified zero stays zero, partial collection stays partial, unavailable quality stays unknown',()=>{
 const p=structuredClone(project);p.ga4_sync_info.quality={state:'unavailable'};
 assert.equal(summary(p,'2026-10-04',[]).total,0);assert.equal(summary(p).quality.state,'unavailable');
 p.ga4_sync_info.from='2026-09-01';const partial=summary(p);assert.equal(partial.state,'partial');assert.equal(partial.total,6);assert.equal(partial.coveredFrom,'2026-09-01');
});
