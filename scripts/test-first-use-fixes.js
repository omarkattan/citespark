/** Read-only regression checks. No real database, network or paid provider calls. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/cited_test';
process.env.MOCK_MODE = 'true';
globalThis.fetch = async () => { throw new Error('Network is forbidden in these regression tests'); };
const { buildBrief } = await import('../src/lib/brief.js');
const { teardownContext, teardown, teardownTopCited, deterministicExplanation } = await import('../src/lib/teardown.js');
const { pool } = await import('../src/db/index.js');
pool.query = async () => { throw new Error('Real database access is forbidden'); };

const input = {
  project: { brand_name: 'Cited', domain: 'cited.ae', market: 'AE', qualifier: 'marketing teams' },
  prompt: { text: 'Which AI visibility tools should I use?', cluster: 'visibility', ai_search_volume: 1450 },
  engines: [{ label: 'ChatGPT', measured: true, named: false, answer: 'An answer.', citations: [] }],
  persona: null, siblings: []
};

test('brief never turns a stored estimate, including zero or null, into measured demand', () => {
  for (const volume of [1450, 0, null]) {
    const out = buildBrief({ ...input, prompt: { ...input.prompt, ai_search_volume: volume } });
    assert.match(out, /Monthly volume for this question is not verified/);
    assert.doesNotMatch(out, /times per month|1450|answered from its own knowledge/);
    assert.match(out, /this is not the measurement date/);
    assert.match(out, /Cited is NOT named/);
    assert.match(out, /cited\.ae/);
  }
});

test('brief preserves unmeasured verdicts and citations and requests relevance review', () => {
  const out = buildBrief({ ...input, engines: [{ ...input.engines[0], measured: false, citations: [{url:'https://example.com/source'}] }] });
  assert.match(out, /ChatGPT: not measured/);
  assert.match(out, /https:\/\/example.com\/source/);
  assert.match(out, /flag the question for review/);
  assert.doesNotMatch(out, /a the UAE|typical the UAE|the the UAE/);
});

test('analysis context normalises old classification objects and separates brands and domains', () => {
  const base = { kind: 'editorial', ownBrand: 'Cited', ownDomain: 'cited.ae' };
  const context = teardownContext(base);
  assert.deepEqual(teardownContext({...base,kind:{kind:'editorial',reachable:true}}), context);
  assert.equal(teardownContext({...base,kind:{}}).kind,'unknown');
  assert.notDeepEqual(teardownContext({...base,ownBrand:'Other'}),context);
  assert.notDeepEqual(teardownContext({...base,ownDomain:'other.ae'}),context);
  assert.notDeepEqual(teardownContext({...base,kind:'competitor'}),context);
  assert.equal(context.version,2);
});

test('cached advice lookup is scoped to version, exact brand, domain and source kind', async () => {
  const original=pool.query;
  try {
    let called=false;
    pool.query=async (sql,params)=>{
      called=true;
      assert.match(sql,/result->'context' = \$3::jsonb/);
      assert.deepEqual(JSON.parse(params[2]),teardownContext({kind:'directory',ownBrand:'Cited',ownDomain:'cited.ae'}));
      return {rows:[{result:{ok:true,kind:'directory',context:JSON.parse(params[2])}}]};
    };
    const result=await teardown({url:'https://example.com',question:'A question',kind:{kind:'directory'},ownBrand:'Cited',ownDomain:'cited.ae'});
    assert.equal(result.cached,true); assert.equal(result.kind,'directory'); assert.ok(called);
  } finally {pool.query=original;}
});

test('automatic analysis passes competitor labels and the owned domain into the same cache context',async()=>{
  const original=pool.query;
  try {
    let context;
    pool.query=async(sql,params)=>{
      if(sql.includes('SELECT * FROM projects'))return {rows:[{id:1,domain:'cited.ae',brand_name:'Cited'}]};
      if(sql.includes('SELECT domain FROM entities'))return {rows:[{domain:'rival.example'}]};
      if(sql.includes('FROM citations c'))return {rows:[{url:'https://rival.example/page',domain:'rival.example',citations:2,question:'Which tool?'}]};
      if(sql.includes('SELECT result FROM page_teardowns')) {
        context=JSON.parse(params[2]); return {rows:[{result:{ok:true,kind:context.kind,context}}]};
      }
      throw new Error('Unexpected query: '+sql);
    };
    const result=await teardownTopCited(1,{cycle:'2026-09-26'});
    assert.equal(result.torn,1);
    assert.equal(context.kind,'competitor');assert.equal(context.ownDomain,'cited.ae');
  } finally {pool.query=original;}
});

test('fallback observations do not invent a citation cause or claim to have inspected the owned page',()=>{
  const result=deterministicExplanation({headingsMatchingQuestion:[],statMentions:0},'editorial');
  const text=JSON.stringify(result);
  assert.match(text,/reason for the citation is unknown/);
  assert.doesNotMatch(text,/domain.s authority|Neither this page nor yours/);
});

const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
function part(start,end){return app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));}
const escape=(value)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

test('source analysis renders old and new classifications safely without causal confidence badges',()=>{
  const ctx=vm.createContext({esc:escape});
  vm.runInContext(part('function renderTeardown(', 'function dueLabel('),ctx);
  for(const kind of ['editorial',{kind:'directory'},null]) {
    const out=ctx.renderTeardown({kind,url:'https://example.com',structure:{},explanation:{confidence:'high',why:['A feature <script>'],actions:[]}});
    assert.doesNotMatch(out,/\[object Object\]|high confidence|<script>/);
    assert.match(out,/interpretation, not a proven cause/);
  }
});

test('first-run progress replaces the unmeasured state and restores it when stopped',()=>{
  const els=new Map();const get=id=>{if(!els.has(id))els.set(id,{style:{},hidden:false});return els.get(id);};
  const ctx=vm.createContext({$:get,state:{overview:null},PHASE_LABEL:{thinking:'Reading answers and writing your actions'},esc:escape});
  vm.runInContext(part('async function renderFigures()', 'async function render()'),ctx);
  vm.runInContext(part('function showProgress(', 'function deltaFig('),ctx);
  ctx.showProgress('thinking',10,10,[]);
  assert.match(get('figures').innerHTML,/Measurement in progress/);
  assert.doesNotMatch(get('figures').innerHTML,/Not measured yet|Start the first measurement/);
  assert.equal(get('cycleCount').textContent,'10 of 10 answers');
  ctx.hideProgress();assert.match(get('figures').innerHTML,/Not measured yet/);
});

test('successful site creation opens Questions, not Setup',async()=>{
  let callback;let opened;
  const fields={siteSave:{addEventListener:(_,cb)=>{callback=cb;}},siteDialog:{close(){}},f_aliases:{value:''}};
  const ctx=vm.createContext({
    $:id=>fields[id]||(fields[id]={value:'test',textContent:''}),
    fetch:async()=>({ok:true,status:200,json:async()=>({project:{id:25}})}),
    parseRivals:()=>[],loadProjectList:async(id)=>assert.equal(id,25),toast:()=>{},
    document:{querySelector:selector=>({click:()=>{opened=selector;}})}
  });
  vm.runInContext(part("$('siteSave').addEventListener",'/* ---------- plan and usage ---------- */'),ctx);
  await callback();assert.equal(opened,'.tab[data-view="questions"]');
});
