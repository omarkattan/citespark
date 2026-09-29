import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {preservesQueryBasics,containsSearchBrand} from '../src/lib/gsc-query-integrity.js';
const {JSDOM}=await import(process.env.JSDOM_MODULE);
const src=readFileSync(new URL('../src/lib/gsc.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const candidate={text:'كيف أحسب القسط الشهري لقرض 1000 دينار؟',cluster:'قرض 1000 دينار',groupingMethod:'exact-normalized-v1',querySet:['قرض 1000 دينار'],examples:['قرض 1000 دينار'],impressions:100,clicks:0,source:'gsc+model',language:'ar',evidence:{property:'sc-domain:bank.example'}};
function harness(){const inserts=[];const h=vm.createContext({preservesQueryBasics,containsSearchBrand,openCandidate:()=>({...candidate}),one:async(sql,args)=>{if(sql.startsWith('SELECT'))return {gsc_site_url:'sc-domain:bank.example',brand_name:'Bank',aliases:['بنك المثال'],domain:'bank.example'};inserts.push(args);return {id:1};}});vm.runInContext(src.slice(src.indexOf('export async function importQuestions'),src.indexOf('/** Refresh search evidence only.')).replace('export ',''),h);return {h,inserts};}
test('reviewed Arabic wording is stored with original proposal and trusted source data',async()=>{
 const {h,inserts}=harness();const edited='كيف أحسب أقساط قرض بقيمة 1000 دينار؟';await h.importQuestions(28,[{evidenceToken:'sealed',reviewedText:edited,impressions:9999,querySet:['fake']}]);
 assert.equal(inserts[0][1],edited);assert.equal(inserts[0][4],100);const origin=JSON.parse(inserts[0][6]);assert.equal(origin.proposedText,candidate.text);assert.equal(origin.importedText,edited);assert.equal(origin.wordingEdited,true);assert.deepEqual(origin.querySet,candidate.querySet);assert.equal(origin.gscSnapshot.clicks,0);
});
test('invalid edits reject the entire selection before any insert',async()=>{
 for(const text of ['','short','س'.repeat(301),'How do I repay a 1000 dinar loan?','كيف أحسب أقساط قرض بقيمة 2000 دينار؟','كيف أحصل على قرض 1000 دينار من بنك المثال؟']){
 const {h,inserts}=harness();await assert.rejects(h.importQuestions(28,[{evidenceToken:'ok'},{evidenceToken:'ok',reviewedText:text}]));assert.equal(inserts.length,0);
 }
});
test('an app query cannot acquire an invented banking identity',()=>{
 assert.equal(preservesQueryBasics('تفعيل تطبيق سند','كيف أفعل تطبيق سند البنكي على هاتفي؟'),false);
 assert.equal(preservesQueryBasics('تفعيل تطبيق سند','كيف أفعّل تطبيق سند؟'),true);
 assert.equal(preservesQueryBasics('activate Sanad app','How do I activate the Sanad banking app?'),false);
 assert.equal(preservesQueryBasics('تفعيل تطبيق بنكي','كيف أفعّل التطبيق البنكي؟'),true);
});
test('candidate review keeps original query visible, provides editable RTL-safe text and escapes markup',()=>{
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const h=vm.createContext({esc});const start=app.indexOf('function gscCandidateRow');vm.runInContext(app.slice(start,app.indexOf('/**',start)),h);
 const doc=new JSDOM(h.gscCandidateRow({...candidate,examples:['<img src=x>'],variants:1},0)).window.document;
 assert.equal(doc.querySelector('textarea').value,candidate.text);assert.equal(doc.querySelector('textarea').dir,'auto');assert.equal(doc.querySelector('[data-gsc]').checked,false);assert.equal(doc.querySelector('img'),null);assert.match(doc.body.textContent,/<img src=x>/);
});
