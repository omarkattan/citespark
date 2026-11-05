import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePrompts,baselineCoverage,isProviderDiscovery} from '../src/lib/prompts.js';

const config={brand:'Lezof',domain:'lezof.ae',category:'tyres, oil changes and wheel alignment',market:'Dubai',qualifier:'car owners',count:10};
const english=[
 'Which garages offer wheel alignment in Dubai?',
 'Which shops offer tyre fitting in Dubai?',
 'Which garages offer oil changes in Dubai?',
 'Which centres offer tyres in Dubai?',
 'Which companies offer tyre fitting in Dubai?',
 'Who are the best tyre shops in Dubai?',
 'Where can I buy tyres in Dubai?',
 'What is included in a wheel alignment service?',
 'When should I replace my tyres?',
 'Why should I choose premium tyres?',
 'How can I choose the right tyre size?',
 'How much does wheel alignment cost in Dubai?'
];
const arabic=[
 'من يقدم أفضل خدمات تغيير الإطارات في دبي؟',
 'أي مراكز تقدم خدمة ضبط زوايا العجلات في دبي؟',
 'أين أشتري إطارات جديدة في دبي؟',
 'أي ورش تقدم خدمة تغيير الزيت في دبي؟',
 'أي شركات توفر الإطارات في دبي؟',
 'ما الذي تتضمنه خدمة ضبط زوايا العجلات؟',
 'متى يجب تغيير إطارات السيارة؟',
 'لماذا أختار الإطارات الممتازة؟',
 'كيف أختار مقاس الإطار المناسب؟',
 'كم تكلفة تغيير زيت السيارة في دبي؟'
];
const json=items=>JSON.stringify(items.map(text=>({text,cluster:'car-care',intent:'commercial'})));
for(const [language,items] of [['en',english],['ar',arabic]])test(`${language}: returned baseline keeps every buyer need and at least half discovery`,async()=>{
 let calls=0;
 const output=await generatePrompts({...config,language},{completeText:async()=>{calls++;return json(items);}});
 const coverage=baselineCoverage(output,10);
 assert.equal(output.length,10);assert.deepEqual(coverage.missing,[]);assert.equal(coverage.complete,true);
 assert.ok(output.slice(0,5).every(p=>isProviderDiscovery(p.text)));
 assert.ok(output.every(p=>p.ai_search_volume===null));assert.ok(calls<=2);
});
test('missing needs trigger only one repair and partial results remain explicit',async()=>{
 let calls=0;
 const output=await generatePrompts(config,{completeText:async(prompt)=>{calls++;if(calls===2)assert.match(prompt,/Missing buyer needs:.*when it is needed/);return json(english.slice(0,2));}});
 assert.equal(calls,2);assert.equal(output.length,2);assert.equal(baselineCoverage(output,10).complete,false);
 assert.ok(baselineCoverage(output,10).missing.includes('best providers/products'));
});
test('repair fills missing questions without retaining duplicate or branded suggestions',async()=>{
 let calls=0;
 const output=await generatePrompts(config,{completeText:async()=>json(++calls===1?[...english.slice(0,2),'Who recommends Lezof for tyres?']:english)});
 assert.equal(calls,2);assert.equal(baselineCoverage(output,10).complete,true);
 assert.equal(new Set(output.map(p=>p.text)).size,10);assert.ok(output.every(p=>!p.text.includes('Lezof')));
});
test('a failed repair does not discard usable suggestions or claim complete coverage',async()=>{
 let calls=0;
 const output=await generatePrompts(config,{completeText:async()=>{if(++calls===2)throw Error('Unavailable');return json(english.slice(0,2));}});
 assert.equal(output.length,2);assert.equal(baselineCoverage(output,10).complete,false);
});
test('general advice using best is not counted as provider discovery',()=>{
 assert.equal(isProviderDiscovery('How can I choose the best tyres?'),false);
 assert.equal(isProviderDiscovery('كيف أختار أفضل إطارات للسيارة؟'),false);
 assert.equal(isProviderDiscovery('Who are the best tyre shops in Dubai?'),true);
});
test('provider and price adjectives do not claim service scope or actual cost coverage',()=>{
 for(const text of [
  'What are the best car service centres in Dubai?',
  'Which garages offer competitive prices in Dubai?',
  'ما هي أفضل ورش صيانة السيارات في دبي وأبوظبي؟',
  'من يقدم خدمات صيانة السيارات الشاملة بأسعار تنافسية في دبي؟',
  'أين أقارن أنواع الإطارات المختلفة وأسعارها قبل الشراء؟'
 ]) {
  const coverage=baselineCoverage([{text}],20);
  assert.ok(coverage.missing.includes('what is included'),text);
  assert.ok(coverage.missing.includes('cost/budget'),text);
 }
 for(const text of ['What does a full car service include?','ما الذي تشمله خدمة صيانة السيارة؟','ماذا تتضمن خدمة فحص السيارة؟']) {
  assert.ok(baselineCoverage([{text}],20).covered.includes('what is included'),text);
 }
 for(const text of ['How much should I expect to pay for tyre fitting?','What is the price of wheel alignment?','كم تبلغ تكلفة صيانة السيارة؟','ما هي تكلفة ضبط زوايا العجلات؟']) {
  assert.ok(baselineCoverage([{text}],20).covered.includes('cost/budget'),text);
 }
});
test('Arabic repair explicitly fills scope and cost gaps before claiming complete coverage',async()=>{
 let calls=0;
 const initial=arabic.map(t=>t.startsWith('ما الذي')?'ما هي أفضل ورش صيانة السيارات في دبي؟':t.startsWith('كم تكلفة')?'من يقدم خدمات صيانة السيارات بأسعار تنافسية في دبي؟':t);
 const output=await generatePrompts({...config,language:'ar'},{completeText:async(prompt)=>{
  if(++calls===1)return json(initial);
  assert.match(prompt,/Missing buyer needs: what is included, cost\/budget/);
  return json(['ما الذي تشمله خدمة صيانة السيارة؟','كم تبلغ تكلفة صيانة السيارة؟']);
 }});
 assert.equal(calls,2);
 assert.equal(baselineCoverage(output,10).complete,true);
 assert.ok(output.some(p=>p.text==='كم تبلغ تكلفة صيانة السيارة؟'));
 assert.ok(output.some(p=>p.text==='ما الذي تشمله خدمة صيانة السيارة؟'));
});
