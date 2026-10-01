import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE);
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
test('setup estimate uses project prices plus the same provisional amount as run confirmation',()=>{
 const dom=new JSDOM(`<div data-active-count="28" data-runs="1">${['n','surfaces-n','surfaces-word','runs-n','calls','cycle-cost','month-cost','cost-source','cost-label'].map(k=>`<span data-${k}></span>`).join('')}</div><input type="checkbox" data-engine="chatgpt" checked><input type="checkbox" data-engine="gemini" checked>`);
 const state={costs:{chatgpt:0.01},estimateDefault:0.03,estimateAvailable:true};const ctx=vm.createContext({document:dom.window.document,state});vm.runInContext(app.slice(app.indexOf('function recalcEstimate()'),app.indexOf('/** Keep the "x active questions')),ctx);ctx.recalcEstimate();
 assert.equal(dom.window.document.querySelector('[data-cycle-cost]').textContent,'$1.12');assert.equal(dom.window.document.querySelector('[data-calls]').textContent,'56');assert.match(dom.window.document.querySelector('[data-cost-source]').textContent,/Actual cost may differ/);assert.doesNotMatch(dom.window.document.body.textContent,/at most|ceiling/i);
 state.costs={};ctx.recalcEstimate();assert.equal(dom.window.document.querySelector('[data-cycle-cost]').textContent,'$1.68');
 state.estimateAvailable=false;ctx.recalcEstimate();assert.equal(dom.window.document.querySelector('[data-cycle-cost]').textContent,'Unavailable');dom.window.close();
});
test('question wording control is outside the collapsed advanced menu',()=>{
 const start=app.indexOf('<button class="ghost" data-question-edit="${p.id}">');assert.ok(start>0);assert.ok(app.slice(start,start+180).includes('<details class="question-more">'));
});
