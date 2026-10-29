import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE);
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const settle=()=>new Promise(r=>setImmediate(r));
const plan={version:1,cycle:'2026-10-29T00:00:00.000Z',title:'Explain the routine price',question:'How much should skincare cost?',mode:'improve',page:'https://skincycles.com/products/serum',page_status:'inspected',rationale:'Help buyers see what the price includes.',change:'Add the approved pack size and usage calculation beside the current price.',suggested_questions:['What is included in the serum price?'],completion:'Check the figures and record the URL.',follow_up:'Repeat the same question and settings later.',evidence:{answer_id:100,answer_url:'/api/projects/39/measurements/60#run-100',observation:'One saved answer did not name the brand.',answer_quote:'The best choice depends on price and needs.',page_quote:'Pack size 30 ml. Use two drops.',page_read_at:'2026-10-29T00:00:00.000Z'}};
async function appFixture(decision={}){
 const dom=new JSDOM(read('../src/public/index.html'),{url:'https://cited.test/app?site=39',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,requests=[];
 w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
 const project={id:39,name:'SkinCycles',brand_name:'SkinCycles',domain:'skincycles.com',market:'GB',engines:['chatgpt']};
 const task={id:99,type:'content_gap',status:'open',title:'Review first answer',evidence:{prompt_id:1,prompt:plan.question,runs:1,own_rate:0,action_plan:plan},review_decision:decision};
 w.fetch=async(path,options={})=>{requests.push({path,method:options.method||'GET',body:options.body});let data;
 if(path==='/api/me')data={signedIn:true,userId:7,emailVerified:true};else if(path==='/api/projects')data=[project];else if(path==='/api/billing')data=null;
 else if(path.endsWith('/overview'))data={project,cycle:'2026-10-29',runs:1,engines:[]};else if(path.endsWith('/setup-progress'))data={step:'recommendations'};
 else if(path.endsWith('/run-scope'))data={all:1,unrun:0,checksAll:1,checksUnrun:0,costAll:.03,costUnrun:0};else if(path.endsWith('/cycle-status'))data={phase:'idle'};
 else if(path.includes('/recommendations?'))data={tasks:[task],counts:{open:1,doing:0,done:0,dismissed:0,total:1},people:[]};
 else if(path.endsWith('/review-decision'))data={...JSON.parse(options.body),reviewed_at:'2026-10-29'};
 else if(path.endsWith('/report-note-preview'))data={current:null,proposed:{title:plan.title,notes:plan.change},canInclude:true,version:'v1'};
 else throw Error('Unexpected request '+path);return {ok:true,status:200,json:async()=>data};};
 w.eval(read('../src/public/countries.js'));w.eval(read('../src/public/app.js'));
 for(let i=0;i<25&&!w.document.querySelector('[data-use-action-plan]');i++)await settle();
 return {dom,w,requests,task};
}
test('first results show concrete actions before the collapsed evidence queue, with no extra requests',async()=>{
 const f=await appFixture(),d=f.w.document;assert.match(d.querySelector('.action-plan h3').textContent,/Explain the routine price/);assert.ok(d.querySelector('.plan-page a').href.endsWith('/products/serum'));assert.equal(d.querySelector('#opportunityQueue').closest('details').open,false);assert.ok(f.requests.every(r=>r.method==='GET'));f.dom.window.close();
});
test('completion leads with the next actions and keeps measurement detail available without covering them',async()=>{
 const f=await appFixture(),d=f.w.document;
 f.w.showReport({visibility:0,measuredAnswers:1,openActions:1,recommendations:1,spend:.05,billable:1,topActions:[{title:'Old generic guidance'}]});
 assert.equal(d.querySelector('#cycleReport h2').textContent,'Your actions are ready');assert.equal(d.querySelector('#cycleReport details').open,false);assert.equal(d.querySelector('#cycleReport [data-report-goto=actions]').textContent,'Review my next actions');assert.doesNotMatch(d.getElementById('cycleReport').textContent,/Old generic guidance/);f.dom.window.close();
});
test('one click fills a complete editable action, saving still requires explicit report preview',async()=>{
 const f=await appFixture(),d=f.w.document;d.querySelector('[data-use-action-plan]').click();await settle();
 assert.equal(d.getElementById('decision-page-99').value,plan.page);assert.match(d.getElementById('decision-change-99').value,/approved pack size/);assert.match(d.getElementById('decision-evidence-99').value,/measurements\/60#run-100/);assert.equal(d.getElementById('decision-stage-99').value,'investigate');assert.equal(d.activeElement.id,'decision-stage-99');assert.equal(d.querySelector('#opportunityQueue').closest('details').open,true);assert.ok(f.requests.every(r=>r.method==='GET'));
 d.querySelector('[data-decision-save]').click();for(let i=0;i<15&&!d.querySelector('[data-decision-feedback] [data-report-preview]');i++)await settle();
 const save=f.requests.find(r=>r.method==='PUT');assert.ok(save);assert.equal(JSON.parse(save.body).page,plan.page);assert.ok(!f.requests.some(r=>r.path.endsWith('/report-note')&&r.method==='POST'));
 d.querySelector('[data-decision-feedback] [data-report-preview]').click();for(let i=0;i<15&&!d.querySelector('[data-report-note]');i++)await settle();assert.match(d.querySelector('[data-report-note]').textContent,/Include in client report/);f.dom.window.close();
});
test('opening a suggestion preserves unsaved typing',async()=>{
 const f=await appFixture(),d=f.w.document;d.getElementById('decision-change-99').value='My own unsubmitted action.';d.querySelector('[data-use-action-plan]').click();await settle();assert.equal(d.getElementById('decision-change-99').value,'My own unsubmitted action.');assert.ok(f.requests.every(r=>r.method==='GET'));f.dom.window.close();
});
test('existing human decisions take precedence over generated drafts',async()=>{
 const f=await appFixture({stage:'ready',title:'Approved page update',page:'https://skincycles.com/approved',change:'Use the approved price explanation.',evidence:'Confirmed by the product owner.',reviewed_at:'2026-10-29'}),d=f.w.document;
 assert.equal(d.querySelector('.action-plan h3').textContent,'Approved page update');d.querySelector('[data-use-action-plan]').click();await settle();assert.equal(d.getElementById('decision-change-99').value,'Use the approved price explanation.');assert.equal(d.getElementById('decision-stage-99').value,'ready');f.dom.window.close();
});
function loginFixture(fetch){const dom=new JSDOM(read('../src/public/login.html'),{url:'https://cited.test/login?signup=1',runScripts:'outside-only'});dom.window.fetch=fetch;dom.window.eval(read('../src/public/login.js'));return dom;}
test('signup has clear password requirements and reveal does not submit',()=>{
 let requests=0;const dom=loginFixture(async()=>{requests++;});const d=dom.window.document;assert.equal(d.getElementById('password').autocomplete,'new-password');assert.equal(d.getElementById('password').minLength,8);assert.equal(d.getElementById('passwordHint').hidden,false);
 d.getElementById('showPassword').click();assert.equal(d.getElementById('password').type,'text');assert.equal(requests,0);d.getElementById('toggle').click();assert.equal(d.getElementById('password').autocomplete,'current-password');assert.equal(d.getElementById('password').hasAttribute('minlength'),false);dom.window.close();
});
test('signup blocks duplicate submission, preserves details on failure, and supports retry',async()=>{
 let requests=0,respond;const dom=loginFixture(()=>{requests++;return new Promise(r=>respond=r);}),d=dom.window.document;
 d.getElementById('email').value='tester@example.org';d.getElementById('password').value='example-only-password';d.getElementById('orgName').value='Example brand';
 d.getElementById('submit').click();d.getElementById('panel').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));assert.equal(requests,1);
 respond({ok:false,json:async()=>({error:'Temporary error'})});await settle();assert.equal(d.getElementById('submit').disabled,false);assert.equal(d.getElementById('orgName').value,'Example brand');assert.match(d.getElementById('error').textContent,/Temporary error/);
 d.getElementById('submit').click();assert.equal(requests,2);respond({ok:true,json:async()=>({verificationSent:true})});await settle();assert.match(d.getElementById('panel').textContent,/Next: add your website/);d.getElementById('panel').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));assert.equal(requests,2);dom.window.close();
});
test('verification resend errors remain retryable and never claim success',async()=>{
 let calls=0;const dom=loginFixture(async()=>++calls===1?{ok:true,json:async()=>({verificationSent:true})}:{ok:false,json:async()=>({error:'Please retry later'})}),d=dom.window.document;
 d.getElementById('email').value='tester@example.org';d.getElementById('password').value='example-only-password';d.getElementById('submit').click();await settle();d.getElementById('resend').click();await settle();assert.equal(d.getElementById('resend').disabled,false);assert.equal(d.getElementById('resendMsg').textContent,'Please retry later');dom.window.close();
});
