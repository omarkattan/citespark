import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {conversionRoutes} from '../src/lib/conversion-routes.js';
import {unsubscribeToken} from '../src/lib/conversion-followups.js';

test('demo puts the signup CTA before evidence and signup consent stays optional and unchecked',()=>{
 const dom=new JSDOM('<input id="demoDomain"><button id="demoScan"></button><div id="demoNote"></div><div id="demoStep1"></div><div id="demoStep2"></div><div id="demoStep3"></div><div id="demoWorking"></div><div id="demoResult"></div>',{url:'https://cited.ae',runScripts:'outside-only'});
 const w=dom.window;w.HTMLElement.prototype.scrollIntoView=function(){};
 w.eval(readFileSync(new URL('../src/public/demo.js',import.meta.url),'utf8'));
 w.showResult({domain:'example.test',brandName:'<img src=x>',question:'Which?',engine:'chatgpt',runs:3,mentions:3,strip:[],sources:[],fanOut:[],answerEvidence:[{text:'Example',mentioned:true}]});
 const cta=w.document.querySelector('.demo-cta-primary'),answers=w.document.querySelector('[aria-label="Answers behind this result"]');
 assert.ok(cta.compareDocumentPosition(answers)&w.Node.DOCUMENT_POSITION_FOLLOWING);
 assert.equal(cta.querySelector('a').getAttribute('href'),'/login?demo=1&signup=1');assert.equal(w.document.querySelectorAll('img').length,0);
 const login=new JSDOM(readFileSync(new URL('../src/public/login.html',import.meta.url),'utf8'),{url:'https://cited.ae/login?signup=1',runScripts:'outside-only'});
 for(const script of login.window.document.querySelectorAll('script:not([src])'))login.window.eval(script.textContent);
 const consent=login.window.document.getElementById('marketingConsent');assert.equal(consent.checked,false);assert.equal(consent.required,false);assert.equal(login.window.document.getElementById('consentField').hidden,false);
 dom.window.close();login.window.close();
});

test('first-party pricing telemetry emits at most once per page surface and no personal fields',async()=>{
 const dom=new JSDOM('',{url:'https://cited.ae/app',runScripts:'outside-only'}),calls=[];
 dom.window.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true};};
 dom.window.eval(readFileSync(new URL('../src/public/conversion.js',import.meta.url),'utf8'));
 dom.window.CitedConversion.pricing('billing');dom.window.CitedConversion.pricing('billing');
 assert.deepEqual(calls,[{url:'/api/conversion/pricing',body:{surface:'billing'}}]);dom.window.close();
});

test('HTTP routes deny anonymous/admin access, scope saved context, and unsubscribe needs a signed POST',async()=>{
 const db=new PGlite();await db.exec(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));await db.exec(readFileSync(new URL('../src/db/conversion.sql',import.meta.url),'utf8'));
 await db.exec("INSERT INTO orgs(id,name,internal) VALUES(1,'Customer',false),(2,'Internal',true); INSERT INTO users(id,org_id,email,password_hash,marketing_opt_in_at,email_verified_at) VALUES(1,1,'person@example.test','fake',now(),now()),(2,2,'internal@example.test','fake',NULL,now());");
 const app=express();app.use(express.json());
 // Test-only identity injection. The deployed server uses its existing signed session cookie.
 app.use((req,_res,next)=>{const id=Number(req.get('x-fixture-user'));req.session=id?{userId:id,orgId:id}:{};next();});
 const requireAuth=(req,res,next)=>req.session.userId?next():res.status(401).end();
 const requireAdmin=(req,res,next)=>req.session.orgId===2?next():res.status(req.session.userId?404:401).end();
 app.use(conversionRoutes({db,requireAuth,requireAdmin,secret:'test-secret'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const headers={'x-fixture-user':'1','Content-Type':'application/json'};
 try{
  assert.equal((await fetch(origin+'/api/admin/conversions')).status,401);
  assert.equal((await fetch(origin+'/api/admin/conversions',{headers})).status,404);
  assert.equal((await fetch(origin+'/api/admin/conversions',{headers:{'x-fixture-user':'2'}})).status,200);
  assert.equal((await fetch(origin+'/api/conversion/handoff')).status,401);
  assert.equal((await fetch(origin+'/api/conversion/pricing',{method:'POST',headers,body:JSON.stringify({surface:'billing',event:'payment_completed',orgId:2})})).status,200);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM conversion_events WHERE event_name='payment_completed'")).rows[0].n,0);
  assert.equal((await db.query("SELECT org_id FROM conversion_events WHERE event_name='pricing_viewed'")).rows[0].org_id,1);
  assert.equal((await fetch(origin+'/api/email-preferences',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{"optedIn":true}'})).status,403);
  const link=origin+'/email/unsubscribe?t='+unsubscribeToken(1,'test-secret');
  assert.equal((await fetch(link)).status,200);assert.equal((await db.query('SELECT email_suppressed_at FROM users WHERE id=1')).rows[0].email_suppressed_at,null);
  assert.equal((await fetch(link,{method:'POST'})).status,200);assert.ok((await db.query('SELECT email_suppressed_at FROM users WHERE id=1')).rows[0].email_suppressed_at);
  assert.equal((await fetch(link,{method:'POST'})).status,200);
  assert.equal((await fetch(origin+'/email/unsubscribe?t=2.bad',{method:'POST'})).status,400);
  await fetch(origin+'/api/email-preferences',{method:'POST',headers,body:'{"optedIn":true}'});
  assert.equal((await db.query('SELECT email_suppressed_at FROM users WHERE id=1')).rows[0].email_suppressed_at,null);
 }finally{await new Promise(resolve=>server.close(resolve));await db.close();}
});
