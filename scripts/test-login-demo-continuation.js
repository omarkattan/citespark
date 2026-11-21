import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const {JSDOM}=await import(process.env.JSDOM_MODULE||'jsdom');
const html=readFileSync(new URL('../src/public/login.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../src/public/login.js',import.meta.url),'utf8');
for(const registering of [false,true])test(`demo ${registering?'registration':'login'} redirects with website preserved`,async()=>{
 const dom=new JSDOM(html),document=dom.window.document,location={search:'?demo=1&website=example.com'+(registering?'&signup=1':''),assign(url){this.href=url;}};
 const ctx=vm.createContext({document,location,URLSearchParams,window:{location,CitedDemoHandoff:{read:()=>null}},fetch:async()=>({ok:true,json:async()=>({verificationSent:registering})})});
 vm.runInContext(js,ctx);document.getElementById('email').value='test@example.com';document.getElementById('password').value='test-only-password';document.getElementById('panel').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
 await new Promise(r=>setImmediate(r));assert.equal(location.href,'/quick-start?demo=1&website=example.com');dom.window.close();
});

test('forgot-password confirmation offers signup with the entered email preserved',async()=>{
 const dom=new JSDOM(html),document=dom.window.document,location={search:'?forgot=1'};
 const ctx=vm.createContext({document,location,URLSearchParams,window:{},fetch:async()=>({ok:true,json:async()=>({ok:true})})});
 vm.runInContext(js,ctx);document.getElementById('email').value='reader@example.test';
 document.getElementById('panel').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));
 assert.match(document.getElementById('error').textContent,/If nothing arrives/);
 document.getElementById('registerFromReset').click();
 assert.equal(document.getElementById('formTitle').textContent,'Create an account');
 assert.equal(document.getElementById('email').value,'reader@example.test');dom.window.close();
});
