import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function render(conn,rows,demand,failPath){
 const h=vm.createContext({state:{projectId:25,overview:{project:{domain:'example.com'}}},esc,helpDot:()=>'',pct:x=>`${x*100}%`,api:async p=>{if(p===failPath)throw Error('Offline');if(p.endsWith('/ga4'))return conn;if(p.endsWith('/traffic'))return rows;if(p.endsWith('/demand'))return demand;return {connections:[]};}});
 vm.runInContext(app.slice(app.indexOf('function renderDemandRows('),app.indexOf('async function loadGa4Properties(')),h);
 return h.viewTraffic();
}
const demand={sources:[],method:'Different windows',rows:[{cluster:'solar',measurable:true,impressions:100,clicks:2,matchedQueries:1,queryExamples:['solar power'],rate:0.5,named:5,measured:10}]};
for(const [label,conn,rows] of [
 ['GA4 populated',{connected:true,propertyId:'123'},{rows:[{platform:'ChatGPT',classification_method:'derived',sessions:10,conversions:1,revenue:0}]}],
 ['GA4 disconnected',{connected:false,configured:true},{}],
 ['GA4 property not chosen',{connected:true,email:'example@example.com'},{}],
 ['GA4 connected but no traffic yet',{connected:true,propertyId:'123'},[]],
 ['GA4 connection status error',{error:'Offline'},{}],
 ['GA4 traffic error',{connected:true,propertyId:'123'},{error:'Offline'}]
])test(`GSC evidence remains visible with ${label}`,async()=>{
 const html=await render(conn,rows,demand);assert.equal((html.match(/id="demandPanel"/g)||[]).length,1);assert.match(html,/solar power/);assert.match(html,/5 of 10 measured answers/);
});
test('network failure loading GA4 does not discard successful GSC data',async()=>{
 const html=await render(null,{},demand,'/api/projects/25/ga4');assert.match(html,/connection status could not be loaded/);assert.match(html,/solar power/);
});
test('missing GSC data shows unavailable, not a false no-query result',async()=>{
 const html=await render({connected:false,configured:true},{},null,'/api/projects/25/demand');assert.match(html,/Search data could not be loaded/);assert.doesNotMatch(html,/No topic matched/);assert.match(html,/id="ga4Connect"/);
});
