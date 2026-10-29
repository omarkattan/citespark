import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {summariseEvidence} from '../src/lib/report-evidence.js';
import {executiveReportHtml} from '../src/lib/report-executive-html.js';

const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const context=vm.createContext({esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))});
vm.runInContext(app.slice(app.indexOf('function questionSearchEvidence('),app.indexOf('async function viewQuestions()')),context);
const evidence=context.questionSearchEvidence;
const snapshot={property:'https://www.arada.com/',startDate:'2026-07-28',endDate:'2026-10-26',impressions:0,clicks:0,matchedQueries:1,storedQueries:1,scope:'exact stored queries'};

test('dated search evidence preserves measured zero and never substitutes older imports',()=>{
 const html=evidence({impressions:9999,gscSnapshot:snapshot});
 assert.match(html,/0 impressions · 0 clicks/);assert.doesNotMatch(html,/9,999/);
 assert.match(html,/2026-07-28 to 2026-10-26/);assert.match(html,/not the number of people asking this AI question/);
});
test('unknown search counts and missing dates cannot masquerade as measured zero',()=>{
 assert.match(evidence({gscSnapshot:{...snapshot,impressions:null,clicks:null}}),/Not matched impressions · Not matched clicks/);
 assert.match(evidence({impressions:300}),/No dated search snapshot/);
 assert.doesNotMatch(evidence({impressions:300}),/300/);
});
test('search evidence escapes external metadata',()=>{
 assert.doesNotMatch(evidence({gscSnapshot:{...snapshot,property:'<img src=x onerror=alert(1)>'}}),/<img/);
});
function render(originDetails){
 const executive={...summariseEvidence([{id:1,prompt_id:1,text:'Which community?',source:'gsc+model',engine:'chatgpt',ok:true,mentioned:true,cited:false,response_text:'Arada is one option.',origin_details:originDetails}]),cycle:'2026-10-29',measurement:{id:1,started_at:'2026-10-29',settings:{maxTokens:2000}},priorities:[]};
 return executiveReportHtml({project:{id:31,name:'Arada',domain:'arada.com'},generatedAt:'2026-10-29',period:{},executive,traffic:{},review:{notes:[],comparisons:[]},trend:{all:[],stable:[]}});
}
test('report shows the original query set, deduplicated, escaped and capped with an explicit label',()=>{
 const html=render({querySet:['<script>bad</script>','مسار','three','four','five','six','مسار'],queryExamples:['stale example'],gscSnapshot:snapshot});
 const section=html.slice(html.indexOf('id="report-section-search"'),html.indexOf('id="report-section-questions"'));
 assert.match(section,/Original Google queries \(first five\)/);assert.match(section,/&lt;script&gt;bad&lt;\/script&gt;/);
 assert.match(section,/مسار/);assert.doesNotMatch(section,/<script>bad|stale example|<br>six/);
});
test('report falls back to retained examples and explicitly labels missing wording',()=>{
 assert.match(render({queryExamples:['retained query']}),/retained query/);
 assert.match(render({}),/Original query wording was not retained/);
});
