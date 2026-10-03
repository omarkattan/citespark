import test from 'node:test';
import assert from 'node:assert/strict';
import {QUALITY_METRICS,parseTrafficQuality,qualityForPeriod,trafficQualityHtml} from '../src/lib/traffic-quality.js';
const payload=(values=[10,6,.6,.2,125])=>({rowCount:1,metricHeaders:QUALITY_METRICS.map(name=>({name})),rows:[{metricValues:values.map(value=>({value:String(value)}))}]});
test('session rates use a single aggregate, with explicit zero and missing handling',()=>{
 const q=parseTrafficQuality(payload(),'2026-07-05','2026-10-02');
 const displayed=qualityForPeriod(q,q.from,q.to,10);assert.equal(displayed.engagementSecondsPerSession,12.5);assert.match(trafficQualityHtml(displayed),/20.0%/);assert.match(trafficQualityHtml(displayed),/not unique people or qualified leads/);
 const zero=parseTrafficQuality(payload([0,0,0,0,0]),q.from,q.to);assert.equal(qualityForPeriod(zero,q.from,q.to,0).sessionKeyEventRate,null);
 assert.equal(qualityForPeriod(q,'2026-07-06',q.to,10).state,'different_period');
 assert.equal(qualityForPeriod(q,q.from,q.to,11).state,'mismatch');assert.equal(qualityForPeriod(null,q.from,q.to,10).state,'unavailable');
});
test('limited, absent, invalid or inconsistent aggregate is withheld',()=>{
 for(const values of [[10,11,.6,.2,0],[10,6,.8,.2,0],[10,6,.6,1.1,0],[10,6,.6,.2,-1]])assert.throws(()=>parseTrafficQuality(payload(values),'a','b'));
 for(const metadata of [{subjectToThresholding:true},{dataLossFromOtherRow:true},{samplingMetadatas:[{}]}])assert.throws(()=>parseTrafficQuality({...payload(),metadata},'a','b'));
 assert.throws(()=>parseTrafficQuality({...payload(),rows:[],rowCount:0},'a','b'));
});
