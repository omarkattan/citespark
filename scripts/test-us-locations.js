import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {JSDOM} = await import(process.env.JSDOM_MODULE || 'jsdom');
const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const states = ['California','Texas','District of Columbia'].map(label => ({label,name:`${label},United States`,type:'State'}));
const city = {label:'Austin,Texas',name:'Austin,Texas,United States',type:'City'};
const places = [...states,city,...Array.from({length:30000},(_,i)=>({name:`County ${i},United States`,label:`County ${i}`,type:'County'}))];
function ui(api) {
  const dom = new JSDOM('<details id="siteOptional"></details><select id="f_city"></select><p id="hint"></p><button id="siteSave"></button>');
  const document = dom.window.document;
  const context = vm.createContext({api,encodeURIComponent,cityCache:new Map(),esc:s=>String(s??'').replace(/[&<>"\x27]/g,c=>`&#${c.charCodeAt(0)};`)});
  const start = app.indexOf('function syncLocationChoice(');
  vm.runInContext(app.slice(start,app.indexOf('const ENGINE_LABEL',start)),context);
  return {dom,context,select:document.getElementById('f_city'),hint:document.getElementById('hint'),save:document.getElementById('siteSave')};
}
test('large US response renders only states and allows state selection',async()=>{
  const u=ui(async()=>({countryLocation:'United States',cities:places}));
  await u.context.fillCities('US',u.select,u.hint);
  assert.equal(u.select.options.length,4);
  assert.equal(u.select.disabled,false);
  assert.equal(u.save.disabled,false);
  u.select.value=states[0].name;
  u.select.dispatchEvent(new u.dom.window.Event('change'));
  assert.equal(u.save.disabled,false);
  assert.match(u.hint.textContent,/California,United States/);
});
test('existing verified city is retained, invalid saved choice is blocked, new setup remains states only',async()=>{
  const urls=[];const u=ui(async url=>{urls.push(url);return {countryLocation:'United States',cities:places};});
  await u.context.fillCities('US',u.select,u.hint,city.name);
  assert.equal(u.select.value,city.name);assert.equal(u.save.disabled,false);
  assert.ok(urls[0].includes(encodeURIComponent(city.name)));
  await u.context.fillCities('US',u.select,u.hint);
  assert.equal(u.select.options.length,4);assert.equal(u.select.value,'');
  await u.context.fillCities('US',u.select,u.hint,'Unknown');
  assert.equal(u.select.value,'Unknown');assert.equal(u.save.disabled,true);
});
test('other markets retain their cities and failed requests can recover',async()=>{
  let count=0;const u=ui(async()=>++count===1?{error:'Temporary outage'}:{countryLocation:'United Arab Emirates',cities:[{name:'Dubai,Dubai,United Arab Emirates',label:'Dubai',type:'City'}]});
  await u.context.fillCities('AE',u.select,u.hint);assert.equal(u.save.disabled,true);
  await u.context.fillCities('AE',u.select,u.hint);assert.equal(u.save.disabled,false);assert.equal(u.select.options.length,2);
});
test('late US response cannot replace a newer market selection',async()=>{
  const pending={};const u=ui(url=>new Promise(resolve=>pending[url]=resolve));
  const us=u.context.fillCities('US',u.select,u.hint);const gb=u.context.fillCities('GB',u.select,u.hint);
  pending['/api/locations/GB']({countryLocation:'United Kingdom',cities:[]});await gb;
  pending['/api/locations/US']({countryLocation:'United States',cities:places});await us;
  assert.match(u.hint.textContent,/United Kingdom/);assert.equal(u.select.options.length,1);
});
test('location endpoint sends compact US list while validating any retained location against provider list',async()=>{
  let handler;const start=server.indexOf("app.get('/api/locations/:country'");
  const source=server.slice(start,server.indexOf('\n}));',start)+5).replace("const { googleLocations } = await import('./lib/dataforseo.js');",'');
  vm.runInNewContext(source,{app:{get:(path,...handlers)=>handler=handlers.at(-1)},requireAuth:()=>{},wrap:x=>x,LOCATIONS:{US:'United States',AE:'United Arab Emirates'},googleLocations:async()=>places});
  const run=async(country,selected)=>{let body;await handler({params:{country},query:{selected}},{json:value=>body=value});return body;};
  assert.equal((await run('US')).cities.length,3);
  assert.equal((await run('US',city.name)).cities.length,4);
  assert.equal((await run('US','Unknown')).cities.length,3);
  assert.equal((await run('AE')).cities.length,places.length);
});
