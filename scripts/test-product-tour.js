import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const source=readFileSync(new URL('../src/public/product-tour.js',import.meta.url),'utf8');
const index=readFileSync(new URL('../src/public/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
function fixture({status='pending',userId=7,project=false,storage,blocked=false,initialize=true}={}){
 const dom=new JSDOM(index,{url:'https://cited.test/app',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,calls=[],scrolls=[];let added=0;
 w.fetch=async(url,options)=>{calls.push({url,options});return {ok:true};};
 w.scrollTo=options=>scrolls.push(options);w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
 if(storage)for(const [key,value] of Object.entries(storage))w.localStorage.setItem(key,value);
 if(blocked)Object.defineProperty(w,'localStorage',{get(){throw Error('Storage blocked');}});
 if(initialize)w.eval(source);const tour=initialize?w.CitedTour.create({userId,status,hasProject:()=>project,onAddSite:()=>added++}):null;
 const get=s=>w.document.querySelector(s);
 return {dom,w,tour,get,calls,scrolls,added:()=>added,close:()=>w.close()};
}
test('new accounts automatically see the welcome tour and existing accounts only see the CTA',()=>{
 for(const status of ['pending','not_required','completed','skipped']){
  const f=fixture({status});f.tour.autoStart();assert.equal(f.get('#citedTour').open,status==='pending');
  assert.equal(f.get('#takeTourBtn').disabled,false);assert.equal(f.get('#takeTourBtn').textContent,'Take a tour');f.close();
 }
});
test('all eight steps work without a project and finish by explicitly opening Add site',()=>{
 const f=fixture();f.tour.autoStart();const titles=[];
 for(let i=0;i<8;i++){titles.push(f.get('#tourTitle').textContent);assert.equal(f.get('.tour-step').textContent,`Step ${i+1} of 8`);f.get('.tour-next').click();}
 assert.equal(new Set(titles).size,8);assert.equal(f.get('#citedTour').open,false);assert.equal(f.added(),1);
 assert.deepEqual(f.calls.map(c=>[c.url,JSON.parse(c.options.body).status]),[['/api/product-tour','completed']]);f.close();
});
test('replaying from a populated form preserves typed values, focus and the current screen',()=>{
 const f=fixture({status:'completed',project:true}),input=f.get('#f_domain');input.value='unsaved.example';input.focus();
 f.get('#view').innerHTML='<textarea id="unsaved">Keep this draft</textarea>';f.get('#unsaved').focus();
 f.get('#takeTourBtn').click();for(let i=0;i<7;i++)f.get('.tour-next').click();
 assert.equal(f.get('.tour-next').textContent,'Finish tour');f.get('.tour-next').click();
 assert.equal(input.value,'unsaved.example');assert.equal(f.get('#unsaved').value,'Keep this draft');assert.equal(f.w.document.activeElement,f.get('#unsaved'));assert.equal(f.added(),0);f.close();
});
test('Back and Escape work, persist the skip, and manual replay starts at the beginning',()=>{
 const f=fixture();f.tour.autoStart();f.get('.tour-next').click();f.get('.tour-next').click();f.get('.tour-back').click();assert.equal(f.get('.tour-step').textContent,'Step 2 of 8');
 f.get('#citedTour').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));
 assert.equal(f.get('#citedTour').open,false);assert.equal(JSON.parse(f.w.localStorage.getItem('cited.product-tour.v1.7')).status,'skipped');
 f.tour.autoStart();assert.equal(f.get('#citedTour').open,false);f.get('#takeTourBtn').click();assert.equal(f.get('.tour-step').textContent,'Step 1 of 8');f.close();
});
test('refresh resumes pending progress and records remain isolated between accounts',()=>{
 const storage={'cited.product-tour.v1.7':JSON.stringify({status:'in_progress',step:3})};
 const a=fixture({storage});a.tour.autoStart();assert.equal(a.get('.tour-step').textContent,'Step 4 of 8');a.close();
 const b=fixture({storage,userId:8});b.tour.autoStart();assert.equal(b.get('.tour-step').textContent,'Step 1 of 8');b.close();
});
test('a local dismissal suppresses repeat onboarding and retries saving only the tour preference',()=>{
 const f=fixture({storage:{'cited.product-tour.v1.7':JSON.stringify({status:'skipped'})}});
 f.tour.autoStart();assert.equal(f.get('#citedTour').open,false);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/api/product-tour');f.close();
});
test('tour remains usable when storage is blocked or targets are absent',()=>{
 const f=fixture({blocked:true});f.w.document.querySelectorAll('[data-section],[data-view],#runBtn,#addSiteBtn').forEach(n=>n.remove());
 f.tour.autoStart();for(let i=0;i<7;i++)f.get('.tour-next').click();f.get('.tour-close').click();
 f.tour.autoStart();assert.equal(f.get('#citedTour').open,false);assert.equal(f.get('.tour-shade').hidden,false);f.close();
});
test('focus is contained and another modal is never displaced',()=>{
 const f=fixture();f.get('#siteDialog').showModal();assert.equal(f.tour.start(),false);f.get('#siteDialog').close();f.tour.start();
 f.get('.tour-next').focus();f.get('#citedTour').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(f.w.document.activeElement,f.get('.tour-close'));
 f.get('#citedTour').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(f.w.document.activeElement,f.get('.tour-next'));f.close();
});
test('boot does not make a project-null request and offers onboarding to an empty account',async()=>{
 let started=0;const paths=[];
 const context=vm.createContext({location:{href:'https://cited.test/app'},window:{CitedTour:{create:()=>({autoStart:()=>started++})}},state:{projectId:null},handleGoogleReturn:()=>null,api:async path=>{paths.push(path);return {signedIn:true,userId:1,productTourStatus:'pending'};},$:()=>({hidden:false}),showVerifyBar:()=>{},loadProjectList:async()=>{},refreshUsagePill:async()=>{},showDemoHandoff:()=>{},reportSourceDestination:()=>null});
 vm.runInContext(app.slice(app.indexOf('async function boot()'),app.indexOf("document.querySelectorAll('.tab[data-view]')")),context);
 await context.boot();assert.equal(started,1);assert.deepEqual(paths,['/api/me']);
});
test('complete application boots a new account, replays the tour, and opens the real site form without paid requests',async()=>{
 const f=fixture({initialize:false});const requests=[];
 f.w.fetch=async(path,options={})=>{
  requests.push({path,method:options.method||'GET'});
  const data=path==='/api/me'?{signedIn:true,userId:7,productTourStatus:'pending',emailVerified:true}:path==='/api/projects'?[]:path==='/api/billing'?null:path==='/api/product-tour'?{ok:true}:String(path).startsWith('/api/locations')?{locations:[]}:undefined;
  if(data===undefined)throw Error('Unexpected request: '+path);
  return {status:200,ok:true,json:async()=>data,clone(){return this;}};
 };
 f.w.eval(readFileSync(new URL('../src/public/countries.js',import.meta.url),'utf8'));
 f.w.eval(source);f.w.eval(app);
 for(let i=0;i<20&&!f.get('#citedTour')?.open;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.get('#brandTitle').textContent,'No sites yet');assert.equal(f.get('#citedTour').open,true);
 f.get('.tour-close').click();f.get('#takeTourBtn').click();
 assert.equal(f.get('#citedTour').open,true);
 for(let i=0;i<8;i++)f.get('.tour-next').click();
 assert.equal(f.get('#siteDialog').open,true);assert.equal(f.w.document.activeElement,f.get('#f_domain'));
 assert.ok(requests.every(r=>r.method==='GET'||r.path==='/api/product-tour'));
 assert.ok(!requests.some(r=>String(r.path).includes('/null/')));f.close();
});
