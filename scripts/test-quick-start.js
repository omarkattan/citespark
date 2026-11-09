import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {validateQuickQuestions,quickStartMutationAllowed} from '../src/lib/quick-start.js';
import {generatePrompts,isProviderDiscovery} from '../src/lib/prompts.js';
import {PLANS} from '../src/lib/plans.js';
const require=createRequire(import.meta.url);
const {JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const list=Array.from({length:20},(_,i)=>`Which providers offer service ${i+1} in Dubai?`);
test('Quick Start requires 20 distinct questions',()=>{
 assert.equal(validateQuickQuestions(list).length,20);
 assert.throws(()=>validateQuickQuestions(list.slice(1)));
 assert.throws(()=>validateQuickQuestions([...list.slice(1),list[1].toUpperCase()]));
 assert.throws(()=>validateQuickQuestions([...list.slice(1),'']));
});
test('free controls allow signup, evidence preparation and checkout, but not paid mutations',()=>{
 for(const path of ['/register','/login','/logout','/verify/resend','/billing/checkout','/projects/1/quick-start/questions','/projects/1/run'])assert.equal(quickStartMutationAllowed('POST',path),true,path);
 for(const path of ['/projects/1/report/analyst','/projects/1/rebuild','/projects/1/personas/suggest','/prompts/1/reask','/run-all'])assert.equal(quickStartMutationAllowed('POST',path),false,path);
 assert.equal(quickStartMutationAllowed('PATCH','/projects/1/models'),false);
 assert.equal(PLANS.free.questions,20);assert.equal(PLANS.free.engines,2);assert.equal(PLANS.free.runs,1);
});
const html=fs.readFileSync(new URL('../src/public/quick-start.html',import.meta.url),'utf8');
const js=fs.readFileSync(new URL('../src/public/quick-start.js',import.meta.url),'utf8');
const settle=()=>new Promise(r=>setImmediate(r));
async function fixture({verified=true,used=false,advanced=false,failRun=false,thinking=false,incomplete=false,failDiscovery=false,failSuggestions=false,guidedCheck=false,existing=false,newLink=false,duplicate=false,failCompetitors=false,zeroVisibility=false}={}){
 const dom=new JSDOM(html,{url:'https://cited.ae/quick-start'+(newLink?'?new=1':''),runScripts:'outside-only'});
 const w=dom.window,calls=[];let created=used||existing,ran=used,savedQuestions=incomplete?list.slice(0,15):list;
 w.countryOptions=()=>'<option value="AE">United Arab Emirates</option>';w.DEFAULT_COUNTRY='AE';w.print=()=>{};
 const project={id:1,brand_name:'Example',domain:'example.com',category:'accountants',market:'AE',quick_start:true};
 const billing={advanced,quickStart:{enabled:true,used},plan:{id:advanced?'starter':'free'}};
 w.fetch=async(url,opts={})=>{
  calls.push([url,opts.body&&JSON.parse(opts.body)]);let data,status=200;
  if(url==='/api/me')data={signedIn:true,emailVerified:verified};
  else if(url==='/api/billing')data=billing;
  else if(url==='/api/projects'&&!opts.method)data=created?[project]:[];
  else if(url==='/api/projects'){created=true;if(duplicate){status=409;data={error:'You are already tracking that domain'};}else data={project};}
  else if(url==='/api/discover'){if(failDiscovery){status=503;data={error:'Unavailable'};}else data={domain:'example.com',brandName:'Example',category:'accountants',market:'AE'};}
  else if(url.endsWith('/quick-start/controls'))data={emailAvailable:true,emailWhenDone:false,competitors:[],customCompetitors:false};
  else if(url.endsWith('/quick-start/competitors')){status=failCompetitors?422:200;data=failCompetitors?{error:'Check the competitor website address.'}:{ok:true};}
  else if(url.endsWith('/quick-start/preferences'))data={ok:true};
  else if(url.endsWith('/quick-start/assistant')){const body=JSON.parse(opts.body);data={items:body.items.map((x,i)=>i===0&&body.scope==='questions'?'Who are the best accountants for small businesses in Dubai?':x)};}
  else if(url.endsWith('/quick-start'))data={project,billing,questions:savedQuestions.map((text,id)=>({text,id:id+1})),claim:ran?{}:null,measurement:ran?{status:'completed'}:null};
  else if(url.endsWith('/quick-start/questions')){savedQuestions=JSON.parse(opts.body).questions;data={ok:true};}
  else if(url.endsWith('/quick-start/suggestions')){data={questions:failSuggestions?list.slice(0,17):list};}
  else if(url.endsWith('/quick-start/profile')){Object.assign(project,{brand_name:JSON.parse(opts.body).brandName,category:JSON.parse(opts.body).category});data={ok:true};}
  else if(url.endsWith('/run-scope'))data={checksAll:40,costAll:1.2};
  else if(url.endsWith('/run')){if(failRun){status=402;data={error:'Your free report has already been used.'};}else{ran=true;data={ok:true};}}
  else if(url.endsWith('/cycle-status'))data={phase:thinking?'thinking':'done'};
  else if(url.endsWith('/overview'))data={project,cycle:'2026-11-07',visibility:.5,runs:40,engines:[{engine:'chatgpt',rate:zeroVisibility?0:.5,runs:20}],engineChecks:[{engine:'chatgpt',attempted:20,failed:0,unmeasured:0},{engine:'perplexity',attempted:20,failed:20,unmeasured:0}],competitors:[]};
  else if(url.endsWith('/prompts'))data=list.map((text,id)=>({id:id+1,text,runs:[{mentioned:true,cited:true}]}));
  else if(url.includes('/recommendations?'))data={tasks:guidedCheck?[{title:'Check the relevant page',evidence:{action_plan:{generation:'guided-check',title:'Check the relevant page',change:'Review this question against the page.'}}}]:[]};
  else if(url.endsWith('/competitor-review'))data={candidates:[]};
  else if(url.endsWith('/answers'))data={runs:[{engine:'chatgpt',measured:true,mentioned:true,response_text:'Example <script>alert(1)</script>',citations:[{url:'javascript:alert(1)',domain:'unsafe'},{url:'https://example.com',domain:'example.com'}]}]};
  else throw new Error('Unexpected request '+url);
  return {status,ok:status===200,json:async()=>data};
 };
 await vm.runInContext(`(async()=>{${js}\n})()`,dom.getInternalVMContext());
 return {dom,w,calls};
}
test('new account completes website → 20 questions → scan → evidence report',async()=>{
 const {dom,w,calls}=await fixture();
 w.document.getElementById('domain').value='example.com';
 w.document.getElementById('setup').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();await settle();
 assert.equal(w.document.getElementById('brand').value,'Example');
 assert.equal(w.document.querySelector('#question-editor').open,false);
 assert.equal(w.document.querySelector('#business-edit').hidden,true);
 assert.equal(w.document.querySelectorAll('.question-samples li').length,3);
 assert.equal(w.document.querySelectorAll('[data-question]').length,20);
 w.document.getElementById('run').click();await settle();await settle();await settle();
 assert.match(w.document.getElementById('content').textContent,/Your Quick Start report/);
 assert.equal(calls.filter(([u])=>u.endsWith('/run')).length,1);
 assert.equal(calls.find(([u])=>u.endsWith('/quick-start/questions'))[1].questions.length,20);
 const evidence=w.document.querySelector('[data-evidence]');evidence.open=true;evidence.dispatchEvent(new w.Event('toggle'));await settle();
 assert.equal(evidence.querySelector('script'),null);
 assert.equal(evidence.querySelector('a[href^="javascript:"]'),null);
 assert.match(evidence.textContent,/<script>/);
 dom.window.close();
});
test('unverified account can prepare questions but cannot start the scan',async()=>{
 const {dom,w,calls}=await fixture({verified:false});
 w.document.getElementById('domain').value='example.com';
 w.document.getElementById('setup').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();await settle();
 w.document.getElementById('run').click();await settle();
 assert.equal(calls.some(([u])=>u.endsWith('/run')),false);
 const notice=w.document.getElementById('run-verify'),error=w.document.getElementById('run-error');
 assert.equal(notice.hidden,false);
 assert.ok(notice.closest('#ready'));
 assert.ok(notice.querySelector('#resend'));
 assert.match(error.textContent,/Confirm your email/);
 assert.equal(error.hidden,false);
 assert.equal(w.document.activeElement,error);
 assert.equal(w.document.querySelectorAll('#resend').length,1);
 assert.equal(w.document.querySelectorAll('[data-question]').length,20);
 assert.equal(w.document.getElementById('run').disabled,false);
 dom.window.close();
});
test('returning free account opens saved report, no automatic repeat charge',async()=>{
 const {dom,w,calls}=await fixture({used:true});
 assert.match(w.document.getElementById('content').textContent,/Your Quick Start report/);
 assert.equal(calls.some(([u])=>u.endsWith('/run')),false);
 assert.equal(w.document.querySelector('a[href*="mode=advanced"]'),null);dom.window.close();
});
test('paid account keeps the same simple report and can open advanced controls',async()=>{
 const {dom,w}=await fixture({used:true,advanced:true});
 assert.ok(w.document.querySelector('a[href*="mode=advanced"]'));dom.window.close();
});

test('incomplete suggestions are completed automatically without manual question fields',async()=>{
 const {dom,w,calls}=await fixture({incomplete:true});
 w.document.getElementById('domain').value='example.com';
 w.document.getElementById('setup').dispatchEvent(new w.Event('submit',{cancelable:true}));
 await settle();await settle();await settle();
 assert.equal(w.document.querySelectorAll('[data-question]').length,20);
 assert.equal(calls.filter(([u])=>u.endsWith('/quick-start/suggestions')).length,1);
 assert.equal(calls.some(([u])=>u.endsWith('/run')),false);
 dom.window.close();
});
test('failed automatic question preparation offers retry and never spends on a scan',async()=>{
 const {dom,w,calls}=await fixture({incomplete:true,failSuggestions:true});
 w.document.getElementById('domain').value='example.com';
 w.document.getElementById('setup').dispatchEvent(new w.Event('submit',{cancelable:true}));
 await settle();await settle();
 assert.ok(w.document.getElementById('retry-questions'));
 assert.equal(w.document.querySelector('[data-question]'),null);
 assert.equal(calls.some(([u])=>u.endsWith('/run')),false);
 dom.window.close();
});
test('saved results appear while action analysis runs, without restarting the scan',async()=>{
 const {dom,w,calls}=await fixture({used:true,thinking:true});
 assert.match(w.document.getElementById('content').textContent,/Your results are ready/);
 assert.match(w.document.getElementById('content').textContent,/appear here automatically/);
 assert.equal(calls.some(([u])=>u.endsWith('/run')),false);
 dom.window.close();
});
test('unreadable website allows a concise manual fallback',async()=>{
 const {dom,w,calls}=await fixture({failDiscovery:true});
 w.document.getElementById('domain').value='example.com';
 w.document.getElementById('setup').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
 assert.ok(w.document.getElementById('manual'));
 assert.equal(calls.some(([u,b])=>u==='/api/projects'&&b),false);
 dom.window.close();
});
test('declined run leaves the report button usable without a second run request',async()=>{
 const {dom,w,calls}=await fixture({failRun:true});
 w.document.getElementById('domain').value='example.com';
 w.document.getElementById('setup').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();await settle();
 w.document.getElementById('run').click();await settle();await settle();
 assert.match(w.document.getElementById('error').textContent,/already been used/);
 assert.equal(w.document.getElementById('run').disabled,false);
 assert.equal(calls.filter(([u])=>u.endsWith('/run')).length,1);
 dom.window.close();
});

test('Quick Start generation prioritises provider selection without mandatory education questions',async()=>{
 const qs=list.map(text=>({text,cluster:'discovery',intent:'discovery'}));
 let system;
 const result=await generatePrompts({brand:'Example',domain:'example.com',category:'accountants',market:'Dubai',count:20,quickStart:true},{completeText:async(_,options)=>{system=options.system;return JSON.stringify(qs);}});
 assert.equal(result.length,20);assert.ok(result.every(p=>isProviderDiscovery(p.text)));
 assert.match(system,/at least 80%/);
});
test('Quick Start does not accept an educational question set after failed repair',async()=>{
 const qs=Array.from({length:20},(_,i)=>({text:`How can I learn accounting topic ${i+1}?`,cluster:'education',intent:'problem'}));
 await assert.rejects(generatePrompts({brand:'Example',domain:'example.com',category:'accountants',market:'Dubai',count:20,quickStart:true},{completeText:async()=>JSON.stringify(qs)}),/Buyer-shortlist/);
});

test('software and Arabic product shortlist questions count as provider discovery',()=>{
 for(const question of ['Which SEO gap analysis tools work with Ahrefs data?','Which platforms compare competitor keyword coverage?','Which software suits agencies with several clients?','أي أدوات تحليل فجوات الكلمات المفتاحية تناسب الوكالات؟'])assert.equal(isProviderDiscovery(question),true,question);
});

test('unverified website checks are distinguished from grounded content recommendations',async()=>{
 const {dom,w}=await fixture({used:true,guidedCheck:true});
 assert.match(w.document.getElementById('content').textContent,/Website verification is incomplete/);
 assert.match(w.document.getElementById('content').textContent,/not a confirmed content gap/);
 dom.window.close();
});

test('free new link resumes saved questions without creating or running a project',async()=>{
 const {dom,w,calls}=await fixture({existing:true,newLink:true});
 assert.ok(w.document.getElementById('run'));
 assert.equal(w.location.search,'?site=1');
 assert.equal(calls.some(([u,b])=>u==='/api/projects'&&b),false);
 assert.equal(calls.some(([u])=>u.endsWith('/run')),false);
 dom.window.close();
});
test('re-entering an existing website resumes it before discovery, including case and www',async()=>{
 const {dom,w,calls}=await fixture({existing:true,newLink:true,advanced:true});
 w.document.getElementById('domain').value='https://WWW.Example.com/about';
 w.document.getElementById('setup').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();await settle();
 assert.ok(w.document.getElementById('run'));
 assert.equal(calls.some(([u])=>u==='/api/discover'),false);
 assert.equal(calls.some(([u,b])=>u==='/api/projects'&&b),false);
 dom.window.close();
});
test('a duplicate returned during creation recovers the saved project',async()=>{
 const {dom,w,calls}=await fixture({duplicate:true});
 w.document.getElementById('domain').value='example.com';
 w.document.getElementById('setup').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();await settle();
 assert.ok(w.document.getElementById('run'));
 assert.equal(w.document.getElementById('error').hidden,true);
 assert.equal(calls.some(([u])=>u.endsWith('/run')),false);
 dom.window.close();
});

test('saved report offers a direct PDF link without running another scan',async()=>{
 const {dom,w,calls}=await fixture({used:true});
 const link=w.document.getElementById('download-pdf');
 assert.equal(link.getAttribute('href'),'/api/projects/1/quick-start/report.pdf');
 assert.ok(link.hasAttribute('download'));
 assert.equal(calls.some(([u])=>u.endsWith('/run')),false);dom.window.close();
});


test('wallet and payment app buyer questions pass discovery checks in English and Arabic',()=>{
 for(const q of [
 'Which apps can I use to send money internationally from the UAE?',
 'Which digital wallets support bill payments in Dubai?',
 'Which prepaid cards work for online shopping in the UAE?',
 'Which mobile applications support remittances from Dubai?',
 'أي تطبيقات تدعم إرسال الأموال من الإمارات؟',
 'أي محافظ رقمية تدعم دفع الفواتير في دبي؟',
 'أي بطاقات مسبقة الدفع تناسب التسوق عبر الإنترنت؟'
 ])assert.equal(isProviderDiscovery(q),true,q);
 for(const q of ['How can I send money to the Philippines from Dubai?','What is a digital wallet?','How do I choose a payment app?','كيف أرسل الأموال من الإمارات؟'])assert.equal(isProviderDiscovery(q),false,q);
});
test('Quick Start accepts a full payment-app shortlist without an unnecessary repair',async()=>{
 const needs=['international transfers','local transfers','bill payments','mobile top-ups','online shopping','cashback','QR payments','salary payments','prepaid cards','budget tracking','merchant payments','recurring payments','transaction alerts','low transfer fees','multiple currencies','cash deposits','ATM withdrawals','payment requests','contactless purchases','family remittances'];
 const qs=needs.map(need=>({text:`Which apps support ${need} in the UAE?`,intent:'discovery'}));let calls=0;
 const result=await generatePrompts({brand:'Payit',domain:'payit.ae',category:'digital wallet',market:'UAE',count:20,quickStart:true},{completeText:async()=>{calls++;return JSON.stringify(qs);}});
 assert.equal(result.length,20);assert.equal(calls,1);assert.ok(result.every(p=>isProviderDiscovery(p.text)));
});
test('Quick Start repair explicitly requests provider-selection wording and preserves supported needs',async()=>{
 let calls=0;
 const result=await generatePrompts({brand:'Payit',domain:'payit.ae',category:'digital wallet',market:'UAE',count:20,quickStart:true},{completeText:async prompt=>{
  calls++;if(calls===1)return JSON.stringify(Array.from({length:20},(_,i)=>({text:`How can I learn payment topic ${i+1}?`} )));
  assert.match(prompt,/direct provider or product selection/);assert.match(prompt,/Preserve supported services/);
  return JSON.stringify(list.map(text=>({text})));
 }});
 assert.equal(result.length,20);assert.equal(calls,2);
});
test('progress overlay can be dismissed and reopened without starting another scan',async()=>{
 const {dom,w,calls}=await fixture({used:true,thinking:true});await settle();
 assert.match(w.document.getElementById('scan-stage').textContent,/next actions/);
 assert.equal(w.document.getElementById('download-pdf'),null);
 w.document.getElementById('scan-dismiss').click();assert.equal(w.document.getElementById('scan-overlay'),null);
 w.document.getElementById('scan-reopen').click();assert.ok(w.document.getElementById('scan-overlay'));
 assert.equal(calls.filter(([p])=>p.endsWith('/run')).length,0);dom.window.close();
});
test('completion email is opt-in and saved independently from starting a scan',async()=>{
 const {dom,w,calls}=await fixture({existing:true});await settle();
 const input=w.document.querySelector('#ready-email input');assert.equal(input.checked,false);
 input.checked=true;input.dispatchEvent(new w.Event('change'));await settle();
 assert.deepEqual(calls.find(([p])=>p.endsWith('/preferences'))[1],{emailWhenDone:true});
 assert.equal(calls.filter(([p])=>p.endsWith('/run')).length,0);dom.window.close();
});
test('typed AI question edits require preview then apply and never run a scan',async()=>{
 const {dom,w,calls}=await fixture({existing:true});await settle();const before=w.document.getElementById('q0').value;
 w.document.querySelector('#question-ai textarea').value='Make the first question about small businesses';
 w.document.querySelector('#question-ai button').click();await settle();
 assert.equal(w.document.getElementById('q0').value,before);
 assert.match(w.document.querySelector('.ai-preview').textContent,/small businesses/);
 w.document.querySelector('.ai-preview button').click();
 assert.match(w.document.getElementById('q0').value,/small businesses/);
 assert.equal(calls.filter(([p])=>p.endsWith('/run')||p.endsWith('/questions')).length,0);dom.window.close();
});
test('paid repeat scans require explicit confirmation before saving questions or running',async()=>{
 const {dom,w,calls}=await fixture({used:true,advanced:true});await settle();w.confirm=()=>false;
 w.document.getElementById('edit-report-questions').click();await settle();
 w.document.getElementById('run').click();await settle();
 assert.equal(calls.filter(([p])=>p.endsWith('/run')||p.endsWith('/questions')).length,0);dom.window.close();
});

test('known competitors are saved before the first scan without a separate save step',async()=>{
 const {dom,w,calls}=await fixture({existing:true});await settle();
 assert.match(w.document.getElementById('competitor-editor').textContent,/before scanning/);
 w.document.getElementById('competitor-lines').value='Example agency | exampleagency.com';
 w.document.getElementById('run').click();await settle();await settle();
 const saved=calls.findIndex(([p])=>p.endsWith('/quick-start/competitors')),run=calls.findIndex(([p])=>p.endsWith('/run'));
 assert.ok(saved>=0&&run>saved);assert.deepEqual(calls[saved][1],{competitors:[{name:'Example agency',domain:'exampleagency.com'}]});dom.window.close();
});
test('competitor save failure prevents starting a scan and preserves the editor',async()=>{
 const {dom,w,calls}=await fixture({existing:true,failCompetitors:true});await settle();
 w.document.getElementById('competitor-lines').value='Example agency | invalid';w.document.getElementById('run').click();await settle();
 assert.equal(calls.filter(([p])=>p.endsWith('/run')).length,0);
 assert.equal(w.document.getElementById('competitor-lines').value,'Example agency | invalid');dom.window.close();
});
test('coverage distinguishes measured zero, failed checks, unchecked engines and unsupported Grok',async()=>{
 const {dom,w}=await fixture({used:true,zeroVisibility:true});await settle();
 const text=w.document.getElementById('content').textContent;
 assert.match(text,/ChatGPT.*Named in 0% of 20 measured answers/);
 assert.match(text,/Perplexity.*no measured answers.*20 failed checks/);
 assert.match(text,/Google AI Overviews.*Not checked in this report/);
 assert.match(text,/Claude \(Anthropic\).*Not checked in this report/);
 assert.match(text,/Grok.*Not currently supported/);dom.window.close();
});
test('assistant has a personable Cited identity in both editors',async()=>{
 const {dom,w}=await fixture({existing:true});await settle();
 assert.equal(w.document.querySelector('#question-ai h3').textContent,'Ask Cited');
 assert.equal(w.document.querySelector('#competitor-ai h3').textContent,'Ask Cited');
 assert.match(w.document.querySelector('#question-ai label').textContent,/What would you like to change/);dom.window.close();
});
