import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const code=readFileSync(new URL('../src/lib/demand.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/^export /gm,'');
const h=vm.createContext({many:async sql=>sql.includes('SELECT cluster, text')?[{cluster:'seo',text:'SEO audit'}]:[{cluster:'seo',questions:1,measured:10,named:0}]});vm.runInContext(code,h);
function matches(topic,question,query){return h.matchQueries(topic,[{query}],[question]).length===1;}
for(const [label,topic,question,query,want] of [
 ['complete specific topic','ecommerce digital marketing services','What services should I buy?','ecommerce digital marketing services dubai',true],
 ['other location plus agency','agency selection','Best marketing agency in London','London agency',false],
 ['location alone','agency selection','Best digital marketing agencies in Dubai','Dubai weather',false],
 ['generic marketing alone','agency selection','Best digital marketing agencies in Dubai','digital marketing jobs Dubai',false],
 ['question words','pricing','How much does an SEO audit cost?','how much does a car cost',false],
 ['substring collision','seo','SEO services','museum of archaeology',false],
 ['single specific topic','seo','SEO services','technical seo audit',true],
 ['topic phrase','paid search','Who offers paid search campaigns?','paid search campaigns dubai',true],
 ['question subject','platform expertise','Which Dubai agency has the best track record with Google Ads campaigns?','google ads agency dubai',true],
 ['irrelevant Google service','platform expertise','Which Dubai agency has the best track record with Google Ads campaigns?','google maps dubai',false],
 ['ecommerce punctuation','vertical specialization','Best e-commerce paid search campaigns in the UAE','ecommerce paid search agency',true],
 ['short acronym','ai visibility','How do I measure AI visibility?','AI visibility tools',true],
 ['no inferred synonym','search visibility','How do I improve search visibility?','organic rankings',false],
 ['Arabic normalized phrase','تحسين محركات البحث','كيف اختار خدمات تحسين محركات البحث؟','تَحسين محركات البحث دبي',true],
 ['Arabic boilerplate','اختيار وكالة','ما افضل وكالة تسويق في دبي؟','ما افضل مطعم في دبي',false],
 ['generic single topic','pricing','What is the price of SEO services?','pricing furniture',false],
 ['repeated word not two matches','platform expertise','Google Ads campaigns','google google google maps',false],
 ['punctuation does not hide match','technical seo','How do technical SEO audits work?','TECHNICAL/SEO audits',true],
 ['empty query','seo','SEO services','',false],
 ['numeric overlap','industry trends','Digital marketing 2026 trends','2026 holidays',false]
])test(label,()=>assert.equal(matches(topic,question,query),want));
test('does not pool one word each from separate questions',()=>{
 assert.equal(h.matchQueries('agency selection',[{query:'seo ecommerce'}],['SEO audit pricing','ecommerce email services']).length,0);
});
test('unmatched search is null while measured AI zero remains zero',async()=>{
 const [r]=await h.demandByCluster(1,[{query:'Dubai weather',impressions:1000,clicks:10}]);
 assert.equal(r.impressions,null);assert.equal(r.clicks,null);assert.equal(r.rate,0);assert.equal(r.measured,10);assert.equal(r.gap,false);
});
test('matched genuine zero stays zero, a query matching twice counts once per topic',async()=>{
 const [r]=await h.demandByCluster(1,[{query:'SEO audit',impressions:0,clicks:0}]);
 assert.equal(r.impressions,0);assert.equal(r.clicks,0);assert.equal(r.matchedQueries,1);assert.equal(r.measurable,true);
});
test('only matched query evidence contributes to totals',async()=>{
 const [r]=await h.demandByCluster(1,[{query:'SEO audit',impressions:20,clicks:2},{query:'Dubai weather',impressions:9000,clicks:30}]);
 assert.equal(r.impressions,20);assert.equal(r.clicks,2);assert.deepEqual(Array.from(r.queryExamples),['SEO audit']);
});
