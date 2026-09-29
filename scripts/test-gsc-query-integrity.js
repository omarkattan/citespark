import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {cluster} from '../src/lib/gsc.js';
import {isBuyerQuestion,queryKey,containsSearchBrand,queryLanguage,preservesQueryBasics} from '../src/lib/gsc-query-integrity.js';
const row=(query,impressions=100,clicks=2)=>({query,impressions,clicks,position:4});
test('observed bank query collisions stay separate, including qualifiers and Arabic amounts',()=>{
 const queries=['western union jordan','best bank in jordan','union bank','bank account','open bank account online','bank account number','personal loan','home loan interest rates','قرض 1000 دينار بدون كفيل','قرض حسن 1000 دينار','قرض 3000 دينار بدون كفيل','قرض بدون كفيل','قرض بكفيل'];
 const groups=cluster(queries.map(q=>row(q)));
 assert.equal(groups.length,queries.length);assert.ok(groups.every(g=>g.variants===1 && g.impressions===100));
 assert.equal(groups.reduce((n,g)=>n+g.clicks,0),26);
});
test('case and whitespace variants combine without losing source text, clicks or zero',()=>{
 const groups=cluster([row(' Credit   CARD ',40,0),row('credit card?',60,0)]);
 assert.equal(groups.length,1);assert.equal(groups[0].impressions,100);assert.equal(groups[0].clicks,0);assert.equal(groups[0].queries.length,2);
 assert.equal(queryKey('قرض 1000 دينار؟'),'قرض 1000 دينار');
});
test('Arabic, English and domain own-brand names are excluded only at name boundaries',()=>{
 const options={brand:'Bank al Etihad',aliases:['بنك الاتحاد'],domain:'bankaletihad.com'};
 const groups=cluster(['ATM بنك الاتحاد','Bank al Etihad login','bankaletihad.com accounts','أفضل بنك في الأردن','bank al Etihadi'].map(q=>row(q)),options);
 assert.deepEqual(groups.map(g=>g.head),['أفضل بنك في الأردن','bank al Etihadi']);
 assert.equal(containsSearchBrand('unrelated',['']),false);
});
test('rewrites cannot translate Arabic into English or change an amount',()=>{
 assert.equal(queryLanguage('كيف أفتح حساب بنك؟'),'ar');
 assert.equal(preservesQueryBasics('قرض 1000 دينار','كيف أحصل على قرض ١٠٠٠ دينار؟'),true);
 assert.equal(preservesQueryBasics('قرض 1000 دينار','How can I get a 1000 dinar loan?'),false);
 assert.equal(preservesQueryBasics('قرض 1000 دينار','كيف أحصل على قرض 3000 دينار؟'),false);
 assert.equal(preservesQueryBasics('credit card','Which card has a 100 dinar fee?'),false);
});
test('actual proposal path enforces language, amounts, own-brand exclusion and explicit model omissions',async()=>{
 const file=readFileSync(new URL('../src/lib/gsc.js',import.meta.url),'utf8');
 const src=file.slice(file.indexOf('export async function proposeFromClusters'),file.indexOf('/** Everything the import screen')).replace('export ','');
 const outputs=[{index:0,text:'How can I get a 1000 dinar loan?'},{index:1,text:'Which card offers Bank al Etihad rewards?'},{index:2,text:'كيف أفتح حساب توفير؟'}];
 let request='';
 const h=vm.createContext({isBuyerQuestion,SYSTEM:'system',queryKey,queryLanguage,preservesQueryBasics,containsSearchBrand,complete:async ask=>{request=ask;return outputs;},parseJsonArray:x=>x});vm.runInContext(src,h);
 const groups=cluster([row('قرض 1000 دينار',300),row('credit card',200),row('كيف أفتح حساب توفير',100),row('Which banks offer accounts?',50)]);
 const proposed=await h.proposeFromClusters(groups,{brand:'Bank al Etihad',category:'Personal banking',qualifier:'Individuals in Jordan',market:'JO'});
 assert.equal(proposed.length,1);assert.equal(proposed[0].language,'ar');assert.equal(proposed[0].impressions,100);assert.match(request,/Business scope: Personal banking/);assert.match(request,/Customer brief: Individuals in Jordan/);
});
test('actual preview renders suggestions unchecked and escapes original queries',()=>{
 const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
 const start=app.indexOf('function gscCandidateRow(');assert.ok(start>=0);
 const h=vm.createContext({esc:s=>String(s).replace(/</g,'&lt;')});vm.runInContext(app.slice(start,app.indexOf('/**',start)),h);
 const html=h.gscCandidateRow({text:'Which card?',examples:['<img>'],cluster:'cards',impressions:10,clicks:0,avgPosition:4,variants:1,source:'gsc+model'},0);
 assert.doesNotMatch(html,/\bchecked\b/);assert.match(html,/&lt;img>/);
});
