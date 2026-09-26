import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const h=vm.createContext({esc,helpDot:()=>''});
vm.runInContext(app.slice(app.indexOf('function renderDemandRows('),app.indexOf('async function viewTraffic(')),h);
test('unmatched Google queries do not hide independently measured AI visibility',()=>{
 const html=h.renderDemandRows([{cluster:'test',measurable:false,rate:0.5,measured:10,named:5,impressions:null,clicks:null}]);
 assert.match(html,/50%/);assert.match(html,/5 of 10 measured answers/);assert.match(html,/no matching queries/);
});
test('measured zero remains distinct from unmeasured visibility',()=>{
 const base={cluster:'test',measurable:true,impressions:0,clicks:0,matchedQueries:1};
 const zero=h.renderDemandRows([{...base,rate:0,measured:10,named:0}]);
 const missing=h.renderDemandRows([{...base,rate:null,measured:0,named:0}]);
 assert.match(zero,/0%/);assert.match(zero,/0 of 10 measured answers/);assert.match(missing,/Not measured/);assert.doesNotMatch(missing,/0%/);
});
test('query examples are escaped and counts and matching limits are visible',()=>{
 const html=h.renderDemandRows([{cluster:'test',measurable:true,rate:0,measured:10,named:0,impressions:150,clicks:2,matchedQueries:7,queryExamples:['<script>bad</script>']}]);
 assert.match(html,/from 7 queries/);assert.match(html,/candidate matches/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/does not establish the same buyer intent/);
});
test('disconnected Search Console sends the user directly to its connection workflow',()=>{
 const html=h.demandSection({rows:[],sources:[{ok:false,name:'Google',error:'Not connected'}]});
 assert.match(html,/data-open-view="questions" data-open-gsc/);assert.doesNotMatch(html,/Connect in Setup/);
});
test('demand output retains query counts and supplies examples without changing matched totals',async()=>{
 const code=readFileSync(new URL('../src/lib/demand.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/^export /gm,'');
 const h=vm.createContext({many:async sql=>sql.includes('SELECT cluster, text')?[{cluster:'solar',text:'Solar panels'}]:[{cluster:'solar',questions:1,measured:10,named:5}]});vm.runInContext(code,h);
 const rows=await h.demandByCluster(1,[{query:'solar panels',impressions:100,clicks:2},{query:'solar power',impressions:50,clicks:1}]);
 assert.equal(rows[0].impressions,150);assert.equal(rows[0].matchedQueries,2);assert.equal(rows[0].rate,0.5);assert.deepEqual(Array.from(rows[0].queryExamples),['solar panels','solar power']);
});
