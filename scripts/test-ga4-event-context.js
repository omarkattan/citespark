import test from 'node:test';
import assert from 'node:assert/strict';
import {summariseEventContext,isCareersPath} from '../src/lib/traffic-event-context.js';
import {trafficSourceLabel} from '../src/lib/traffic-sources.js';
import {eventContextHtml} from '../src/lib/traffic-html.js';
const scope={from:'2026-09-01',to:'2026-09-30',eventState:'ready',events:[{name:'form_success',count:3}],pages:[{page:'/en/careers',conversions:1},{page:'/accounts',conversions:2}]};
const context={state:'ready',rows:[{date:'2026-09-01',name:'form_success',page:'/en/careers',count:1},{date:'2026-09-30',name:'form_success',page:'/accounts',count:2},{date:'2026-08-01',name:'old',page:'/other',count:8}]};
test('context reconciles per event and page within exact date window',()=>{
 const result=summariseEventContext(context,scope);assert.equal(result.eventContextState,'ready');assert.equal(result.eventPages.length,2);assert.equal(result.eventPages[0].count,2);
});
test('equal overall totals cannot hide incorrect event or page attribution',()=>{
 const wrongPage={...context,rows:context.rows.map(r=>r.page==='/accounts'?{...r,page:'/en/careers'}:r)};
 const wrongName={...context,rows:context.rows.map(r=>({...r,name:'other'}))};
 for(const c of [wrongPage,wrongName]){const result=summariseEventContext(c,scope);assert.equal(result.eventContextState,'mismatch');assert.deepEqual(result.eventPages,[]);}
 assert.equal(summariseEventContext(null,scope).eventContextState,'needs_sync');
 assert.equal(summariseEventContext(context,{...scope,eventState:'mismatch'}).eventContextState,'mismatch');
});
test('careers signal is explicitly limited to paths and never removes events',()=>{
 assert.ok(isCareersPath('/en/careers'));assert.ok(isCareersPath('/jobs/123'));assert.equal(isCareersPath('/career-advice'),false);
 const data={...summariseEventContext(context,scope),pages:scope.pages};
 const html=eventContextHtml(data);assert.match(html,/1 key events/);assert.match(html,/counts remain in the total/);assert.match(html,/not necessarily where the event happened/);assert.match(html,/cannot establish overlap/);assert.match(eventContextHtml(data,{compact:true}),/careers or jobs/);
});
test('context values are escaped and unavailable detail is not zero',()=>{
 const html=eventContextHtml({eventContextState:'ready',eventPages:[{name:'<script>x</script>',page:'<img onerror=x>',count:1}]});assert.doesNotMatch(html,/<script>|<img/);assert.match(eventContextHtml({}),/unavailable/);
});
test('Copilot aliases group only exact known names without broad source matches',()=>{
 for(const source of ['Copilot','copilot.com','www.copilot.com','COPILOT.MICROSOFT.COM'])assert.equal(trafficSourceLabel(source),'Copilot');
 assert.equal(trafficSourceLabel('copilot.com.evil.example'),'copilot.com.evil.example');
});
