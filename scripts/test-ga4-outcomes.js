import test from 'node:test';
import assert from 'node:assert/strict';
import {trafficSummary,TRAFFIC_METHOD} from '../src/lib/traffic-summary.js';
import {trafficReportHtml} from '../src/lib/traffic-html.js';
import {aggregateTrafficRows,classifySource,validateTrafficResponse,syncGa4} from '../src/lib/ga4.js';
import {pool} from '../src/db/index.js';
const now=new Date('2026-10-01T03:00:00Z');
const project={ga4_property_id:'123',ga4_synced_at:'2026-10-01T02:00:00Z',ga4_sync_info:{version:2,propertyId:'123',from:'2026-01-01',to:'2026-09-30',currency:'JOD'}};
const row={date:'2026-09-30',platform:'ChatGPT',landing_page:'/accounts',classification_method:TRAFFIC_METHOD,sessions:10,conversions:15,revenue:0};
test('one verified series, exact dates and event counts without invented conversion rates',()=>{
 const result=trafficSummary(project,[row,{...row,classification_method:'native'},{...row,classification_method:'derived'}],{days:30,now});
 assert.equal(result.total,10);assert.equal(result.conversions,15);assert.equal(result.from,'2026-09-01');assert.equal(result.to,'2026-09-30');assert.equal(result.state,'ready');assert.equal(result.pages[0].sessions,10);
 assert.match(trafficReportHtml(result),/15 key events/);assert.doesNotMatch(trafficReportHtml(result),/150%|\$0/);assert.match(trafficReportHtml(result),/0 JOD/);
});
test('zero, missing coverage, disconnection and stale/partial windows remain distinct',()=>{
 assert.equal(trafficSummary(project,[],{now}).total,0);
 assert.equal(trafficSummary({...project,ga4_sync_info:null},[],{now}).total,null);
 assert.equal(trafficSummary({...project,ga4_property_id:null},[],{now}).state,'disconnected');
 assert.equal(trafficSummary({...project,ga4_property_id:'other'},[row],{now}).total,null);
 const partial=trafficSummary({...project,ga4_sync_info:{...project.ga4_sync_info,to:'2026-09-28'}},[row],{now});assert.equal(partial.state,'partial');assert.equal(partial.total,0);assert.match(trafficReportHtml(partial),/Partial coverage/);
});
test('host matching rejects false positives and aliases are summed before storage',()=>{
 assert.equal(classifySource('chatgpt.com.evil.example'),null);assert.equal(classifySource('openai.com'),null);assert.equal(classifySource('WWW.ChatGPT.com'),'ChatGPT');
 const rows=aggregateTrafficRows([{date:'20260930',sessionSource:'chatgpt.com',landingPage:'/a',sessions:3,keyEvents:2,totalRevenue:0},{date:'20260930',sessionSource:'chat.openai.com',landingPage:'/a',sessions:4,keyEvents:3,totalRevenue:0}]);assert.equal(rows.length,1);assert.equal(rows[0].sessions,7);assert.equal(rows[0].keyEvents,5);
});
test('truncation and flagged data loss fail instead of publishing incomplete totals',()=>{
 assert.throws(()=>validateTrafficResponse({rowCount:2,rows:[{}]}),/incomplete/);
 assert.throws(()=>validateTrafficResponse({metadata:{subjectToThresholding:true}}),/thresholding/);
 assert.throws(()=>validateTrafficResponse({metadata:{dataLossFromOtherRow:true}}),/aggregation loss/);
 assert.throws(()=>validateTrafficResponse({}),/missing expected fields/);
});
test('output escapes names, preserves unknown currency and does not imply configured leads',()=>{
 const t=trafficSummary(project,[{...row,platform:'<script>bad()</script>'}],{now});t.currency=null;
 const html=trafficReportHtml(t);assert.doesNotMatch(html,/<script>/);assert.match(html,/Monetary totals are withheld/);assert.match(html,/not unique leads/);
});
test('real sync SQL is atomic, repeatable, property scoped, and zero clears previously stored rows',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();
 await db.exec(`CREATE TABLE projects(id int primary key,ga4_property_id text,ga4_refresh_token text,ga4_synced_at timestamptz,ga4_sync_info jsonb);CREATE TABLE ga4_daily(project_id int,date date,platform text,classification_method text,landing_page text,sessions int,conversions numeric,revenue numeric);INSERT INTO projects VALUES(1,'123',null,null,null),(2,'456',null,null,null);INSERT INTO ga4_daily VALUES(2,'2026-09-30','ChatGPT','ai_referral_v2','/other',99,1,0);`);
 const origQuery=pool.query,origConnect=pool.connect,origFetch=global.fetch;const oldRefresh=process.env.GOOGLE_REFRESH_TOKEN;process.env.GOOGLE_REFRESH_TOKEN='test';
 let failInsert=false;pool.query=(...args)=>db.query(...args);pool.connect=async()=>({query:(...args)=>{if(failInsert&&args[0].startsWith('INSERT INTO ga4_daily'))throw new Error('Simulated insert failure');return db.query(...args);},release(){}});
 let records=[{dimensionValues:[{value:'20260930'},{value:'chatgpt.com'},{value:'/a'}],metricValues:[{value:'4'},{value:'2'},{value:'0'}]}],fail=false;
 global.fetch=async(url,opts)=>{if(String(url).includes('oauth2'))return {ok:true,json:async()=>({access_token:'test'})};const body=JSON.parse(opts.body);assert.ok(body.dimensionFilter.orGroup);assert.equal(body.metrics[1].name,'keyEvents');return {ok:true,json:async()=>({dimensionHeaders:['date','sessionSource','landingPage'].map(name=>({name})),metricHeaders:['sessions','keyEvents','totalRevenue'].map(name=>({name})),rows:records,rowCount:fail?2:records.length,metadata:{currencyCode:'JOD'}})};};
 try{
 await syncGa4(1);assert.equal((await db.query('SELECT sessions FROM ga4_daily WHERE project_id=1')).rows[0].sessions,4);
 await db.exec('UPDATE projects SET ga4_synced_at=null WHERE id=1');await syncGa4(1);assert.equal((await db.query('SELECT * FROM ga4_daily WHERE project_id=1')).rows.length,1);
 failInsert=true;await db.exec('UPDATE projects SET ga4_synced_at=null WHERE id=1');await assert.rejects(syncGa4(1),/Simulated insert failure/);assert.equal((await db.query('SELECT sessions FROM ga4_daily WHERE project_id=1')).rows[0].sessions,4);failInsert=false;
 fail=true;await assert.rejects(syncGa4(1),/incomplete/);assert.equal((await db.query('SELECT sessions FROM ga4_daily WHERE project_id=1')).rows[0].sessions,4);
 fail=false;records=[];await db.exec('UPDATE projects SET ga4_synced_at=null WHERE id=1');await syncGa4(1);assert.equal((await db.query('SELECT * FROM ga4_daily WHERE project_id=1')).rows.length,0);assert.equal((await db.query('SELECT sessions FROM ga4_daily WHERE project_id=2')).rows[0].sessions,99);
 }finally{pool.query=origQuery;pool.connect=origConnect;global.fetch=origFetch;if(oldRefresh===undefined)delete process.env.GOOGLE_REFRESH_TOKEN;else process.env.GOOGLE_REFRESH_TOKEN=oldRefresh;await db.close();}
});
