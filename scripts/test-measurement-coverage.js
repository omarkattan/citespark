import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coverageFor,requestCounts} from '../src/lib/measurement-coverage.js';
import {summariseEvidence} from '../src/lib/report-evidence.js';
import {executiveReportHtml} from '../src/lib/report-executive-html.js';
import {readFileSync} from 'node:fs';
const row=(id,engine)=>({prompt_id:id,text:'Question '+id,engine,ok:true,response_text:'A complete answer.',mentioned:false,cited:false});
test('planned checks, attempts and skipped checks stay separate',()=>{
 assert.deepEqual(requestCounts(138,new Map([['gemini',12],['others',115]])),{planned:138,attempted:127,skipped:11});
});
test('TFO coverage reconstruction reports 11 missing results without pretending the plan was retained',()=>{
 const engines=['gemini','chatgpt','claude','perplexity','ai_mode','ai_overview'];
 const rows=[];for(let id=1;id<=23;id++)for(const e of engines)if(e!=='gemini'||id<=12)rows.push(row(id,e));
 const result=coverageFor(rows,{settings:{engines,runs:1}});
 assert.equal(result.expected,138);assert.equal(result.missing,11);assert.equal(result.basis,'recorded-questions-and-settings');
 assert.equal(result.questions.filter(q=>q.missing===1).length,11);
});
test('failed and empty responses are stored results, not skipped checks',()=>{
 const rows=[{...row(1,'chatgpt'),ok:false},{...row(1,'gemini'),response_text:''}];
 const c=coverageFor(rows,{settings:{engines:['chatgpt','gemini'],runs:1}});
 assert.equal(c.missing,0);const e=summariseEvidence(rows,{coverage:c});assert.equal(e.totals.failed,1);assert.equal(e.totals.unmeasured,1);assert.equal(e.totals.measured,0);
});
test('recorded plan includes entirely unasked questions and does not recommend gaps from missing evidence',()=>{
 const rows=[row(1,'chatgpt'),row(1,'claude')];
 const plan=[{prompt_id:1,text:'Question 1',engine:'chatgpt'},{prompt_id:1,text:'Question 1',engine:'claude'},{prompt_id:1,text:'Question 1',engine:'gemini'},{prompt_id:2,text:'Never asked',engine:'gemini'}];
 const c=coverageFor(rows,{collection_plan:plan});const e=summariseEvidence(rows,{coverage:c});
 assert.equal(c.missing,2);assert.equal(e.questions.length,2);assert.equal(e.questions[1].measured,0);
 assert.ok(!e.priorities.some(p=>p.do==='Review a buyer question with no recorded presence.'));
 assert.match(executiveReportHtml({executive:e,project:{name:'Test'},trend:{},methodNotes:[],limitations:[]}),/2 expected checks have no stored result/);
});
test('legacy unknown remains unknown and extra retry samples cannot hide another engine gap',()=>{
 assert.equal(coverageFor([row(1,'chatgpt')],{legacy:true}).missing,null);
 const c=coverageFor([row(1,'chatgpt'),row(1,'chatgpt')],{settings:{engines:['chatgpt','gemini'],runs:1}});
 assert.equal(c.missing,1);
});
test('cycle UI uses actual attempted counts and neutral comparison wording',()=>{
 const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
 const functions=app.slice(app.indexOf('function deltaFig'),app.indexOf('function answerSampleLabel'));
 const delta=new Function('esc',`${functions};return deltaFig;`)(String);
 assert.match(delta({delta:null}),/No comparable change/);assert.doesNotMatch(delta({delta:null}),/first cycle/);
 assert.match(app,/checks planned, \$\{s.attempted\} attempted/);
});
test('engine-only retry sends the selected engine and avoids unsupported flat-price claims',()=>{
 const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
 assert.match(app,/data-reask-engine="\$\{esc\(r.engine\)\}"/);
 assert.match(app,/JSON.stringify\(engine \? \{ engine \} : \{\}\)/);
 assert.doesNotMatch(app,/Costs about \$0\.05 and usually takes/);
});
