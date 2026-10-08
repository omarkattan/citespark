import test from 'node:test';
import assert from 'node:assert/strict';
import {analystContext} from '../src/lib/report-analyst-context.js';
import {analysisRequestPacket,packetHash} from '../src/lib/report-analyst.js';
import {qualitySignals} from '../src/lib/report-analyst-quality.js';
const packet={records:[{id:'scope',text:JSON.stringify({totals:{measured:165,failed:2,unmeasured:1,missingChecks:0,expectedChecks:168,noOverview:1},engineCoverage:[{engine:'ai_mode',failed:1},{engine:'ai_overview',failed:1}]})},{id:'traffic',text:JSON.stringify({state:'ready',quality:{state:'ready',sessions:3082,sessionKeyEventRate:.0613238}})}]};
test('coverage reconciles without counting no-overview twice, preserves unknowns and zeros',()=>{
 const c=analystContext(packet);assert.equal(c.coverage.accountedChecks,168);assert.equal(c.coverage.agreesWithExpected,true);assert.equal(c.coverage.noOverviewWithinUnmeasured,1);assert.equal(c.coverage.missingChecks,0);
 assert.equal(analystContext({records:[]}).coverage.accountedChecks,null);
 assert.equal(analystContext({records:[]}).analytics.rateDenominatorSessions,null);
});
test('request guidance preserves saved source identity and selected passages',()=>{
 const before=JSON.stringify(packet),hash=packetHash(packet),r=analysisRequestPacket(packet);
 assert.equal(r.interpretationContext.analytics.rateDenominatorSessions,3082);
 assert.match(r.interpretationContext.analytics.eventPageRule,/not the page where the event fired/);
 assert.equal(JSON.stringify(packet),before);assert.equal(packetHash(packet),hash);
});
test('observed benchmark mistakes produce focused review signals',()=>{
 const a={findings:[{observation:'7 WhatsApp clicks were recorded on the careers page. The share of sessions triggering a key event was 6.1%.'}],limitations:['2 failed and 1 unmeasured, plus 1 no-overview outcome for Google AI Overview.']};
 const ids=qualitySignals(a,packet).map(x=>x.rule);
 for(const rule of ['no-overview-double-count','omitted-failing-engine','landing-page-event-location','missing-session-denominator'])assert.ok(ids.includes(rule),rule);
});
test('accurate coverage and landing-session wording do not raise the new flags',()=>{
 const a={findings:[{observation:'Seven events were associated with sessions beginning on the careers landing page. Sessions triggering a key event: 6.1% of 3,082 sessions.'}],limitations:['Google AI Mode and Google AI Overview each had one failed request. One unmeasured result includes the no-overview outcome.']};
 assert.deepEqual(qualitySignals(a,packet),[]);
});
