import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {googleLocale,googleLanguage,historicalGoogleWarnings} from '../src/lib/google-locale.js';
import {LOCATIONS} from '../src/lib/dataforseo.js';
import {measurementSettings} from '../src/lib/measurement-batches.js';
const ar='ما هي أفضل البنوك في الأردن للحسابات الجارية';
test('Jordan uses Jordan and each English/Arabic question uses its matching search language',()=>{
 assert.deepEqual(googleLocale(ar,'JO',null,LOCATIONS),{location_name:'Jordan',language_code:'ar'});
 assert.deepEqual(googleLocale('Best banks in Jordan','JO',null,LOCATIONS),{location_name:'Jordan',language_code:'en'});
 assert.equal(googleLocale(ar,'JO','Amman,Amman Governorate,Jordan',LOCATIONS).location_name,'Amman,Amman Governorate,Jordan');
 assert.equal(googleLanguage('Which bank is better than بنك الاتحاد?'),'en');
 assert.throws(()=>googleLocale(ar,'XX',null,LOCATIONS),/not configured/);
});
test('actual Google request uses locale and never spends on unknown-country fallback',async()=>{
 const text=readFileSync(new URL('../src/lib/dataforseo.js',import.meta.url),'utf8');
 const start=text.indexOf('async function askGoogle(');const end=text.indexOf('\n}',start)+2;
 const src=text.slice(start,end);
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 let bodies=[];
 const fetch=async(url,opts)=>{bodies.push(JSON.parse(opts.body)[0]);return {ok:false,status:503};};
 const run=new AsyncFunction('googleLocale','LOCATIONS','fetch','BASE','authHeader','cfg','prompt','market','process',src+';return askGoogle({cfg,prompt,market});');
 const deps=[googleLocale,LOCATIONS,fetch,'https://example.test',()=>'',{mode:'ai_mode',label:'Google AI Mode'}];
 await run(...deps,ar,'JO',{env:{}});assert.equal(bodies[0].location_name,'Jordan');assert.equal(bodies[0].language_code,'ar');
 const failure=await run(...deps,ar,'XX',{env:{}});assert.equal(bodies.length,1);assert.equal(failure.ok,false);assert.equal(failure.costUsd,0);
});
test('locale policy changes the settings snapshot and old Jordan/Arabic runs receive warnings',()=>{
 const s=measurementSettings({market:'JO'}, {}, ['chatgpt','ai_mode'],1,2000);
 assert.ok(s.googleLocalePolicy);
 const old={settings:{market:'JO',engines:['chatgpt','ai_mode']}};
 assert.equal(historicalGoogleWarnings(old,[{text:ar}]).length,2);
 assert.deepEqual(historicalGoogleWarnings({settings:s},[{text:ar}]),[]);
 assert.deepEqual(historicalGoogleWarnings({settings:{market:'JO',engines:['chatgpt']}},[{text:ar}]),[]);
 assert.deepEqual(historicalGoogleWarnings({settings:{market:'SA',engines:['ai_mode']}},[{text:'Best banks?'}]),[]);
});

import {executiveReportHtml} from '../src/lib/report-executive-html.js';
import {summariseEvidence} from '../src/lib/report-evidence.js';
test('CEO report exposes the setup error and requests corrected measurement rather than content action',()=>{
 const e=summariseEvidence([{prompt_id:1,text:ar,engine:'ai_mode',ok:true,response_text:'Bank al Etihad.',mentioned:true,cited:true}]);
 e.localeWarnings=historicalGoogleWarnings({settings:{market:'JO',engines:['ai_mode']}},e.questions);
 const html=executiveReportHtml({executive:e,project:{name:'Test',domain:'example.com'},generatedAt:'2026-09-28',trend:{comparable:false}});
 assert.match(html,/Collection setup error. Rerun before presenting/);
 assert.match(html,/Repeat the measurement with corrected Google settings/);
 assert.doesNotMatch(html,/Build on content already being cited/);
});
