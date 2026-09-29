import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {isBuyerQuestion,queryKey,queryLanguage,preservesQueryBasics,containsSearchBrand} from '../src/lib/gsc-query-integrity.js';
const file=readFileSync(new URL('../src/lib/gsc.js',import.meta.url),'utf8');
const source=file.slice(file.indexOf('export async function proposeFromClusters'),file.indexOf('/** Everything the import screen')).replace('export ','');
const group=head=>({head,impressions:10,clicks:0,queries:[{query:head}],variants:1,isQuestion:true});
function harness(output){const h=vm.createContext({SYSTEM:'test',isBuyerQuestion,queryKey,queryLanguage,preservesQueryBasics,containsSearchBrand,complete:async()=>output,parseJsonArray:x=>x});vm.runInContext(source,h);return h;}
test('keyword fragments remain fragments even with punctuation, while natural EN and AR questions pass',()=>{
 for(const text of ['بطاقة ائتمان','بطاقة ائتمان؟','حاسبة القروض','حاسبة القروض؟','loan calculator','loan calculator?','credit card eligibility requirements?','best banks in Jordan?','How?','كيف؟',null,{},'How do I calculate\nmy loan repayment?','How '+ 'x'.repeat(301)])assert.equal(isBuyerQuestion(text),false,JSON.stringify(text));
 for(const text of ['كيف أحسب أقساط القرض؟','كَيْفَ أحسب أقساط القرض؟','هل يمكنني فتح حساب بدون راتب؟','أي البنوك تتيح فتح حساب عبر التطبيق؟','How do I calculate my loan repayments?','Which banks support instant transfers','Can I open an account without a salary?'])assert.equal(isBuyerQuestion(text),true,text);
});
test('actual proposal path discards copied keywords and keeps faithful natural questions',async()=>{
 const h=harness([{index:0,text:'بطاقة ائتمان'},{index:1,text:'loan calculator?'},{index:2,text:'كيف أحسب أقساط القرض؟'}]);
 const result=await h.proposeFromClusters([group('بطاقة ائتمان'),group('loan calculator'),group('حاسبة القروض')]);
 assert.equal(result.length,1);assert.equal(result[0].text,'كيف أحسب أقساط القرض؟');assert.equal(result[0].cluster,'حاسبة القروض');assert.equal(result[0].clicks,0);
});
test('model-unavailable fallback keeps existing questions but cannot promote a keyword classified as commercial',async()=>{
 const h=harness(null);
 const result=await h.proposeFromClusters([group('best savings accounts'),group('loan calculator'),group('كيف أحسب أقساط القرض'),group('How do I calculate loan repayments')]);
 assert.equal(result.length,2);assert.equal(result[0].text,'كيف أحسب أقساط القرض؟');assert.equal(result[1].text,'How do I calculate loan repayments?');
 assert.ok(result.every(x=>x.source==='gsc'));
});
