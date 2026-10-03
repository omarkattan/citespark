import {trafficReportHtml} from '../src/lib/traffic-html.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {QUALITY_METRICS,parseTrafficQuality,qualityForPeriod,trafficQualityHtml} from '../src/lib/traffic-quality.js';
const payload=(values=[10,6,.6,.2,125])=>({rowCount:1,metricHeaders:QUALITY_METRICS.map(name=>({name})),rows:[{metricValues:values.map(value=>({value:String(value)}))}]});
test('session rates use a single aggregate, with explicit zero and missing handling',()=>{
 const q=parseTrafficQuality(payload(),'2026-07-05','2026-10-02');
 const displayed=qualityForPeriod(q,q.from,q.to,10);assert.equal(displayed.engagementSecondsPerSession,12.5);assert.match(trafficQualityHtml(displayed),/20.0%/);assert.match(trafficQualityHtml(displayed),/not unique people or qualified leads/);
 const zero=parseTrafficQuality(payload([0,0,0,0,0]),q.from,q.to);assert.equal(qualityForPeriod(zero,q.from,q.to,0).sessionKeyEventRate,null);
 assert.equal(qualityForPeriod(q,'2026-07-06',q.to,10).state,'different_period');
 assert.equal(qualityForPeriod(q,q.from,q.to,11).sessionTotalsDiffer,true);assert.equal(qualityForPeriod(null,q.from,q.to,10).state,'unavailable');
});
test('limited, absent, invalid or inconsistent aggregate is withheld',()=>{
 for(const values of [[10,11,.6,.2,0],[10,6,.8,.2,0],[10,6,.6,1.1,0],[10,6,.6,.2,-1]])assert.throws(()=>parseTrafficQuality(payload(values),'a','b'));
 for(const metadata of [{subjectToThresholding:true},{dataLossFromOtherRow:true},{samplingMetadatas:[{}]}])assert.throws(()=>parseTrafficQuality({...payload(),metadata},'a','b'));
 assert.throws(()=>parseTrafficQuality({...payload(),rows:[],rowCount:0},'a','b'));
});

test('Arada aggregate remains usable with its own denominator when detailed rows differ',()=>{
 const q=parseTrafficQuality(payload([3082,1979,0.6421155094094744,0.06132381570408826,126991]),'2026-07-05','2026-10-02');
 const result=qualityForPeriod(q,q.from,q.to,3088);
 assert.equal(result.state,'ready');assert.equal(result.sessions,3082);assert.equal(result.detailSessions,3088);
 assert.equal(result.engagementSecondsPerSession,126991/3082);
 const report=trafficReportHtml({total:3088,conversions:211,revenue:0,currency:'AED',quality:result,sources:[],pages:[]});
 assert.match(report,/3,082 sessions/);assert.match(report,/sum to 3088/);
 const html=trafficQualityHtml(result);assert.match(html,/64.2%/);assert.match(html,/6.1%/);assert.match(html,/41.2 seconds/);assert.match(html,/reason for this difference has not been established/);
});
