import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness(data={runs:[]}) {
 const document=new JSDOM('<article class="rec"><button data-see-answer="7">Read the answers</button><div data-answers hidden></div></article>').window.document;
 const calls=[];const h=vm.createContext({document,esc,URL,state:{overview:{project:{market:'AE'}}},window:{COUNTRIES:[['AE','United Arab Emirates']]},ENGINE_LABEL:{chatgpt:'ChatGPT'},api:async url=>{calls.push(url);return data;}});
 vm.runInContext(app.slice(app.indexOf('function answerUrl'),app.indexOf('/* ---------- views ---------- */')),h);
 vm.runInContext('async function openAnswers(e) {'+app.slice(app.indexOf("  const see = e.target.closest('[data-see-answer]');"),app.indexOf('  // Selecting only what is on screen'))+'}',h);
 return {h,document,calls,open:()=>h.openAnswers({target:document.querySelector('button')})};
}
test('formats headings, emphasis, lists, code and safe links without altering stored text',async()=>{
 const text='# Heading\n\n**Important** and `code`\n\n- First\n- Second\n\n3. Third\n\n[Source](https://example.com/page)';
 const {document,open}=harness({runs:[{engine:'chatgpt',measured:true,mentioned:false,response_text:text}]});await open();
 assert.equal(document.querySelector('.formatted-answer h4').textContent,'Heading');assert.equal(document.querySelector('strong').textContent,'Important');assert.equal(document.querySelectorAll('ul li').length,2);assert.equal(document.querySelector('ol li').value,3);
 assert.equal(document.querySelector('.answer-original pre').textContent,text);assert.equal(document.querySelector('a').getAttribute('href'),'https://example.com/page');
});
test('six engines start collapsed with verdict, model, sample, truncation and sources visible in summaries',async()=>{
 const runs=Array.from({length:6},(_,i)=>({engine:'engine'+i,model:'model'+i,measured:i!==0,mentioned:i===1,truncated:i===2,sample:1,samples:2,response_text:'Answer',citations:[{domain:'example.com'}]}));
 const {document,open}=harness({runs});await open();assert.equal(document.querySelectorAll('.answer-reader').length,6);assert.equal(document.querySelectorAll('.answer-reader[open]').length,0);
 const heads=[...document.querySelectorAll('.ans-head')].map(x=>x.textContent);assert.match(heads[0],/not measured/);assert.match(heads[1],/named/);assert.match(heads[2],/not named/);assert.match(heads[2],/cut short/);assert.match(heads[0],/sample 1 of 2/);assert.match(heads[0],/1 source recorded/);
});
test('answer text and citation links cannot inject HTML or executable URLs',async()=>{
 const text='<img src=x onerror=alert(1)>\n\n[Bad](javascript:alert) [Good](https://example.com/?q="bad")\n\n```html\n<script>alert(1)</script>\n```';
 const {document,open}=harness({runs:[{response_text:text,citations:[{url:'javascript:alert(1)'},{url:'https://example.com/path?a=1&b=2'},{domain:'missing.test'}]}]});await open();
 assert.equal(document.querySelectorAll('script,img,[onerror]').length,0);assert.equal(document.querySelectorAll('a[href^="javascript:"]').length,0);assert.equal(document.querySelector('.answer-original pre').textContent,text);
 assert.match(document.querySelector('.ans-sources').textContent,/link unavailable/);assert.match(document.querySelector('.ans-sources').textContent,/address not recorded/);
});
test('empty results and failed requests remain explicit',async()=>{
 for(const [data,expected] of [[{runs:[]},/Nothing stored/],[{error:'Unavailable'},/Unavailable/],[null,/could not be loaded/]]){
  const {document,open}=harness(data);await open();assert.match(document.querySelector('[data-answers]').textContent,expected);
 }
});
test('closing and reopening uses only the stored-answer endpoint',async()=>{
 const {document,open,calls}=harness({runs:[{response_text:'Answer',measured:true}]});await open();await open();assert.equal(document.querySelector('[data-answers]').hidden,true);await open();assert.deepEqual(calls,['/api/prompts/7/answers','/api/prompts/7/answers']);
});
test('Arabic, unsupported Markdown and unfinished code retain a complete original view',async()=>{
 const text='## سؤال عربي\n\n| Column | Value |\n| --- | --- |\n| A | B |\n\n```\nunfinished <code>';
 const {document,open}=harness({runs:[{response_text:text}]});await open();assert.equal(document.querySelector('.answer-original pre').textContent,text);assert.match(document.querySelector('.formatted-answer').textContent,/سؤال عربي/);assert.match(document.querySelector('.formatted-answer').textContent,/unfinished <code>/);
});
test('failed engine response shows its error inside an unmeasured row',async()=>{
 const {document,open}=harness({runs:[{engine:'chatgpt',measured:false,error:'Provider failed',response_text:null}]});await open();assert.match(document.querySelector('.ans-head').textContent,/not measured/);assert.match(document.querySelector('.answer-content').textContent,/Provider failed/);assert.equal(document.querySelector('.answer-original'),null);
});
