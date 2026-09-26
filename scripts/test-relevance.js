/** Offline relevance safety regressions. No database or paid calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/lib/teardown.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
const quote = 'Track brand mentions in AI chatbot answers for Gulf businesses.';
const ctx = vm.createContext({});
vm.runInContext(source, ctx);
const candidate = (status) => ({relevance:{status,reason:'The category and buyer need match.',evidence:quote},why:['Observed feature'],actions:[{do:'UNSAFE_COPY_SENTINEL',because:'Copy it'}]});
for (const status of ['irrelevant','uncertain','invalid',undefined]) {
  test(`withholds advice for ${status} even when model supplies actions`, () => {
    const result = ctx.gateExplanation(candidate(status), {excerpt:quote});
    assert.equal(result.actions.length,0);assert.equal(result.why.length,0);
  });
}
test('missing relevance, fabricated quote and empty reason fail closed',()=>{
  for (const item of [{actions:[{do:'Copy'}]},candidate('relevant'),{...candidate('relevant'),relevance:{status:'relevant',reason:'',evidence:quote}}]) {
    assert.equal(ctx.gateExplanation(item,{excerpt:'Unrelated ecommerce session replay software'}).actions.length,0);
  }
});
test('relevant page evidence permits advice',()=>{
  assert.equal(ctx.gateExplanation(candidate('relevant'),{excerpt:quote}).actions.length,1);
});
test('fresh analysis gates before saving and cached analysis stays blocked',async()=>{
  const saved=[];
  const harness=vm.createContext({
    complete:async()=>JSON.stringify(candidate('irrelevant')),
    fetchPage:async()=>({html:'<h1>Shop visitor tracking</h1><p>Session replay software for ecommerce shops.</p>',via:'direct'}),
    one:async()=>saved.length?{result:saved[0]}:null,
    query:async(sql,params)=>saved.push(JSON.parse(params[2]))
  });
  vm.runInContext(source,harness);
  const args={url:'https://example.com',question:'AI chatbot brand mention tracking',ownDomain:'cited.ae',ownBrand:'Cited',kind:'editorial'};
  const result=await harness.teardown(args);
  assert.equal(result.explanation.relevance.status,'irrelevant');
  assert.equal(saved[0].explanation.actions.length,0);
  assert.equal(saved[0].context.version,3);
  const cached=await harness.teardown(args);
  assert.equal(cached.cached,true);assert.equal(cached.explanation.actions.length,0);
});
test('malformed model responses fall back without copy recommendations',async()=>{
  const harness=vm.createContext({complete:async()=> 'not JSON'});
  vm.runInContext(source,harness);
  const result=await harness.explainCitation({structure:{h2s:[],headingsMatchingQuestion:[],schemaTypes:[]}});
  assert.equal(result.relevance.status,'uncertain');assert.equal(result.actions.length,0);
});
const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('renderer suppresses unsafe actions from legacy and blocked results',()=>{
  const h=vm.createContext({esc});
  vm.runInContext(app.slice(app.indexOf('function renderTeardown('),app.indexOf('function dueLabel(')),h);
  for(const status of [undefined,'irrelevant','uncertain']){
    const html=h.renderTeardown({url:'https://example.com',explanation:candidate(status)});
    assert.doesNotMatch(html,/UNSAFE_COPY_SENTINEL/);assert.match(html,/Review this question/);
  }
  assert.match(h.renderTeardown({url:'https://example.com',explanation:candidate('relevant')}),/UNSAFE_COPY_SENTINEL/);
});
test('stored source cards show review copy without changing evidence or task state',()=>{
  const h=vm.createContext({esc,evidenceDetails:()=>'',dueLabel:()=>'',STATUS_LABEL:{open:'To do'},TYPE_LABEL:{},state:{},highlight:esc});
  const a=app.indexOf('function taskCard(');const end=app.indexOf('\nfunction ',a+1);
  vm.runInContext(app.slice(a,end),h);
  for(const type of ['source_gap','competitor_page']){
    const html=h.taskCard({id:3,type,status:'open',title:'UNSAFE_TITLE',action:'UNSAFE_ACTION',priority:6,effort:2,evidence:{domain:'example.com',citations:2,prompts:2}});
    assert.doesNotMatch(html,/UNSAFE_TITLE|UNSAFE_ACTION/);assert.match(html,/Review whether/);assert.match(html,/2 citations/);assert.match(html,/data-status="doing"/);
  }
});
test('review-question control opens the actual Questions tab',()=>{
  let clicked=false;
  const h=vm.createContext({e:{target:{closest:()=>true}},document:{querySelector:selector=>{assert.equal(selector,'[data-view="questions"]');return {click:()=>{clicked=true;}};}}});
  const a=app.indexOf("  if (e.target.closest('[data-review-question]'))");
  vm.runInContext('(function(){'+app.slice(a,app.indexOf("  const td =",a))+'})()',h);
  assert.equal(clicked,true);
});
