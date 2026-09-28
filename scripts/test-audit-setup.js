import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const source=readFileSync(new URL('../src/lib/prompts.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const index=readFileSync(new URL('../src/public/index.html',import.meta.url),'utf8');
function generator(rows){
 const calls=[];const context=vm.createContext({Date,complete:async(prompt,opts)=>{calls.push({prompt,...opts});return JSON.stringify(rows);},parseJsonArray:JSON.parse});
 vm.runInContext(source.replace(/^import .*\n/,'').replaceAll('export ',''),context);
 return {context,calls};
}
test('new suggestions reject stale date qualifiers but preserve current years and monetary budgets',async()=>{
 const y=new Date().getUTCFullYear();const rows=[
 {text:'What are the best private market opportunities in 2024?'},
 {text:`Which providers offer private market portfolios in ${y}?`},
 {text:'Which wealth managers serve families in Saudi Arabia?'},
 {text:'Which investment options are available for 2024 dollars?'}];
 const {context,calls}=generator(rows);const result=await context.generatePrompts({brand:'The Family Office',domain:'tfoco.com',category:'wealth management',market:'Saudi Arabia',qualifier:'high net worth families'});
 assert.equal(result.length,3);assert.ok(result.every(r=>r.text!==rows[0].text));assert.match(calls[0].prompt,new RegExp(`Current year: ${y}`));assert.match(calls[0].system,/not the literal meaning/);
});
test('all rejected output falls back to undated questions without assuming a small-business buyer',async()=>{
 const {context}=generator([{text:'What providers are best in 2024?'}]);const result=await context.generatePrompts({brand:'Example',category:'wealth management',market:'Saudi Arabia',qualifier:'families'});
 assert.ok(result.length);assert.doesNotMatch(JSON.stringify(result),/2024|small business/);
});
test('setup sends the explicit brand protection choice',async()=>{
 for(const checked of [true,false]){
  const dom=new JSDOM(index);const d=dom.window.document;d.getElementById('f_ambiguous').checked=checked;
  d.getElementById('f_brand').value='The Family Office';d.getElementById('f_domain').value='tfoco.com';
  let body,finish;const done=new Promise(r=>finish=r);const btn=d.getElementById('siteSave');const add=btn.addEventListener.bind(btn);btn.addEventListener=(name,fn)=>add(name,async e=>{await fn(e);finish();});
  const h=vm.createContext({document:d,$:id=>d.getElementById(id),parseRivals:()=>[],fetch:async(url,opts)=>{body=JSON.parse(opts.body);return {ok:false,status:400,json:async()=>({error:'test stop'})};}});
  vm.runInContext(app.slice(app.indexOf("$('siteSave').addEventListener"),app.indexOf('/* ---------- plan and usage ---------- */')),h);
  btn.click();await done;assert.equal(body.ambiguousName,checked);assert.equal(body.domain,'tfoco.com');
 }
});
test('creation persists protection before generating questions and defaults to false',async()=>{
 for(const input of [true,false,undefined,'true']){
  let handler;const writes=[];const project={id:27,brand_name:'The Family Office',domain:'tfoco.com',aliases:[],market:'SA'};
  const h=vm.createContext({app:{post:(url,auth,fn)=>handler=fn},requireAuth:()=>{},wrap:fn=>fn,ENGINE_IDS:['chatgpt'],getEntitlements:async()=>({plan:{engines:1,questions:20}}),checkCanAddSite:async()=>null,cityWithin:async()=>({name:null}),one:async sql=>sql.startsWith('SELECT')?null:project,query:async(sql,args)=>writes.push({sql,args}),generatePrompts:async()=>[],MARKET_NAMES:{SA:'Saudi Arabia'}});
  const start=server.indexOf("app.post('/api/projects',");const end=server.indexOf('\n}));',start)+5;vm.runInContext(server.slice(start,end),h);
  await handler({body:{domain:'tfoco.com',brandName:'The Family Office',ambiguousName:input,generate:false},session:{orgId:1}},{json:()=>{},status:()=>{throw new Error('Unexpected rejection');}});
  const own=writes.find(w=>w.sql.includes("'owned'"));assert.match(own.sql,/ambiguous_name/);assert.equal(own.args[4],input===true);
 }
});
