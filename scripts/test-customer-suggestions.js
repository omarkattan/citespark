import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const index=readFileSync(new URL('../src/public/index.html',import.meta.url),'utf8');
const discover=readFileSync(new URL('../src/lib/discover.js',import.meta.url),'utf8');
function fixture(){
 const dom=new JSDOM(index,{url:'https://cited.test/app',runScripts:'outside-only'}),w=dom.window;
 const calls=[];let scan={domain:'example.com',brandName:'Example',customerSuggestions:['Shoppers with dry skin','Shoppers with sensitive skin'],confident:true};
 w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.scrollTo=()=>{};
 Object.assign(w,{$:id=>w.document.getElementById(id),state:{},fillCities:()=>{},syncLocationChoice:()=>{w.document.getElementById('siteSave').disabled=false;return true;},parseRivals:()=>[],loadProjectList:async()=>{},render:async()=>{},toast:()=>{},countryOptions:()=>'<option value="GB">UK</option>',DEFAULT_COUNTRY:'GB'});
 w.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>url==='/api/discover'?scan:{project:{id:1}}};};
 w.eval(app.slice(app.indexOf('function setupCustomerLines()'),app.indexOf('/* ---------- plan and usage ---------- */')));
 w.document.getElementById('siteSave').disabled=false;
 return {w,calls,get:s=>w.document.querySelector(s),scan:d=>{scan=d;},close:()=>w.close()};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('site scan offers choices and saves selected and custom customers for question generation',async()=>{
 const f=fixture();f.get('#f_domain').value='example.com';f.get('#f_scan').click();await flush();
 assert.equal(f.get('#f_customerSuggestions').hidden,false);
 assert.equal(f.get('#f_qualifier').value,'','suggestions need user selection');
 const choices=f.w.document.querySelectorAll('#f_customerOptions input');
 choices[0].click();choices[1].click();
 f.get('#f_qualifier').value+='\nGift buyers';f.get('#f_qualifier').dispatchEvent(new f.w.Event('input'));
 choices[0].click();assert.equal(f.get('#f_qualifier').value,'Shoppers with sensitive skin\nGift buyers');
 f.get('#siteSave').click();await flush();
 assert.equal(f.calls.find(c=>c.url==='/api/projects').body.qualifier,'Shoppers with sensitive skin; Gift buyers');f.close();
});
test('editing a selected suggestion updates the checkbox and rescanning preserves custom text',async()=>{
 const f=fixture();f.w.showCustomerSuggestions(['Shoppers with dry skin']);f.get('#f_customerOptions input').click();
 f.get('#f_qualifier').value='Shoppers with very dry skin';f.get('#f_qualifier').dispatchEvent(new f.w.Event('input'));
 assert.equal(f.get('#f_customerOptions input').checked,false);
 f.get('#f_domain').value='example.com';f.get('#f_scan').click();await flush();
 assert.equal(f.get('#f_qualifier').value,'Shoppers with very dry skin');
 f.get('#f_domain').dispatchEvent(new f.w.Event('input'));assert.equal(f.get('#f_customerSuggestions').hidden,true);f.close();
});
test('unreadable sites still allow manual customers and stale scan results are ignored',async()=>{
 const f=fixture();f.get('#f_domain').value='example.com';f.w.fetch=async()=>{throw Error('Could not read site');};
 f.get('#f_scan').click();await flush();f.get('#f_qualifier').value='Our own customer group';assert.equal(f.get('#f_qualifier').disabled,false);
 let resolve;f.w.fetch=()=>new Promise(r=>{resolve=r;});f.get('#f_scan').click();f.get('#f_domain').value='other.com';
 resolve({ok:true,json:async()=>({domain:'example.com',customerSuggestions:['Wrong site audience']})});await flush();
 assert.equal(f.get('#f_customerSuggestions').hidden,true);assert.equal(f.get('#f_qualifier').value,'Our own customer group');f.close();
});
test('suggestions render as text, remain bounded and safely handle missing values',()=>{
 const f=fixture();f.w.showCustomerSuggestions(['<img src=x onerror=alert(1)>','Same','same',null]);
 assert.equal(f.get('#f_customerOptions img'),null);assert.equal(f.w.document.querySelectorAll('#f_customerOptions input').length,2);
 f.w.showCustomerSuggestions();assert.equal(f.get('#f_customerSuggestions').hidden,true);f.close();
 const context=vm.createContext({});vm.runInContext(discover.slice(discover.indexOf('export function normaliseCustomerSuggestions'),discover.indexOf('function summarise')).replace('export ',''),context);
 assert.equal(JSON.stringify(context.normaliseCustomerSuggestions(['  Buyers  of skincare ','buyers of skincare',null,{},'x'.repeat(161)])),JSON.stringify(['Buyers of skincare']));
 assert.equal(context.normaliseCustomerSuggestions(Array.from({length:10},(_,i)=>`Customer ${i}`)).length,5);
});
