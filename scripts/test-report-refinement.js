import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {reportDecisionOrder} from '../src/lib/report-order.js';
import {decisionReportText} from '../src/lib/recommendation-decision.js';
import {reportPreparationHtml} from '../src/lib/report-preparation.js';
import {reportViewUrl,ceoReportHtml} from '../src/lib/report-ceo.js';
import {executiveReportHtml} from '../src/lib/report-executive-html.js';
import {summariseEvidence} from '../src/lib/report-evidence.js';
const src=readFileSync(new URL('../src/lib/report.js',import.meta.url),'utf8');
const note=(id,stage,status='open')=>{const d={stage,title:`Decision ${id}`,change:'Check the page',reviewed_at:'2026-10-01'};return {id,recommendation_id:id,status,decision_snapshot:d,notes:decisionReportText(d),selected_at:'2026-10-01',title:d.title};};
test('confirmed ready work precedes investigation; completed work and unconfirmed text stay secondary',()=>{
 const rows=[note(1,'investigate'),note(2,'ready','done'),note(3,'ready'),{...note(4,'ready'),notes:'Older selected text'}];
 assert.deepEqual([...rows].sort(reportDecisionOrder).map(n=>n.id),[3,1,4,2]);
 const prep=reportPreparationHtml({id:31,name:'Arada'},rows.map(n=>({...n,saved_notes:n.notes,saved_title:n.title,review_decision:{stage:'investigate',title:n.title}})));
 assert.ok(prep.indexOf('data-rec="3"')<prep.indexOf('data-rec="1"'));assert.equal(rows[0].id,1);
});
test('return URL keeps complete and one-sided ranges',()=>{
 assert.equal(reportViewUrl({project:{id:31},period:{chosen:true,from:'2026-10-01',to:'2026-10-02'}},'prepare'),'/api/projects/31/report/prepare?from=2026-10-01&to=2026-10-02');
 assert.equal(reportViewUrl({project:{id:31},period:{chosen:true,to:'2026-10-02'}},'prepare'),'/api/projects/31/report/prepare?to=2026-10-02');
});
test('standard report skips appendix work but preserves rendered evidence and trend output',async()=>{
 const calls=[];const track=(name,value)=>async()=>{calls.push(name);return structuredClone(value);};
 const executive={...summariseEvidence([{id:1,prompt_id:1,text:'Which company?',source:'manual',engine:'chatgpt',ok:true,mentioned:true,cited:false,response_text:'Complete.'}]),measurement:{id:47,started_at:'2026-10-01',settings:{maxTokens:2000}},cycle:'2026-10-01',priorities:[]};
 const ctx=vm.createContext({Date,one:async()=>({id:31,name:'Arada',domain:'arada.com'}),many:track('many',[]),windowFor:x=>x,readable:x=>x,groupActions:()=>[],persistence:track('persistence',{items:[]}),sourceGaps:track('sources',{sources:[]}),citedPagePatterns:track('patterns',{pages:0}),completed:track('completed',[]),rivals:track('rivals',[]),byPersona:track('personas',[]),trend:track('trend',{all:[],stable:[]}),aiTraffic:track('traffic',{}),reportEvidence:track('evidence',executive),reportReview:track('review',{notes:[note(1,'ready')],comparisons:[]}),reviewedReportPriorities:()=>[]});
 vm.runInContext(src.slice(src.indexOf('export async function buildReport(')).replace('export ',''),ctx);
 const all=await ctx.buildReport(31,{});calls.length=0;const lean=await ctx.buildReport(31,{}, {presentationOnly:true});
 for(const key of ['persistence','sources','patterns','completed','rivals','personas'])assert.ok(!calls.includes(key),key);
 for(const key of ['trend','traffic','evidence','review'])assert.ok(calls.includes(key),key);
 all.generatedAt=lean.generatedAt='2026-10-02';
 assert.equal(executiveReportHtml(all),executiveReportHtml(lean));assert.equal(ceoReportHtml(all),ceoReportHtml(lean));
 const html=executiveReportHtml(lean);assert.ok(html.indexOf('id="selected-actions"')<html.indexOf('Executive readout'));
});
