import {preservesQueryBasics,containsSearchBrand,existingGscQuestion} from '../src/lib/gsc-query-integrity.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sealCandidate,openCandidate,matchSearchSnapshot,questionRole,reviewShortlist} from '../src/lib/search-evidence.js';
import {executiveReportHtml} from '../src/lib/report-executive-html.js';
import {summariseEvidence} from '../src/lib/report-evidence.js';
const evidence={property:'sc-domain:example.com',startDate:'2026-06-30',endDate:'2026-09-28',fetchedAt:'2026-09-28',returnedRows:2,rowLimit:2000};
test('signed import binds server data to project and property, rejecting stale or altered selections',()=>{
 const c={text:'Which provider?',querySet:['provider'],impressions:42,clicks:0};
 const token=sealCandidate(27,c,evidence);
 assert.equal(openCandidate(token,27,evidence.property).impressions,42);
 assert.throws(()=>openCandidate(token,28,evidence.property));
 assert.throws(()=>openCandidate(token,27,'sc-domain:other.com'));
 assert.throws(()=>openCandidate(token+'x',27,evidence.property));
 assert.throws(()=>openCandidate(null,27,evidence.property));
 const now=Date.now;try{Date.now=()=>now()+31*60*1000;assert.throws(()=>openCandidate(token,27,evidence.property));}finally{Date.now=now;}
});
test('exact stored queries preserve zero, absence is null, and legacy examples stay labelled partial',()=>{
 const rows=[{query:'fees',impressions:10,clicks:0,position:3},{query:'other',impressions:100,clicks:5,position:1}];
 const g=matchSearchSnapshot({queryExamples:['fees','missing']},{rows,evidence});
 assert.equal(g.impressions,10);assert.equal(g.clicks,0);assert.equal(g.matchedQueries,1);assert.equal(g.storedQueries,2);assert.equal(g.avgPosition,3);assert.equal(g.scope,'stored query examples only');
 const empty=matchSearchSnapshot({querySet:['Fees']},{rows,evidence});assert.equal(empty.impressions,null);assert.equal(empty.clicks,null);assert.equal(empty.avgPosition,null);
 const zero=matchSearchSnapshot({querySet:['fees']},{rows:[{query:'fees',impressions:0,clicks:0,position:0}],evidence});assert.equal(zero.impressions,0);assert.equal(zero.avgPosition,null);
});
test('wording inference does not trust old commercial labels or sort by impressions',()=>{
 assert.equal(questionRole('What is an endowment?'),'Topic to qualify');
 assert.equal(questionRole('Which wealth management firms offer private market access?'),'Buyer decision');
 assert.equal(questionRole('ما أفضل شركات إدارة الثروات؟'),'Buyer decision');
 const list=reviewShortlist([{id:1,text:'Best firms?',measured:5,cited:0,named:0,impressions:100000},{id:2,text:'Provider fees?',measured:5,cited:1,named:0,impressions:0}]);assert.equal(list[0].id,2);
});
test('report labels legacy dates, matched zero, independent clocks and incomplete coverage',()=>{
 const row={prompt_id:1,text:'Which providers?',source:'gsc',ok:true,engine:'chatgpt',response_text:'Complete answer.',mentioned:false,cited:false,origin_details:{property:evidence.property,impressions:400}};
 const e=summariseEvidence([row,{...row,prompt_id:2,origin_details:{gscSnapshot:{...evidence,scope:'stored query examples only',matchedQueries:1,storedQueries:3,clicks:0,impressions:10}}},{...row,engine:'gemini',ok:false}]);
 const html=executiveReportHtml({executive:{...e,cycle:'2026-09-28'},project:{id:27,name:'Sample',domain:'example.com'},generatedAt:'2026-09-28',trend:{comparable:false}});
 assert.match(html,/Dates and clicks were not retained/);assert.match(html,/0 clicks/);assert.match(html,/independent of the AI measurement date/);assert.match(html,/complete the evidence before treating this as a content gap/);assert.match(html,/refresh-evidence/);
});

import {readFileSync} from 'node:fs';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const gscSource=readFileSync(new URL('../src/lib/gsc.js',import.meta.url),'utf8');
test('actual import persists signed provenance and ignores altered browser figures before any insert',async()=>{
 const imported=[];
 const pool={connect:async()=>({release(){},query:async(sql,args)=>{if(sql.startsWith('SELECT gsc_site_url'))return {rows:[{gsc_site_url:evidence.property}]}; if(!sql.trim().startsWith('INSERT'))return {rows:[]};imported.push(args);return {rows:[{id:1}]};}})};
 const source=gscSource.slice(gscSource.indexOf('export async function importQuestions'),gscSource.indexOf('/** Refresh search evidence only.')).replace('export ','');
 const run=new AsyncFunction('pool','openCandidate','preservesQueryBasics','containsSearchBrand','existingGscQuestion','projectId','chosen',source+';return importQuestions(projectId,chosen);');
 const candidate={groupingMethod:'exact-normalized-v1',text:'Which provider?',cluster:'which providers',querySet:['fees'],examples:['fees'],impressions:10,clicks:0,avgPosition:3,source:'gsc'};
 const chosen={...candidate,impressions:99999,evidenceToken:sealCandidate(27,candidate,evidence)};
 assert.equal(await run(pool,openCandidate,preservesQueryBasics,containsSearchBrand,existingGscQuestion,27,[chosen]),1);
 assert.equal(imported[0][4],10);assert.equal(imported[0][3],'unclassified');assert.equal(JSON.parse(imported[0][6]).gscSnapshot.clicks,0);
 imported.length=0;await assert.rejects(run(pool,openCandidate,preservesQueryBasics,containsSearchBrand,existingGscQuestion,27,[{evidenceToken:sealCandidate(27,{...candidate,groupingMethod:undefined},evidence)}]));assert.equal(imported.length,0);
 imported.length=0;await assert.rejects(run(pool,openCandidate,preservesQueryBasics,containsSearchBrand,existingGscQuestion,27,[chosen,{evidenceToken:'invalid'}]));assert.equal(imported.length,0);
});
test('actual refresh is property-scoped and writes search JSON without changing AI results',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');const db=new PGlite();
 try{
 await db.exec('CREATE TABLE prompts(id int,project_id int,active boolean,source text,origin_details jsonb)');
 for(const [id,project,property] of [[1,27,evidence.property],[2,28,evidence.property],[3,27,'sc-domain:other.com']])await db.query("INSERT INTO prompts VALUES($1,$2,true,'gsc',$3)",[id,project,JSON.stringify({property,queryExamples:['fees'],impressions:300})]);
 const many=async(sql,args)=>(await db.query(sql,args)).rows;
 const query=async(sql,args)=>db.query(sql,args);
 const fetchQuerySnapshot=async()=>({rows:[{query:'fees',impressions:10,clicks:0,position:3}],evidence});
 const source=gscSource.slice(gscSource.indexOf('export async function refreshSearchEvidence')).replace('export ','');
 const run=new AsyncFunction('many','query','fetchQuerySnapshot','matchSearchSnapshot','project',source+';return refreshSearchEvidence(project);');
 const result=await run(many,query,fetchQuerySnapshot,matchSearchSnapshot,{id:27,gsc_site_url:evidence.property});assert.equal(result.updated,1);
 const records=await many('SELECT * FROM prompts ORDER BY id');assert.equal(records[0].origin_details.gscSnapshot.impressions,10);assert.equal(records[0].origin_details.impressions,300);assert.equal(records[1].origin_details.gscSnapshot,undefined);assert.equal(records[2].origin_details.gscSnapshot,undefined);
 }finally{await db.close();}
});
