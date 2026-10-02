import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE);
const code=readFileSync(new URL('../src/public/context-help.js',import.meta.url),'utf8');
const setup=html=>{const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true});dom.window.eval(code);return dom;};
const tick=w=>new Promise(resolve=>w.setTimeout(resolve,60));
test('help is separate, accessible and never activates the action or form',()=>{
 const dom=setup('<form><button data-operation="generate">Generate analysis</button></form>');const w=dom.window,d=w.document;
 let actions=0;d.querySelector('form').addEventListener('click',()=>actions++);d.querySelector('form').addEventListener('submit',e=>{e.preventDefault();actions++;});
 const b=d.querySelector('.cited-help-button'),p=d.querySelector('[role=tooltip]');assert.equal(b.type,'button');assert.equal(d.querySelector('button button'),null);
 b.focus();assert.equal(p.hidden,false);assert.match(p.textContent,/paid AI request/);assert.equal(b.getAttribute('aria-describedby'),p.id);
 b.click();assert.equal(p.hidden,false);assert.equal(actions,0);b.click();assert.equal(p.hidden,true);
 b.dispatchEvent(new w.Event('pointerenter'));assert.equal(p.hidden,false);d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(p.hidden,true);
 b.click();d.body.click();assert.equal(p.hidden,true);assert.equal(actions,0);dom.window.close();
});
test('dynamic controls get one help button and hidden or removed controls leave no visible help',async()=>{
 const dom=setup('<main></main>'),w=dom.window,d=w.document,m=d.querySelector('main');m.innerHTML='<button data-question-toggle>Pause</button>';await tick(w);
 const target=m.firstElementChild,help=target.nextElementSibling;assert.match(help.dataset.explanation,/Stops asking/);
 target.textContent='Resume';await tick(w);assert.match(help.dataset.explanation,/Makes this question active/);assert.equal(d.querySelectorAll('.cited-help-button').length,1);
 target.hidden=true;await tick(w);assert.equal(help.hidden,true);target.hidden=false;await tick(w);assert.equal(help.hidden,false);
 target.remove();await tick(w);assert.equal(d.querySelectorAll('.cited-help-button').length,0);dom.window.close();
});
test('help uses plain text, avoids nested interactive content and stays out of print',()=>{
 const dom=setup('<button data-help="&lt;img src=x onerror=alert(1)&gt;">Custom</button><a href="#"><b data-help="Nested">Nested</b></a>'),d=dom.window.document;
 d.querySelector('.cited-help-button').click();assert.equal(d.querySelector('[role=tooltip] img'),null);assert.match(d.querySelector('[role=tooltip]').textContent,/<img/);assert.equal(d.querySelectorAll('.cited-help-button').length,1);assert.match(d.querySelector('style').textContent,/@media print/);dom.window.close();
});
