import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {reportReadout} from '../src/lib/report-readout.js';
import {summariseEvidence} from '../src/lib/report-evidence.js';
import {reportHtml} from '../src/lib/report-html.js';
const q={id:1,text:'Compare accounts',source:'manual',measured:5,named:1,cited:2,engines:['chatgpt','claude'],failed:0,missing:0,unmeasured:0,possiblyTruncated:0};
test('readout keeps zero and unmeasured separate, preserves origins and excludes incomplete question claims',()=>{
 const qs=[q,{...q,id:2,text:'حساب التوفير',source:'gsc',named:3,cited:4},{...q,id:3,text:'A failed question',measured:0,named:0,cited:0,failed:5},{...q,id:4,text:'A partial question',named:0,cited:0,missing:1}];
 const r=reportReadout({questions:qs,totals:{measured:15}});
 assert.equal(r.strength.id,2);assert.equal(r.gap.id,1);assert.equal(r.languages.find(x=>x.label==='Arabic').questions,1);assert.equal(r.languages.find(x=>x.label==='Latin-script').measured,10);assert.equal(r.origins.find(x=>x.label==='Search Console-derived').questions,1);
 const empty=reportReadout({questions:[{...q,measured:0,named:0,cited:0}],totals:{measured:0}});assert.equal(empty.strength,null);assert.equal(empty.gap,null);
});
test('competitor callout uses only measured full-coverage peers, never retrospective or unequal samples',()=>{
 const e={questions:[],totals:{measured:50}},own={name:'Own',kind:'owned',method:'Measured in this cycle',measured:50,named:22};
 const review={comparisons:[own,{...own,name:'Partial',kind:'competitor',measured:10,named:10},{...own,name:'Retrospective',kind:'competitor',method:'Retrospective analysis',named:49},{...own,name:'Measured',kind:'competitor',named:28}]};
 assert.equal(reportReadout(e,review).leader.name,'Measured');assert.equal(reportReadout({...e,totals:{measured:60}},review).leader,null);
});
test('run menu disables stale options, validates estimates and ignores older responses',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);const dom=new JSDOM('<button id="runFullBtn"></button><span id="runFullCount">old count</span><button id="runUnrunBtn"></button><span id="runUnrunCount"></span>');
 const src=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');const start=src.indexOf('let runScopeRequest=0;');const code=src.slice(start,src.indexOf("\ndocument.addEventListener('click', () => {",start));
 const state={projectId:28};const pending=[];const api=()=>new Promise(resolve=>pending.push(resolve));const $=id=>dom.window.document.getElementById(id);
 const refresh=new Function('state','api','$',code+'; return refreshRunScope;')(state,api,$);
 const a=refresh();assert.equal($('runFullBtn').disabled,true);assert.match($('runFullCount').textContent,/checking/);
 const b=refresh();pending[1]({all:30,unrun:20,checksAll:150,checksUnrun:100,costAll:1.65,costUnrun:1.1});await b;
 pending[0]({all:10,unrun:0,checksAll:50,checksUnrun:0,costAll:0.55,costUnrun:0});await a;
 assert.match($('runFullCount').textContent,/30, 150/);assert.equal($('runFullBtn').disabled,false);
 const c=refresh();pending[2]({error:'Unavailable'});await c;assert.equal($('runFullBtn').disabled,true);assert.match($('runFullCount').textContent,/unavailable/);
});
test('executive section safely renders evidence, coverage and scope caveats',()=>{
 const rows=Array.from({length:30},(_,i)=>Array.from({length:5},(_,j)=>({prompt_id:i+1,text:i%2?'ما البنوك التي تقدم حسابات مناسبة؟':'Which banks offer suitable accounts?',source:i<2?'gsc':i<12?'generated':'custom',engine:['chatgpt','claude','perplexity','ai_mode','ai_overview'][j],ok:true,mentioned:j<2,cited:j<3,response_text:'Complete answer.'}))).flat();
 const e={...summariseEvidence(rows),cycle:'2026-09-29',measurement:{id:43,started_at:'2026-09-29',settings:{maxTokens:2000}}};
 const r={project:{id:28,name:'Layout test <img src=x>',domain:'example.test'},executive:e,generatedAt:'2026-09-29',trend:{comparable:false},review:{notes:[],comparisons:[{name:'Example brand',kind:'owned',method:'Measured in this cycle',measured:150,named:60,cited:90},{name:'Example competitor',kind:'competitor',method:'Measured in this cycle',measured:150,named:100,cited:95}]}};
 const html=reportHtml(r);assert.match(html,/Executive readout/);assert.match(html,/Adding questions changes the sample/);assert.match(html,/15 \/ 30/);assert.match(html,/Search Console-derived: 2 \/ 30/);assert.match(html,/Manually selected: 18 \/ 30/);assert.ok(!html.includes('<img src=x>'));
 if(process.env.REPORT_PREVIEW)writeFileSync(process.env.REPORT_PREVIEW,html);
});
