import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reportNoteDraft,reportNotePreview} from '../src/lib/report-note.js';
const rec={id:1,project_id:28,title:'Invisible for: transfers',notes:'Old advice: create a new page.',review_decision:{stage:'ready',title:'Link to transfer options',page:'https://bank.test/app',evidence:'Answer 12',change:'Link the existing hub.',reviewed_at:'2026-09-30'}};
test('reviewed copy uses short title and current decision without superseded working notes',()=>{
 const copy=reportNoteDraft(rec);assert.equal(copy.title,rec.review_decision.title);assert.match(copy.notes,/Link the existing hub/);assert.doesNotMatch(copy.notes,/Old advice/);assert.equal(rec.notes,'Old advice: create a new page.');
});
test('legacy notes remain available before a decision and empty notes cannot be included',()=>{
 assert.equal(reportNoteDraft({...rec,review_decision:{}}).notes,rec.notes);
 assert.equal(reportNotePreview({...rec,review_decision:{},notes:''}).canInclude,false);
});
test('freshness compares content and preserves existing copies until explicitly updated',()=>{
 const saved={title:'Old title',notes:'Old published note'};
 const a=reportNotePreview(rec,saved);assert.equal(a.changed,true);assert.deepEqual(a.current,saved);
 assert.equal(reportNotePreview(rec,a.proposed).changed,false);
 assert.equal(reportNotePreview({...rec,notes:'Internal-only edits'},saved).version,a.version);
 assert.notEqual(reportNotePreview({...rec,review_decision:{...rec.review_decision,change:'Updated'}},saved).version,a.version);
 assert.notEqual(reportNotePreview(rec,{...saved,notes:'Another editor updated'}).version,a.version);
});
function route(method,path,args){const src=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');const prefix=`app.${method}('${path}', requireAuth, wrap(async(req,res)=>{`;const start=src.indexOf(prefix)+prefix.length;assert.ok(start>=prefix.length);return new (Object.getPrototypeOf(async function(){}).constructor)(...args,src.slice(start,src.indexOf('\n}));',start)));}
test('preview endpoint is tenant scoped and reads without writes',async()=>{
 const fn=route('get','/api/recommendations/:recId/report-note-preview',['req','res','one','reportNotePreview']);let status=200,result;
 const res={status(n){status=n;return this},json(v){result=v;return this}};
 const req={params:{recId:1},session:{orgId:7}};
 await fn(req,res,async(sql,args)=>{assert.match(sql,/p.org_id=\$2/);assert.deepEqual(args,[1,7]);return null},reportNotePreview);assert.equal(status,404);
 await fn(req,res,async(sql)=>sql.includes('JOIN projects')?rec:{title:'Saved',notes:'Old'},reportNotePreview);assert.equal(result.changed,true);assert.equal(result.proposed.title,'Link to transfer options');
});
test('publish rejects unpreviewed or changed content and snapshots only the approved copy',async()=>{
 const fn=route('post','/api/recommendations/:recId/report-note',['req','res','one','query','reportNotePreview']);let status,result,writes=[];
 const saved={title:'Saved',notes:'Old'};
 const one=async(sql)=>sql.includes('JOIN projects')?rec:saved;
 async function invoke(body){status=200;const res={status(n){status=n;return this},json(v){result=v;return this}};await fn({params:{recId:1},session:{orgId:7},body},res,one,async(...args)=>writes.push(args),reportNotePreview);}
 await invoke({include:true});assert.equal(status,409);assert.equal(writes.length,0);
 await invoke({include:true,version:reportNotePreview(rec,null).version});assert.equal(status,409);assert.equal(writes.length,0);
 await invoke({include:true,version:reportNotePreview(rec,saved).version});assert.equal(status,200);assert.equal(writes.length,1);assert.equal(writes[0][1][2],'Link to transfer options');assert.doesNotMatch(writes[0][1][3],/Old advice/);
 await invoke({include:false});assert.equal(result.included,false);assert.match(writes[1][0],/DELETE FROM report_review_notes/);
});
test('preview UI escapes saved and proposed copy and requires explicit confirmation',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);const dom=new JSDOM('<div id="report-controls-1"><button data-report-preview="1">Preview</button><div data-report-preview-panel hidden></div></div>',{runScripts:'outside-only'});
 const {window:w}=dom;w.state={projectId:28};w.esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');w.toast=()=>{};
 let requests=0;w.fetch=async()=>{requests++;return {ok:true,json:async()=>({...reportNotePreview(rec,{title:'<img src=x onerror=alert(1)>',notes:'Old'}),proposed:{title:'Safe title',notes:'<script>bad()</script>'}})}};
 const src=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');w.eval(src.slice(src.indexOf('// Fetch the saved decision, never unsaved form edits')));
 w.document.querySelector('[data-report-preview]').click();await new Promise(r=>setTimeout(r,0));
 const panel=w.document.querySelector('[data-report-preview-panel]');assert.equal(panel.hidden,false);assert.equal(panel.querySelector('script,img'),null);assert.equal(requests,1);assert.ok(panel.querySelector('[data-version]'));assert.match(panel.textContent,/Old/);
 panel.querySelector('[data-report-preview-cancel]').click();assert.equal(panel.hidden,true);dom.window.close();
});
