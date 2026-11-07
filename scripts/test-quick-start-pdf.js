import test from 'node:test';
import assert from 'node:assert/strict';
import {quickStartPdf} from '../src/lib/quick-start-pdf.js';
import {mountQuickStart} from '../src/lib/quick-start.js';
export const sample={cycle:'2026-11-07',totals:{measured:40,named:12,cited:6,failed:0,unmeasured:0,missingChecks:0,possiblyTruncated:0},questions:Array.from({length:20},(_,i)=>({text:`Which digital wallets offer service ${i+1} in Dubai?`,named:1,cited:0,measured:2,failed:0,unmeasured:0})),engineCoverage:[{engine:'ChatGPT',named:6,cited:3,measured:20},{engine:'Perplexity',named:6,cited:3,measured:20}]};
export const actions=[{title:'Review the service page',evidence:{action_plan:{generation:'guided-check',change:'Check whether the page clearly explains international transfers and fees.',rationale:'Review the saved answers before changing your website.'}}}];
test('PDF creates a real multipage document from saved evidence',async()=>{
 const buffer=await quickStartPdf({id:77,brand_name:'Example',domain:'example.com'},sample,actions);
 assert.equal(buffer.subarray(0,5).toString(),'%PDF-');assert.ok(buffer.length>10000);assert.match(buffer.subarray(-100).toString(),/%%EOF/);
});
test('PDF endpoint requires authentication and checks project access before reading evidence',async()=>{
 const routes=[];const auth=()=>{};let reads=0,checked=false;
 mountQuickStart({get:(...a)=>routes.push(a),post:()=>{}},{requireAuth:auth,assertProject:async()=>{checked=true;return null;},many:()=>{reads++;}});
 const route=routes.find(r=>r[0].endsWith('/report.pdf'));assert.equal(route[1],auth);
 await route[2]({}, {},e=>{throw e;});assert.equal(checked,true);assert.equal(reads,0);
});
test('PDF route returns an attachment with saved evidence and no-store headers',async()=>{
 const routes=[],headers={};let body;
 const rows=[{id:1,prompt_id:1,text:'Which wallets offer transfers in Dubai?',cycle_date:'2026-11-07',engine:'chatgpt',ok:true,mentioned:true,cited:false,response_text:'Example provides transfers.',source_links:[]}];
 mountQuickStart({get:(...a)=>routes.push(a),post:()=>{}},{requireAuth:()=>{},assertProject:async()=>({id:1,brand_name:'Example',domain:'example.com'}),many:async sql=>sql.includes('FROM reporting_runs')?rows:[]});
 const route=routes.find(r=>r[0].endsWith('/report.pdf'));
 await route[2]({}, {setHeader:(k,v)=>headers[k]=v,send:v=>body=v},e=>{throw e;});
 assert.equal(headers['Content-Type'],'application/pdf');assert.equal(headers['Cache-Control'],'private, no-store');
 assert.equal(headers['Content-Disposition'],'attachment; filename="cited-example.com-quick-start.pdf"');assert.equal(body.subarray(0,5).toString(),'%PDF-');
});
