import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {isBuyerQuestion,preservesQueryBasics, existingGscQuestion, queryKey, queryLanguage, containsSearchBrand} from '../src/lib/gsc-query-integrity.js';
import {importQuestions} from '../src/lib/gsc.js';
import {sealCandidate} from '../src/lib/search-evidence.js';
const property='sc-domain:bank.example';
const candidate={text:'How can I calculate my loan repayments?',cluster:'loan calculator',querySet:['loan calculator'],examples:['loan calculator'],groupingMethod:'exact-normalized-v1',source:'gsc+model',language:'en',impressions:10,clicks:0,avgPosition:3};
const select=(c=candidate, reviewedText)=>({evidenceToken:sealCandidate(28,c,{property}),reviewedText});
test('observed invented intent is rejected in Arabic and English, while faithful wording remains valid',()=>{
 for(const [source,draft] of [
  ['راتب','ما هي البنوك التي تقدم حسابات راتب في الأردن؟'],
  ['قرض','ما هي شروط الحصول على قرض شخصي في الأردن؟'],
  ['loan calculator','How do I calculate my personal loan repayment?'],
  ['حاسبة القروض','كيف أحسب قسط القرض الشخصي؟'],
  ['قروض على الهوية بدون كفيل','هل توجد قروض على الهوية بدون كفيل في الأردن؟'],
  ['savings account','What is the best savings account?'],
  ['قرض بدون كفيل','كيف أحصل على قرض؟'],
 ]) assert.equal(preservesQueryBasics(source,draft),false,source);
 for(const [source,draft] of [
  ['حاسبة القروض','كيف أحسب أقساط القرض؟'],
  ['loan calculator','How do I calculate my loan repayments?'],
  ['قرض شخصي بدون تحويل راتب وبدون كفيل','كيف أحصل على قرض شخصي بدون تحويل راتب وبدون كفيل؟'],
  ['قرض 1000 دينار بدون كفيل','كيف أحصل على قرض بقيمة 1000 دينار بدون كفيل؟'],
 ]) assert.equal(preservesQueryBasics(source,draft),true,source);
});
test('evidence duplicates ignore new wording but respect property, source, and exact query boundaries',()=>{
 const prior={id:1,text:'An older calculator question?',active:false,source:'gsc+model',origin_details:{property,queryExamples:[' LOAN   calculator?']}};
 assert.equal(existingGscQuestion(candidate,[prior],property)?.id,1);
 assert.equal(existingGscQuestion(candidate,[{...prior,origin_details:{property:'sc-domain:other.example',querySet:['loan calculator']}}],property),undefined);
 assert.equal(existingGscQuestion(candidate,[{...prior,source:'custom'}],property),undefined);
 assert.equal(existingGscQuestion({...candidate,querySet:['personal loan calculator']},[prior],property),undefined);
 assert.equal(existingGscQuestion(candidate,[{text:candidate.text.toUpperCase(),source:'custom'}],property)?.source,'custom');
});
test('proposal filters vague head terms before calling the model and enforces source guards after it',async()=>{
 const file=readFileSync(new URL('../src/lib/gsc.js',import.meta.url),'utf8');
 const source=file.slice(file.indexOf('export async function proposeFromClusters'),file.indexOf('/** Everything the import screen')).replace('export ','');
 let calls=0,request='';
 const h=vm.createContext({isBuyerQuestion,SYSTEM:'test',queryKey,queryLanguage,preservesQueryBasics,containsSearchBrand,complete:async ask=>{calls++;request=ask;return [{index:0,text:'How can I calculate my personal loan repayments?'}];},parseJsonArray:x=>x});
 vm.runInContext(source,h);
 const group=head=>({head,impressions:10,clicks:0,queries:[{query:head}],variants:1});
 assert.equal((await h.proposeFromClusters([group('راتب'),group('قرض')])).length,0);assert.equal(calls,0);
 assert.equal((await h.proposeFromClusters([group('راتب'),group('loan calculator')])).length,0);
 assert.doesNotMatch(request,/راتب/);assert.match(request,/loan calculator/);
});
test('actual database import skips changed-wording duplicates, repeated selections and history',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();let locks=0,releases=0;
 const adapter={connect:async()=>({release(){releases++;},query(sql,args){if(sql.includes('pg_advisory_xact_lock')){locks++;return {rows:[]};}return db.query(sql,args);}})};
 try {
  await db.exec(`CREATE TABLE projects(id int, gsc_site_url text, brand_name text, aliases text[], domain text);
   CREATE TABLE prompts(id serial PRIMARY KEY, project_id int, text text, cluster text, intent text, ai_search_volume int, source text, origin_details jsonb, active boolean DEFAULT true, UNIQUE(project_id,text));`);
  await db.query('INSERT INTO projects VALUES (28,$1,$2,$3,$4)',[property,'Example Bank',[],'bank.example']);
  assert.equal(await importQuestions(28,[select(),select(candidate,'How can I work out my loan repayments?')],adapter),1);
  assert.equal(await importQuestions(28,[select(candidate,'How do I calculate my loan repayments?')],adapter),0);
  await db.exec('UPDATE prompts SET active=false');
  assert.equal(await importQuestions(28,[select(candidate,'How can I estimate my loan repayments?')],adapter),0);
  assert.equal((await db.query('SELECT * FROM prompts')).rows.length,1);
  assert.equal(locks,3);assert.equal(releases,3);
  const other={...candidate,text:'How can I compare savings accounts?',cluster:'savings accounts',querySet:['savings accounts'],examples:['savings accounts']};
  await assert.rejects(importQuestions(28,[select(other),select(other,'How can I compare savings accounts in Jordan?')],adapter));
  assert.equal((await db.query('SELECT * FROM prompts')).rows.length,1);
  assert.equal(releases,4);
 }finally{await db.close();}
});
test('a database failure rolls back earlier inserts and releases the connection',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();let released=false;
 const adapter={connect:async()=>({release(){released=true;},query(sql,args){if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};return db.query(sql,args);}})};
 try {
 await db.exec(`CREATE TABLE projects(id int,gsc_site_url text,brand_name text,aliases text[],domain text);
 CREATE TABLE prompts(id serial,project_id int,text text CHECK(text NOT LIKE '%savings%'),cluster text,intent text,ai_search_volume int,source text,origin_details jsonb,active boolean DEFAULT true,UNIQUE(project_id,text));`);
 await db.query('INSERT INTO projects VALUES(28,$1,$2,$3,$4)',[property,'Example Bank',[],'bank.example']);
 const other={...candidate,text:'How can I compare savings accounts?',cluster:'savings accounts',querySet:['savings accounts'],examples:['savings accounts']};
 await assert.rejects(importQuestions(28,[select(),select(other)],adapter));
 assert.equal((await db.query('SELECT * FROM prompts')).rows.length,0);assert.equal(released,true);
 }finally{await db.close();}
});
