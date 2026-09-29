import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDecision,decisionReportText} from '../src/lib/recommendation-decision.js';
import {readFileSync} from 'node:fs';
const base={stage:'ready',page:'https://bank.test/app',evidence:'Answer 12, 29 September: transfer options unclear.',change:'Link the existing transfer comparison.'};
test('ready requires page, evidence and change, without accepting unsafe URLs',()=>{
 assert.equal(validateDecision(base).stage,'ready');
 for(const key of ['page','evidence','change']) assert.throws(()=>validateDecision({...base,[key]:''}));
 for(const page of ['javascript:alert(1)','https://user:pass@bank.test','not a url']) assert.throws(()=>validateDecision({...base,page}));
 assert.throws(()=>validateDecision({...base,evidence:'x'.repeat(4001)}));
});
test('investigation can be incomplete, no-change requires reasoning, stage is explicit',()=>{
 assert.equal(validateDecision({stage:'investigate',page:'',evidence:'',change:''}).stage,'investigate');
 assert.equal(validateDecision({...base,stage:'no_change',page:''}).stage,'no_change');
 assert.throws(()=>validateDecision({...base,stage:'no_change',evidence:''}));
 assert.throws(()=>validateDecision({...base,stage:'done'}));
});
test('report snapshots explain editorial status and leave legacy notes unchanged',()=>{
 assert.equal(decisionReportText(undefined),'');
 assert.match(decisionReportText({...base,reviewed_at:'2026-09-29'}),/Ready to implement/);
 assert.match(decisionReportText(base),/not a measured outcome/);
});
test('decision writes are tenant scoped and cannot change notes, task status or send messages',()=>{
 const src=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
 const route=src.slice(src.indexOf("app.put('/api/recommendations/:recId/review-decision'"),src.indexOf("app.post('/api/recommendations/:recId/report-note'"));
 assert.match(route,/org_id=\$2/);assert.match(route,/validateDecision/);
 assert.doesNotMatch(route,/notify|notes\s*=|status\s*=/);
});
test('decision route validates before writing and returns not found for another organisation',async()=>{
 const src=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
 const prefix="app.put('/api/recommendations/:recId/review-decision', requireAuth, wrap(async(req,res)=>{";
 const start=src.indexOf(prefix)+prefix.length;
 const body=src.slice(start,src.indexOf('\n}));',start));
 const route=new (Object.getPrototypeOf(async function(){}).constructor)('req','res','one','validateDecision',body);
 let writes=0,status=200,result;
 const res={status(n){status=n;return this},json(v){result=v;return this}};
 const one=async(sql,args)=>{writes++;assert.match(sql,/org_id=\$2/);assert.equal(args[1],7);return null};
 await route({body:{...base,evidence:''},params:{recId:'22'},session:{orgId:7}},res,one,validateDecision);
 assert.equal(status,400);assert.equal(writes,0);
 await route({body:base,params:{recId:'22'},session:{orgId:7}},res,one,validateDecision);
 assert.equal(status,404);assert.equal(writes,1);
 await route({body:base,params:{recId:'22'},session:{orgId:7}},res,async(sql,args)=>({review_decision:JSON.parse(args[2])}),validateDecision);
 assert.equal(result.stage,'ready');assert.ok(result.reviewed_at);
});
test('short titles are optional and validated without changing full instructions',()=>{
 assert.equal(validateDecision(base).title,undefined);
 const d=validateDecision({...base,title:'  Link transfer options  '});
 assert.equal(d.title,'Link transfer options');assert.equal(d.change,base.change);
 assert.throws(()=>validateDecision({...base,title:'x'.repeat(121)}));
 assert.throws(()=>validateDecision({...base,title:{text:'wrong'}}));
});
