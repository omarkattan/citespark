const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {JSDOM}=require(process.env.JSDOM_MODULE || 'jsdom');
const app=readFileSync(__dirname+'/../src/public/app.js','utf8');
const ctx=vm.createContext({state:{overview:{project:{domain:'example.com'}},setupStep:'sources'},esc:s=>String(s??'').replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`),api:async()=>({connected:false})});
vm.runInContext(app.slice(app.indexOf('function sourceSetupGuide('),app.indexOf('async function viewSearchDemand(')),ctx);
vm.runInContext(app.slice(app.indexOf('function gscQuestionPanel('),app.indexOf('function questionTools(')),ctx);
for(const kind of ['gsc','ga4']) {
 for(const [connection,step] of [[{},1],[{connected:true},2],[{connected:true,siteUrl:'sc-domain:example.com',propertyId:'123',propertyName:'Example'},3]]){
  const doc=new JSDOM(ctx.sourceSetupGuide(kind,connection)).window.document;
  assert.equal(doc.querySelectorAll('ol > li').length,3);
  assert.equal([...doc.querySelectorAll('ol > li')].findIndex(x=>x.hasAttribute('aria-current'))+1,step);
  assert.ok(doc.body.textContent.includes('example.com')||step===3);
  if(step===3)assert.match(doc.body.textContent,/Connection complete/);
 }
 assert.doesNotMatch(ctx.sourceSetupGuide(kind,{error:true}),/Connection complete|aria-current/);
}
assert.match(ctx.sourceSetupGuide('gsc',{connected:true,siteUrl:'<script>'}),/&#60;script&#62;/);
for(const c of [{},{connected:true},{connected:true,siteUrl:'example.com'}]) {
 const doc=new JSDOM(ctx.gscQuestionPanel(c,true)).window.document;
 assert.ok(doc.querySelector('.source-guide'));
 assert.ok(doc.querySelector(c.siteUrl?'#gscLoad':c.connected?'#gscSwitch':'#gscGrant'));
}
(async()=>{
 const doc=new JSDOM(await ctx.viewConnections()).window.document;
 assert.ok(doc.querySelector('[data-open-view="searchDemand"]'));
 assert.ok(doc.querySelector('[data-open-view="traffic"]'));
 assert.ok(doc.querySelector('[data-setup-step="questions"]'));
 console.log('PASS: both source guides, all connection states, escaping, existing actions and skip route');
})();
