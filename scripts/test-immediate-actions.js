import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownPageUrl,publicAddress,pageFromHtml,readOwnPage,readActionPages} from '../src/lib/action-pages.js';
import {buyingIntent,selectActionCandidates,fallbackActionPlan,validatedActionPlan,prepareActionPlans} from '../src/lib/immediate-actions.js';
const project={id:39,brand_name:'SkinCycles',name:'SkinCycles',domain:'skincycles.com',market:'GB',category:'skincare'};
const cycle='2026-10-29T00:00:00.000Z';
const rec=(id,q)=>({type:'content_gap',action:'One measured answer did not name the brand.',evidence:{prompt_id:id,prompt:q,runs:1,own_rate:0}});
const answers=[{id:100,prompt_id:1,measurement_id:60,engine:'chatgpt',mentioned:false,response_text:'The best choice depends on the ingredients, price and your personal needs.'}];
const pages=[{id:'page-1',url:'https://skincycles.com/products/serum',title:'SkinCycles serum',text:'SkinCycles serum. Pack size 30 ml. Use two drops every evening. The price is shown at checkout.',read_at:cycle}];
const valid={prompt_id:1,title:'Explain the total routine cost',mode:'improve',page_id:'page-1',page_excerpt_id:'page-1-1',page_quote:'Pack size 30 ml. Use two drops every evening.',answer_id:100,answer_excerpt_id:'answer-100-1',answer_quote:'The best choice depends on the ingredients, price and your personal needs.',rationale:'Help buyers compare the pack size and stated usage before choosing.',change:'Beside the price, explain what is included and how the stated usage relates to the pack size. Ask the product owner to approve the calculation before publishing.',suggested_questions:['What is included in the SkinCycles serum price?'],completion:'Record the approved facts and the updated page URL.'};
test('chooses distinct buying needs before informational questions without using estimated volume',()=>{
 const recs=[rec(1,'How do I reduce pigmentation?'),rec(2,'What does a skincare routine cost?'),rec(3,'Which skincare brand is best?'),rec(4,'How do these serums compare?')];
 const a=recs.map(r=>({prompt_id:r.evidence.prompt_id}));assert.deepEqual(selectActionCandidates(recs,a).map(r=>r.evidence.prompt_id),[2,3,4]);assert.equal(buyingIntent('ما تكلفة الروتين؟').kind,'pricing');
});
test('attaches a grounded edit with exact supplied page and answer evidence',async()=>{
 const out=await prepareActionPlans(project,[rec(1,'How much should skincare cost?')],answers,{cycle,pages,generate:async()=>JSON.stringify([valid])});
 const p=out[0].evidence.action_plan;assert.equal(p.generation,'page-grounded');assert.equal(p.page,pages[0].url);assert.equal(p.evidence.answer_id,100);assert.equal(p.evidence.page_quote,pages[0].text);assert.equal(p.mode,'improve');assert.equal(out[0].review_decision,undefined);
});
test('fabricated quotes, page IDs, answer IDs and promised outcomes are rejected',()=>{
 const fallback=fallbackActionPlan(project,rec(1,'How much should skincare cost?'),answers[0],pages,{cycle});
 for(const bad of [{page_quote:'This page has no prices.'},{page_id:'invented'},{answer_id:999},{answer_quote:'Not in the answer at all'},{change:'This content will increase your visibility immediately and produce qualified leads.'}])assert.equal(validatedActionPlan({...valid,...bad},fallback,answers[0],pages),fallback);
});
test('quote validation accepts whitespace formatting differences while keeping the same words',()=>{
 const fallback=fallbackActionPlan(project,rec(1,'How much should skincare cost?'),answers[0],pages,{cycle});
 const p=validatedActionPlan({...valid,answer_quote:valid.answer_quote.replace('depends on','depends\n on')},fallback,answers[0],pages);assert.equal(p.generation,'page-grounded');
});
test('unknown excerpt references cannot create supporting evidence',async()=>{
 const out=await prepareActionPlans(project,[rec(1,'How much should skincare cost?')],answers,{cycle,pages,generate:async()=>JSON.stringify([{...valid,page_excerpt_id:'not-supplied',page_quote:pages[0].text}])});
 assert.equal(out[0].evidence.action_plan.generation,'guided-check');assert.equal(out[0].evidence.action_plan.draft_status,'page_quote');
});
test('drafted prices and invented routine totals are rejected even when the source reference is valid',()=>{
 const fallback=fallbackActionPlan(project,rec(1,'How much should skincare cost?'),answers[0],pages,{cycle});
 assert.equal(validatedActionPlan({...valid,change:'Add a complete routine price of £400–600 based on these products and describe the final cost to shoppers.'},fallback,answers[0],pages),fallback);
});
test('no verified page produces a specific check without claiming a content gap or inventing a URL',async()=>{
 let generated=0;const out=await prepareActionPlans(project,[rec(1,'How much should skincare cost?')],answers,{cycle,pages:[],generate:async()=>{generated++;}});
 const p=out[0].evidence.action_plan;assert.equal(generated,0);assert.equal(p.page,'');assert.equal(p.page_status,'unavailable');assert.equal(p.mode,'verify');assert.match(p.change,/If the answer is missing or unclear/);assert.match(p.change,/pricing and total cost/);assert.ok(p.suggested_questions.length);
});
test('already adequate content can be retained instead of forcing an edit',()=>{
 const f=fallbackActionPlan(project,rec(1,'How much should skincare cost?'),answers[0],pages,{cycle});const p=validatedActionPlan({...valid,mode:'retain',change:'Keep the current pack size and usage explanation. Confirm that these facts still match the product before the next measurement.'},f,answers[0],pages);assert.equal(p.mode,'retain');
});
test('Arabic fallback stays specific and uses Arabic guidance',()=>{
 const p=fallbackActionPlan(project,rec(1,'ما تكلفة منتجات العناية بالبشرة؟'),answers[0],[],{cycle});assert.match(p.title,/السعر/);assert.match(p.change,/إذا لم تجب/);assert.match(p.suggested_questions[0],/SkinCycles/);
});
test('same answer evidence is cached, a new measurement produces new action drafts',async()=>{
 let calls=0,reads=0;const generate=async()=>{calls++;return JSON.stringify([valid]);};const readPages=async()=>{reads++;return pages;};
 const first=await prepareActionPlans(project,[rec(1,'How much should skincare cost?')],answers,{cycle,generate,readPages});
 await prepareActionPlans(project,[rec(1,'How much should skincare cost?')],answers,{cycle,generate,readPages,cached:first});assert.equal(calls,1);assert.equal(reads,1);
 await prepareActionPlans(project,[rec(1,'How much should skincare cost?')],[{...answers[0],id:101,measurement_id:61}],{cycle,generate,readPages,cached:first});assert.equal(calls,2);
});
test('model failure falls back to concrete checks and retains the measurement evidence',async()=>{
 const out=await prepareActionPlans(project,[rec(1,'Which skincare brand is best?')],answers,{cycle,pages,generate:async()=>{throw Error('Unavailable');}});assert.equal(out[0].evidence.action_plan.generation,'guided-check');assert.equal(out[0].evidence.action_plan.evidence.answer_id,100);
});
test('requests a strict schema and resolves exact passages from structured action output',async()=>{
 const out=await prepareActionPlans(project,[rec(1,'How much should skincare cost?')],answers,{cycle,pages,generate:async(prompt,options)=>{
  assert.equal(options.outputSchema.additionalProperties,false);assert.deepEqual(options.outputSchema.required,['actions']);assert.ok(options.maxTokens>=4000);
  options.onResponse({model:'test-model',stop_reason:'end_turn',usage:{output_tokens:500}});return JSON.stringify({actions:[valid]});
 }});
 assert.equal(out[0].evidence.action_plan.generation,'page-grounded');assert.equal(out[0].evidence.action_plan.provider.stop_reason,'end_turn');
});
test('an incomplete provider response is rejected even if a partial action array parses',async()=>{
 const out=await prepareActionPlans(project,[rec(1,'How much should skincare cost?')],answers,{cycle,pages,generate:async(prompt,options)=>{
  options.onResponse({model:'test-model',stop_reason:'max_tokens',usage:{output_tokens:5000}});return JSON.stringify({actions:[valid]});
 }});
 assert.equal(out[0].evidence.action_plan.generation,'guided-check');assert.equal(out[0].evidence.action_plan.draft_status,'max_tokens');assert.equal(out[0].evidence.action_plan.evidence.answer_id,100);
});
test('page URLs stay on the public owned HTTPS site and exclude account or asset paths',()=>{
 for(const url of ['http://skincycles.com/','https://other.com/','https://u:p@skincycles.com/','https://skincycles.com:444/','/checkout','/account/settings','/image.png',null])assert.equal(ownPageUrl(url,project.domain),null);
 assert.equal(ownPageUrl('/products/serum?ref=x#faq',project.domain),'https://skincycles.com/products/serum');
 for(const ip of ['127.0.0.1','10.0.0.4','172.16.2.4','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','fd00::1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);
});
test('reader blocks private DNS, external redirects and errors with no fallback bypass',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return new Response('',{status:302,headers:{location:'https://other.com'}});};
 assert.equal(await readOwnPage('https://skincycles.com/',project.domain,{lookupImpl:async()=>[{address:'127.0.0.1',family:4}],fetchImpl}),null);assert.equal(calls,0);
 assert.equal(await readOwnPage('https://skincycles.com/',project.domain,{lookupImpl:async()=>[{address:'8.8.8.8',family:4}],fetchImpl}),null);assert.equal(calls,1);
});
test('HTML parsing omits executable content and only follows relevant observed links',async()=>{
 const html='<title>SkinCycles</title><script>Fake price 123456</script><nav>Unrelated menu</nav><main>Our skincare products. '+('Approved product information. '.repeat(6))+'</main><a href="/products/serum">Skincare serum</a><a href="https://evil.com">Skincare serum</a><a href="/checkout">Price</a>';
 const page=pageFromHtml(html,'https://skincycles.com/',project.domain);assert.doesNotMatch(page.text,/123456|Unrelated menu/);assert.equal(page.links.length,1);
 const reads=[];const result=await readActionPages(project.domain,['Which skincare serum is best?'],{readPage:async url=>{reads.push(url);return url.endsWith('/')?page:pages[0];}});assert.equal(reads.length,2);assert.equal(result.length,2);
});
