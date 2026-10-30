import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const start=source.indexOf('const actionPreparations = new Map();');
const routes=source.slice(start,source.indexOf('\n/**',start));
const settle=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const handlers={};let calls=0,saves=0,finish,progress,verified=true;
 const context=vm.createContext({Map,Date,console:{error:()=>{}},app:{get:(path,auth,fn)=>handlers.get=fn,post:(path,auth,fn)=>handlers.post=fn},requireAuth:()=>{},wrap:f=>f,
 assertProject:async(req,res)=>{if(req.session.orgId!==1){res.status(404).json({error:'Not found'});return null;}return {id:39,org_id:1};},one:async()=>({internal:false}),verifiedEnough:async()=>verified,
 buildRecommendations:async(_id,options)=>{calls++;progress=options.onActionProgress;return new Promise((resolve,reject)=>finish={resolve,reject});},persistRecommendations:async()=>{saves++;}});
 vm.runInContext(routes,context);
 async function request(method,orgId=1){let code=200,result;const res={status(n){code=n;return this;},json(data){result=data;}};await handlers[method]({session:{orgId},body:{refreshActions:false}},res);return {code,result};}
 return {request,get calls(){return calls;},get saves(){return saves;},get finish(){return finish;},report:p=>progress(p),unverify:()=>{verified=false;}};
}
test('preparation acknowledges immediately, deduplicates concurrent starts and exposes progress until persistence finishes',async()=>{
 const f=fixture();const first=await f.request('post');assert.equal(first.code,202);assert.equal(first.result.phase,'running');assert.equal(f.calls,1);
 assert.equal((await f.request('post')).code,202);assert.equal(f.calls,1);f.report({done:3,total:10,grounded:3});assert.equal((await f.request('get')).result.done,3);
 f.finish.resolve([{}]);await settle();assert.equal(f.saves,1);assert.equal((await f.request('get')).result.phase,'done');
});
test('failed jobs are labelled failed and retry is explicit, verification and project scope still apply',async()=>{
 const f=fixture();assert.equal((await f.request('get',2)).code,404);assert.equal((await f.request('post',2)).code,404);assert.equal(f.calls,0);
 f.unverify();assert.equal((await f.request('post')).code,403);assert.equal(f.calls,0);
 const g=fixture();await g.request('post');g.finish.reject(Error('Provider failed'));await settle();assert.equal((await g.request('get')).result.phase,'failed');assert.equal(g.saves,0);
 await g.request('post');assert.equal(g.calls,2);g.finish.resolve([]);await settle();
});
