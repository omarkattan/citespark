import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const {JSDOM}=await import(process.env.JSDOM_MODULE);
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const index=readFileSync(new URL('../src/public/index.html',import.meta.url),'utf8');
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness(gsc,ga4){const dom=new JSDOM(index);const ctx=vm.createContext({state:{projectId:28,view:'connections'},esc,api:async url=>url.endsWith('/gsc')?gsc:url.endsWith('/ga4')?ga4:{},demandSection:()=>'<div id="demand">Search results</div>'});vm.runInContext(app.slice(app.indexOf('function gscQuestionPanel'),app.indexOf('function questionTools')),ctx);ctx.document=dom.window.document;vm.runInContext(app.slice(app.indexOf('const SETUP_VIEWS'),app.indexOf('async function viewConnections')),ctx);vm.runInContext(app.slice(app.indexOf('async function viewConnections'),app.indexOf('async function viewAnswerEvidence')),ctx);return {dom,ctx};}
test('GSC states show the next action without opening nested panels',async()=>{
 for(const [gsc,id] of [[{connected:false},'gscGrant'],[{connected:true},'gscSwitch'],[{connected:true,siteUrl:'sc-domain:bank.example'},'gscLoad']]){
 const {dom,ctx}=harness(gsc,{connected:false});dom.window.document.body.innerHTML=await ctx.viewSearchDemand();assert.ok(dom.window.document.querySelector('#gscPanel[open]'));assert.ok(dom.window.document.getElementById(id));assert.ok(dom.window.document.getElementById('gscPanel').compareDocumentPosition(dom.window.document.getElementById('demand'))&4);dom.window.close();}
});
test('source setup prioritises GSC, distinguishes property selection and allows skipping',async()=>{
 const {dom,ctx}=harness({connected:true},{connected:false});dom.window.document.body.innerHTML=await ctx.viewConnections();const text=dom.window.document.body.textContent;assert.ok(text.indexOf('1. Google Search Console')<text.indexOf('2. Google Analytics'));assert.match(text,/Account connected. Choose a property/);assert.match(text,/Not connected. Optional/);assert.match(ctx.setupJourney(),/data-setup-step="questions">Connect later/);dom.window.close();
});
test('errors and escaped property names remain visible',async()=>{
 const {ctx}=harness({error:true},{connected:true,propertyName:'<script>bad</script>'});assert.match(await ctx.viewSearchDemand(),/Retry connection status/);assert.doesNotMatch(await ctx.viewConnections(),/<script>/);assert.match(await ctx.viewConnections(),/Status unavailable/);
});
test('successful creation leads to connections without starting measurement',async()=>{
 const {dom}=harness({},{});const doc=dom.window.document;let saved;doc.getElementById('siteSave').addEventListener=(_,fn)=>saved=fn;doc.getElementById('siteDialog').close=()=>{};const state={};let selected,rendered;
 const ctx=vm.createContext({$:id=>doc.getElementById(id),state,esc,parseRivals:()=>[],fetch:async()=>({ok:true,json:async()=>({project:{id:99}})}),loadProjectList:async id=>selected=id,render:async()=>rendered=state.view,window:{scrollTo(){}},toast(){}});
 vm.runInContext(app.slice(app.indexOf("$('siteSave').addEventListener"),app.indexOf('/* ---------- plan and usage')),ctx);await saved();assert.equal(selected,99);assert.equal(rendered,'connections');dom.window.close();
});
test('Google return routes to source and surfaces failures in the visible view',async()=>{
 const start=app.indexOf('  if (returned) {');const code=app.slice(start,app.indexOf('  // Someone may have started',start));
 for(const ok of [true,false]){
 const dom=new JSDOM('<p id="gscReturnError"></p><details id="gscPanel"></details>');dom.window.document.getElementById('gscPanel').scrollIntoView=()=>{};let sites=0;const state={projectId:28};const ctx=vm.createContext({returned:{what:'gsc',ok,message:'Access declined'},state,$:id=>dom.window.document.getElementById(id),render:async()=>{},api:async()=>({connected:true}),loadGscSites:async()=>sites++,loadGscCandidates:async()=>{throw Error('No property yet');}});await vm.runInContext(`(async()=>{${code}})()`,ctx);assert.equal(state.view,'searchDemand');if(ok)assert.equal(sites,1);else assert.equal(dom.window.document.getElementById('gscReturnError').textContent,'Access declined');dom.window.close();}
});

test('saved setup choices persist per project and a failed save cannot advance the step',async()=>{
 const {ctx,dom}=harness({},{});let stored=new Map();ctx.api=async(url,opts)=>{stored.set(url,opts.body.step);return {step:opts.body.step};};
 await ctx.saveSetupStep('questions');assert.equal(ctx.state.setupStep,'questions');assert.equal(stored.get('/api/projects/28/setup-progress'),'questions');
 ctx.state.projectId=29;await ctx.saveSetupStep('sources');assert.equal(stored.get('/api/projects/28/setup-progress'),'questions');assert.equal(stored.get('/api/projects/29/setup-progress'),'sources');
 ctx.api=async()=>({error:'Save failed'});await assert.rejects(ctx.saveSetupStep('complete'),/Save failed/);assert.equal(ctx.state.setupStep,'sources');dom.window.close();
});
test('setup progress endpoint scopes reads and writes to the authorised project',()=>{
 const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');const start=server.indexOf("app.get('/api/projects/:id/setup-progress'");const end=server.indexOf("app.get('/api/projects/:id/setup',",start);const routes=server.slice(start,end);
 assert.equal((routes.match(/requireAuth/g)||[]).length,2);assert.equal((routes.match(/assertProject/g)||[]).length,2);assert.match(routes,/WHERE id=\$1/);assert.match(routes,/\[project.id,step\]/);assert.match(routes,/status\(400\)/);
});
test('project reload restores the stored step without forcing measured projects through setup',async()=>{
 const source=app.slice(app.indexOf('async function loadProject(id)'),app.indexOf('/**\n * Which site is open'));
 const {ctx,dom}=harness({},{});const doc=dom.window.document;let rendered;
 Object.assign(ctx,{$:id=>doc.getElementById(id),window:{innerWidth:1000},shortDate:x=>x,refreshRunScope(){},renderFigures:async()=>{},render:async()=>rendered=ctx.state.view});
 vm.runInContext(source,ctx);
 ctx.api=async url=>url.endsWith('/overview')?{project:{name:'Example',brand_name:'Example'},cycle:null}:{step:'questions'};await ctx.loadProject(28);assert.equal(rendered,'questions');
 ctx.api=async url=>url.endsWith('/overview')?{project:{name:'Second',brand_name:'Second'},cycle:null}:{step:null};await ctx.loadProject(29);assert.equal(rendered,'connections');
 ctx.state.view='overview';ctx.api=async url=>url.endsWith('/overview')?{project:{name:'Measured',brand_name:'Measured'},cycle:'2026-10-01',runs:10}:{step:null};await ctx.loadProject(30);assert.equal(rendered,'overview');assert.equal(ctx.state.setupStep,'complete');dom.window.close();
});
