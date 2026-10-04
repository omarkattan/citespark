import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reportPreparationHtml,preparationItem} from '../src/lib/report-preparation.js';
const row={id:1,project_id:28,title:'Transfer review',notes:'Internal old note',status:'open',review_decision:{stage:'ready',title:'Link options',page:'https://bank.example/app',evidence:'Answer 1',change:'Link hub'},selected_at:'2026-09-30',saved_title:'Old title',saved_notes:'Old copy'};
test('preparation identifies changed selected copies and missing fields without altering them',()=>{
 const item=preparationItem(row);assert.equal(item.selected,true);assert.equal(item.outdated,true);assert.ok(item.missing.includes('Completion checks'));assert.equal(item.saved_notes,'Old copy');assert.equal(preparationItem({...row,selected_at:null}).selected,false);
});
test('page exposes selected and unselected reviews with escaped editable values',()=>{
 const html=reportPreparationHtml({id:28,name:'<script>bad</script>'},[row,{...row,id:2,selected_at:null}]);
 assert.match(html,/1 selected · 1 changed copies/);assert.match(html,/Other reviewed decisions/);assert.doesNotMatch(html,/<script>bad/);assert.match(html,/not export blockers/);assert.match(html,/name="completion"/);
 assert.match(reportPreparationHtml({id:1,name:'Empty'},[]),/No recommendations selected/);
});
test('route checks project ownership before reading scoped recommendations and copies',async()=>{
 const src=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');const a=src.indexOf("app.get('/api/projects/:id/report/prepare'");const b=src.indexOf("app.get('/api/projects/:id/report',",a);const route=src.slice(a,b);
 assert.ok(route.indexOf('assertProject')<route.indexOf('await many'));assert.match(route,/WHERE r.project_id=\$1/);assert.match(route,/n.project_id=r.project_id/);assert.match(route,/\[project.id\]/);
});
test('UI fetches preview before publishing and rejects stale updates without losing drafts',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);const dom=new JSDOM(reportPreparationHtml({id:28,name:'Bank'},[row]),{runScripts:'outside-only',url:'https://cited.ae/api/projects/28/report/prepare'});const w=dom.window;let calls=[];
 w.fetch=async(url,options)=>{calls.push({url,options});return options?{ok:false,json:async()=>({error:'The action changed. Open preview again.'})}:{ok:true,json:async()=>({current:{title:'Old',notes:'Old copy'},proposed:{title:'<img src=x>',notes:'<script>bad</script>'},canInclude:true,changed:true,version:'v1'})};};
 w.eval(readFileSync(new URL('../src/public/report-preparation.js',import.meta.url),'utf8'));
 const settle=()=>new Promise(r=>setTimeout(r,0));w.document.querySelector('[data-preview]').click();await settle();
 assert.equal(calls.length,1);assert.equal(calls[0].options,undefined);const panel=w.document.querySelector('[data-preview-panel]');assert.equal(panel.querySelector('img,script'),null);
 panel.querySelector('button').click();await settle();assert.equal(JSON.parse(calls[1].options.body).version,'v1');assert.match(w.document.querySelector('[data-status]').textContent,/action changed/);assert.equal(w.document.querySelector('[name=change]').value,'Link hub');dom.window.close();
});

test('Analytics preflight distinguishes partial, covered, missing and disconnected data',()=>{
 const project={id:28,name:'Bank'};
 for(const [state,expected] of [['partial',/Requested 2026-07-04 to 2026-10-01/],['ready',/requested period is covered/],['needs_sync',/Sync first/],['error',/Sync first/]]){
 const html=reportPreparationHtml(project,[],{state,connected:true,from:'2026-07-04',to:'2026-10-01',coveredFrom:'2026-07-04',coveredTo:'2026-09-30',days:90,why:'Sync first'});
 assert.match(html,expected);assert.match(html,/data-report-sync-ga4="28"/);assert.ok(html.indexOf('Analytics report coverage')<html.indexOf('<h2>Selected recommendations'));
 }
 const html=reportPreparationHtml(project,[],{state:'disconnected',why:'<img src=x>'});assert.doesNotMatch(html,/data-report-sync-ga4|<img/);assert.match(html,/Review Analytics connection/);
});
test('Analytics refresh rechecks coverage and preserves dirty forms on success, partial coverage and failure',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);
 for(const result of ['ready','partial','failure']){
 const dom=new JSDOM(reportPreparationHtml({id:28,name:'Bank'},[row],{state:'partial',connected:true}),{runScripts:'outside-only',url:'https://cited.ae/api/projects/28/report/prepare'});const w=dom.window;const calls=[];
 w.fetch=async(url,options)=>{calls.push({url,options});return {ok:result!=='failure',json:async()=>result==='failure'?{error:'Permission expired'}:{state:result,from:'2026-07-04',to:'2026-10-01',coveredFrom:'2026-07-04',coveredTo:result==='ready'?'2026-10-01':'2026-09-30',days:90,syncedAt:'2026-10-02'}};};
 w.eval(readFileSync(new URL('../src/public/report-preparation.js',import.meta.url),'utf8'));
 const edit=w.document.querySelector('[name=change]');edit.value='Unsaved edit';edit.dispatchEvent(new w.Event('input',{bubbles:true}));
 const button=w.document.querySelector('[data-report-sync-ga4]');button.click();assert.equal(button.disabled,true);button.click();await new Promise(r=>setTimeout(r,0));
 assert.equal(calls[0].url,'/api/projects/28/sync-ga4');assert.equal(calls[0].options.method,'POST');assert.equal(calls.length,result==='failure'?1:2);
 assert.equal(edit.value,'Unsaved edit');assert.equal(button.disabled,false);
 if(result==='failure')assert.match(w.document.querySelector('[data-traffic-status]').textContent,/Permission expired/);
 else {assert.equal(calls[1].url,'/api/projects/28/traffic?days=90&report=1');assert.match(w.document.querySelector('[data-traffic-coverage]').textContent,result==='ready'?/requested period is covered/:/still partial/);assert.equal(w.document.querySelector('[data-traffic-synced]').textContent,'2026-10-02');}
 dom.window.close();
 }
});

test('Search Console preparation separates property provenance, missing dates and historical report scope',()=>{
 const project={id:28,name:'Bank'},property='sc-domain:bank.example';
 const q=(prop,date,snapshotProp=prop)=>({origin_details:{property:prop,gscSnapshot:{property:snapshotProp,fetchedAt:date}}});
 const search={connected:true,siteUrl:property,questions:[q(property,'2026-10-01'),q(property,'2026-09-01'),q(property,'bad-date'),q('sc-domain:other.example','2026-10-01'),q(property,'2026-10-01','sc-domain:old.example')]};
 const html=reportPreparationHtml(project,[],{},search);
 assert.match(html,/2 \/ 5 have dated evidence/);assert.match(html,/1 question has a different/);assert.match(html,/from 2026-09-01 to 2026-10-01/);assert.match(html,/not the Google search reporting period/);assert.match(html,/does not certify the report/);assert.ok(html.indexOf('Search Console evidence')<html.indexOf('Analytics report coverage'));
 assert.match(reportPreparationHtml(project,[],{}, {...search,connected:false}),/not connected/);
 assert.match(reportPreparationHtml(project,[],{}, {...search,siteUrl:null}),/Choose a Search Console property/);
 assert.match(reportPreparationHtml(project,[],{}, {...search,questions:[]}),/No active Search Console-derived questions/);
 assert.doesNotMatch(reportPreparationHtml(project,[],{}, {...search,siteUrl:'<img src=x>'}),/<img/);
 assert.match(reportPreparationHtml(project,[],{},null),/could not be checked/);
});

test('preparation links go directly to the correct source on the same project',()=>{
 const html=reportPreparationHtml({id:31,name:'Arada'},[],{state:'disconnected'},{connected:true,siteUrl:'https://www.arada.com/',questions:[]});
 assert.match(html,/href="\/app\?site=31&amp;source=gsc">Review Search Console/);
 assert.match(html,/href="\/app\?site=31&amp;source=analytics">Review Analytics connection/);
});

test('opening analyst page immediately shows progress without making a paid request',async()=>{
 const {JSDOM}=await import(process.env.JSDOM_MODULE);
 const dom=new JSDOM('<div class="toolbar"><a data-analyst-link href="/api/projects/31/report/analyst">AI report analysis</a></div>',{runScripts:'outside-only',url:'https://cited.ae'});
 const w=dom.window;w.fetch=()=>assert.fail('Opening feedback must not make an API request');
 w.eval(readFileSync(new URL('../src/public/report-preparation.js',import.meta.url),'utf8'));
 w.document.addEventListener('click',e=>e.preventDefault());
 const link=w.document.querySelector('a');link.click();
 assert.equal(link.textContent,'Opening AI analysis…');
 assert.match(w.document.querySelector('#analyst-opening-status').textContent,/does not generate a paid draft/);
 w.dispatchEvent(new w.Event('pageshow'));assert.equal(link.textContent,'AI report analysis');assert.equal(w.document.querySelector('#analyst-opening-status'),null);
 dom.window.close();
});
