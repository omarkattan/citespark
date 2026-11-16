import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePrompts} from '../src/lib/prompts.js';
const args={brand:'بنك الاتحاد',domain:'bankaletihad.com',category:'retail and business banking',market:'Jordan',language:'en',quickStart:true,count:20};
const good=JSON.stringify(Array.from({length:20},(_,i)=>({text:`Which banks offer banking service ${i+1} in Jordan?`,intent:'discovery',cluster:'banking'})));
test('Quick Start recovers from an invalid response with one bounded retry',async()=>{
 let calls=0;const rows=await generatePrompts(args,{completeText:async()=>++calls===1?'[incomplete':good});assert.equal(calls,2);assert.equal(rows.length,20);
});
test('provider timeout retries once and reports a safe reason instead of ten templates',async()=>{
 let calls=0;await assert.rejects(generatePrompts(args,{completeText:async(p,o)=>{calls++;o.onFailure('timeout');return null;}}),e=>e.code==='QUESTION_PREPARATION_FAILED'&&e.reason==='timeout');assert.equal(calls,2);
});
test('configuration failures do not repeat the request',async()=>{
 let calls=0;await assert.rejects(generatePrompts(args,{completeText:async(p,o)=>{calls++;o.onFailure('http_401');return null;}}),e=>e.reason==='http_401');assert.equal(calls,1);
});
test('a retry with too few usable questions cannot silently pass or make a third call',async()=>{
 let calls=0;await assert.rejects(generatePrompts(args,{completeText:async()=>++calls===1?'invalid':JSON.stringify(JSON.parse(good).slice(0,16))}),e=>e.reason==='insufficient_questions');assert.equal(calls,2);
});
test('a complete valid list avoids retries',async()=>{let calls=0;const rows=await generatePrompts(args,{completeText:async()=>{calls++;return good}});assert.equal(calls,1);assert.equal(rows.length,20);});
