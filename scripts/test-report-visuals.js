import test from 'node:test';
import assert from 'node:assert/strict';
import {reportVisualGroups,reportVisualOverview,comparisonVisual,reportRate} from '../src/lib/report-visuals.js';
import {summariseEvidence,reportEvidence} from '../src/lib/report-evidence.js';
test('topic and language charts keep measured denominators and preserve unmeasured questions',()=>{
 const e=summariseEvidence([
  {prompt_id:1,text:'Who repairs tyres?',cluster:'Tyres',origin_details:{language:'en'},engine:'chatgpt',ok:true,response_text:'Complete answer.',mentioned:true,cited:false},
  {prompt_id:1,text:'Who repairs tyres?',cluster:'Tyres',engine:'claude',ok:false},
  {prompt_id:2,text:'ما أفضل الورش؟',cluster:'Tyres',engine:'gemini',ok:true,response_text:'',mentioned:null},
  {prompt_id:3,text:'What is included?',cluster:'Service',engine:'chatgpt',ok:true,response_text:'Complete.',mentioned:false,cited:true}
 ]);
 const g=reportVisualGroups(e.questions);
 assert.deepEqual(g.topics[0],{label:'Tyres',questions:2,measured:1,named:1,cited:0});
 assert.equal(g.languages.find(x=>x.label==='Arabic').measured,0);
 const html=reportVisualOverview(e);assert.match(html,/100% · 1 \/ 1/);assert.match(html,/0% · 0 \/ 1/);assert.match(html,/Not measured/);assert.doesNotMatch(html,/NaN|Infinity/);
});
test('engine chart uses saved measured verdicts rather than attempts',async()=>{
 let calls=0;
 const e=await reportEvidence(1,{},async()=>++calls===1?[
  {prompt_id:1,text:'Which garage?',cluster:'Garages',engine:'chatgpt',ok:true,response_text:'Complete.',mentioned:true,cited:true},
  {prompt_id:2,text:'What service?',engine:'chatgpt',ok:false},
  {prompt_id:3,text:'What price?',engine:'chatgpt',ok:true,response_text:'',mentioned:null}
 ]:[]);
 assert.deepEqual(e.engineCoverage,[{engine:'chatgpt',measured:1,named:1,cited:1,failed:1,unmeasured:1}]);
 const html=reportVisualOverview(e);assert.match(html,/1 measured · 2 failed \/ unmeasured/);assert.match(html,/Naming and website citations overlap/);
});
test('old snapshots do not invent unavailable engine rates and text stays escaped',()=>{
 const html=reportVisualOverview({totals:{measured:3},questions:[],engineCoverage:[{engine:'<svg onload=alert(1)>',measured:3}]});
 assert.match(html,/Not measured/);assert.doesNotMatch(html,/<svg onload/);
 assert.doesNotMatch(comparisonVisual([{name:'<script>x</script>',domain:'<bad>',measured:10,named:5,cited:2}]),/<script>|<bad>/);
});

test('rare presence stays distinct from zero and planned missing checks remain visible',async()=>{
 assert.equal(reportRate(1,1200),'&lt;0.1%');assert.equal(reportRate(2,1200),'0.2%');assert.equal(reportRate(0,1200),'0%');
 let calls=0;const e=await reportEvidence(1,{},async()=>++calls===1?[{prompt_id:1,text:'Which garage?',engine:'chatgpt',ok:true,response_text:'Answer.',mentioned:true,cited:true}]:[{collection_plan:[{prompt_id:1,text:'Which garage?',engine:'chatgpt'},{prompt_id:2,text:'What service?',engine:'chatgpt'}],settings:{engines:['chatgpt']}}]);
 assert.equal(e.engineCoverage[0].expectedChecks,2);assert.equal(e.engineCoverage[0].missingChecks,1);
 assert.match(reportVisualOverview(e),/1 missing/);
});
