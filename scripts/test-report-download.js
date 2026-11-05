import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const {JSDOM}=await import(process.env.JSDOM_MODULE||'jsdom');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const start=app.indexOf('/** A download needs a visible outcome');
const source=app.slice(start,app.indexOf('/** Keep the report links',start));
function harness(response){
 const dom=new JSDOM('<a id="repCsv" href="/api/projects/74/report?format=csv&from=2026-11-01">Download data</a>',{url:'https://cited.ae/app'});
 const document=dom.window.document,events=[],calls=[];let handler;
 const add=document.addEventListener.bind(document);document.addEventListener=(name,fn)=>{if(name==='click')handler=fn;else add(name,fn);};
 dom.window.HTMLAnchorElement.prototype.click=function(){events.push({download:this.download,href:this.href});};
 const h=vm.createContext({document,state:{projectId:74},AbortController,setTimeout:()=>0,clearTimeout:()=>{},URL:{createObjectURL:()=> 'blob:csv-test',revokeObjectURL:()=>{}},toast:(message,kind)=>events.push({message,kind}),fetch:async(url,options)=>{calls.push({url,options});return response();}});
 vm.runInContext(source,h);
 return {document,events,calls,click:()=>handler({target:document.getElementById('repCsv'),preventDefault(){}})};
}
test('CSV download uses the selected period and reports successful file creation',async()=>{
 const x=harness(async()=>({ok:true,headers:{get:()=> 'text/csv; charset=utf-8'},blob:async()=>new Blob(['question,answer'])}));await x.click();
 assert.match(x.calls[0].url,/from=2026-11-01/);assert.equal(x.events[0].download,'cited-74-data.csv');assert.match(x.events[1].message,/download started/);
 assert.equal(x.document.getElementById('repCsv').textContent,'Download data');
});
for(const [name,response,expected] of [
 ['server failure',async()=>({ok:false,status:503}),/503/],
 ['expired session HTML',async()=>({ok:true,headers:{get:()=> 'text/html'}}),/did not return a CSV/],
 ['timeout',async()=>{throw Object.assign(Error('timeout'),{name:'AbortError'});},/took too long/]
])test(`CSV ${name} is visible and retryable without producing a false download`,async()=>{
 const x=harness(response);await x.click();assert.equal(x.events.length,1);assert.match(x.events[0].message,expected);assert.equal(x.events[0].kind,'bad');assert.equal(x.document.getElementById('repCsv').hasAttribute('aria-disabled'),false);
});
test('repeated clicks during download produce only one request',async()=>{
 let finish;const x=harness(()=>new Promise(resolve=>finish=resolve));const first=x.click();await x.click();assert.equal(x.calls.length,1);
 finish({ok:false,status:503});await first;
});
