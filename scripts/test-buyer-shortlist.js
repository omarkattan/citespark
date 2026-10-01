import {test} from 'node:test';
import assert from 'node:assert/strict';
import {questionRole,reviewShortlist} from '../src/lib/search-evidence.js';
const buyer=[
 'Which wealth managers in Saudi Arabia offer access to international private market deals',
 'Who are the top investment advisors for UHNW clients in Saudi Arabia and UAE',
 'What are the minimum asset requirements for professional wealth management services in Riyadh',
 'Which bank offers a savings account in Jordan?',
 'How do I open a bank account in Jordan?',
 'What are the fees for a credit card?',
 'Am I eligible for a mortgage?',
 'ما أفضل البنوك لفتح حساب توفير في الأردن؟',
 'كيف أفتح حسابا بنكيا في الأردن؟',
 'ما رسوم البطاقة الائتمانية؟',
 'ما شروط الحصول على قرض سكني؟',
 'أي بنك يقدم أقل رسوم تحويل؟',
 'كيف أختار مدير الثروات؟'
];
const topic=[
 'What are the best asset allocation strategies for moderate risk investors?',
 'What is the difference between asset management and wealth management?',
 'What is a savings account?',
 'What is a family office?',
 'What is the minimum sample size?',
 'What are the best ways to save money?',
 'ما أفضل طرق الادخار؟',
 'ما هو حساب التوفير؟',
 'ما الفرق بين العائد المرجح بالوقت ومعدل العائد الداخلي؟'
];
test('recognises English and Arabic provider and product decisions without best-word shortcuts',()=>{
 for(const text of buyer)assert.equal(questionRole(text),'Buyer decision',text);
 for(const text of topic)assert.equal(questionRole(text),'Topic to qualify',text);
});
const q=(id,text,cited=0,named=0)=>({id,text,cited,named,measured:5,engines:['chatgpt','claude'],failed:1,missing:0});
test('TFO strongest relevant evidence is included and a review slot is retained for absence',()=>{
 const questions=[q(1,buyer[1],1,2),q(2,'Best wealth management solutions for Saudi business owners',2,1),q(3,buyer[0],5,4),q(4,'Best wealth management firms in Saudi Arabia'),q(5,topic[0],5,5)];
 const before=JSON.stringify(questions);const list=reviewShortlist(questions);
 assert.deepEqual(list.map(x=>x.id),[3,4,2]);assert.equal(JSON.stringify(questions),before);
 assert.equal(list[1].failed,1);assert.equal(list[1].measured,5);
});
test('unmeasured questions remain unknown and do not displace measured review candidates',()=>{
 const list=reviewShortlist([{...q(1,buyer[0]),measured:0,cited:0,named:0},q(2,buyer[1]),q(3,buyer[2],2,1)]);
 assert.deepEqual(list.map(x=>x.id),[3,2,1]);assert.equal(list[2].measured,0);
 assert.deepEqual(reviewShortlist([]),[]);
});


test('property buying and comparison questions work in English and Arabic',()=>{
 const decisions=[
  'Which developers offer competitive payment plans for homes in Sharjah?',
  'What should I check before buying an apartment directly from a developer in the UAE?',
  'Which residential communities in Sharjah are best suited to families?',
  'Which branded residential developments in Dubai should buyers compare?',
  'How can buyers compare the handover track records of residential developers in the UAE?',
  'What villas are available in Masaar?',
  'ما الخيارات المتاحة للاستثمار العقاري السكني في دبي والشارقة، وما الفروق بينها؟',
  'ما المشاريع التي توفر شققاً للبيع مباشرة من المطور في الشارقة؟',
  'ما المشاريع السكنية في دبي التي توفر فللاً بحدائق خاصة؟',
  'ما أفضل المجمعات السكنية للعائلات في الشارقة؟',
  'ما المطورون الذين يقدمون خطط سداد مرنة لشراء عقار سكني في الإمارات؟',
  'كيف تختلف المجمعات السكنية المتكاملة في دبي عن نظيراتها في الشارقة؟',
  'ما المقصود بالمساكن ذات العلامات التجارية، وهل تستحق تكلفتها الإضافية؟'
 ];
 for(const text of decisions)assert.equal(questionRole(text),'Buyer decision',text);
 for(const text of ['What is Aljada in Sharjah?','What is a residential community?',
  'What is property management?','What is the history of villas?',
  'What are the best ways to save energy?',
  'ما هي الجادة في الشارقة؟','ما هو الاستثمار العقاري؟','ما معنى المطور العقاري؟'])
  assert.equal(questionRole(text),'Topic to qualify',text);
});
test('property shortlist includes supported strength and missing presence without changing evidence',()=>{
 const rows=[q(1,'Which developers offer payment plans for homes in Sharjah?',1,6),
  q(2,'Which branded residential developments should buyers compare?'),
  q(3,'What is Aljada?',6,6)];
 const original=JSON.stringify(rows);
 assert.deepEqual(reviewShortlist(rows).map(x=>x.id),[1,2]);
 assert.equal(JSON.stringify(rows),original);
});
