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
