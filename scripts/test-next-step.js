import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness(fetcher){
 const document=new JSDOM('<main></main>').window.document;
 const calls=[];
 const h=vm.createContext({document,$:id=>document.getElementById(id),state:{overview:{}},esc,dueLabel:()=>'',evidenceDetails:()=>'',highlight:esc,fetch:async(url,opts)=>{calls.push({url,...opts});return fetcher?fetcher():{ok:true,json:async()=>({notes:'Review https://example.com\nAdd the missing delivery detail',status:'open'})};}});
 vm.runInContext("const STATUS_LABEL={open:'To do'};"+app.slice(app.indexOf('const TYPE_LABEL'),app.indexOf('/**\n * Who is doing')),h);
 // Call handler directly so each assertion waits for its asynchronous work.
 vm.runInContext(app.slice(app.indexOf('async function handleNextStep'),app.indexOf("document.addEventListener('click', handleNextStep)")),h);
 document.querySelector('main').innerHTML=h.taskCard({id:42,status:'open',type:'content_gap',priority:25,effort:4,notes:'Existing notes <safe>',evidence:{prompt_id:7,prompt:'Buyer question',runs:6,own_rate:0}},true);
 const box=document.querySelector('[data-answers]');box.hidden=false;box.textContent='Stored answer stays open';
 const act=selector=>h.handleNextStep({target:document.querySelector(selector)});
 return {document,h,calls,act};
}
test('record control exposes existing notes safely and focuses the separate editor',async()=>{
 const {document,act,calls}=harness();await act('[data-next-open]');
 assert.equal(document.getElementById('next-editor-42').hidden,false);
 assert.equal(document.activeElement.id,'next-note-42');assert.equal(document.activeElement.value,'Existing notes <safe>');
 assert.equal(document.querySelector('safe'),null);assert.equal(calls.length,0);
});
test('saving sends notes only, preserves answer evidence and synchronises both note editors',async()=>{
 const {document,act,calls}=harness();await act('[data-next-open]');
 const input=document.getElementById('next-note-42');input.value='Review https://example.com\nAdd the missing delivery detail';await act('[data-next-save]');
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/recommendations/42');assert.equal(calls[0].method,'PATCH');
 assert.deepEqual(JSON.parse(calls[0].body),{notes:input.value});
 assert.equal(document.querySelector('[data-answers]').hidden,false);assert.match(document.querySelector('[data-answers]').textContent,/stays open/);
 assert.equal(document.getElementById('n-42').value,input.value);assert.equal(input.defaultValue,input.value);
 assert.equal(document.getElementById('next-summary-42').textContent,input.value);assert.match(document.getElementById('next-feedback-42').textContent,/saved/);
 assert.equal(document.querySelector('.status-chip').textContent,'To do');
});
test('cancel restores last saved text without sending anything',async()=>{
 const {document,act,calls}=harness();await act('[data-next-open]');document.getElementById('next-note-42').value='Unsaved';await act('[data-next-cancel]');
 assert.equal(document.getElementById('next-note-42').value,'Existing notes <safe>');assert.equal(calls.length,0);
});
test('failed response retains draft and existing saved notes and allows retry',async()=>{
 const {document,act}=harness(()=>({ok:false,json:async()=>({error:'Could not save'})}));await act('[data-next-open]');document.getElementById('next-note-42').value='Draft';await act('[data-next-save]');
 assert.equal(document.getElementById('next-note-42').value,'Draft');assert.equal(document.getElementById('next-editor-42').hidden,false);assert.equal(document.querySelector('[data-next-save]').disabled,false);
 assert.match(document.getElementById('next-feedback-42').textContent,/Could not save/);assert.equal(document.getElementById('next-summary-42').textContent,'Existing notes <safe>');
});
test('network failure restores controls and keeps the draft',async()=>{
 const {document,act}=harness(()=>{throw new Error('Network unavailable')});await act('[data-next-open]');document.getElementById('next-note-42').value='Keep this';await act('[data-next-save]');
 assert.equal(document.getElementById('next-note-42').disabled,false);assert.equal(document.getElementById('next-note-42').value,'Keep this');assert.match(document.getElementById('next-feedback-42').textContent,/Network unavailable/);
});
test('pending save blocks duplicate submissions and cancellation',async()=>{
 let release;const {document,act,calls}=harness(()=>new Promise(resolve=>release=resolve));await act('[data-next-open]');
 const pending=act('[data-next-save]');await act('[data-next-save]');await act('[data-next-cancel]');assert.equal(calls.length,1);assert.equal(document.getElementById('next-editor-42').hidden,false);
 release({ok:true,json:async()=>({notes:'Saved'})});await pending;assert.equal(document.querySelector('[data-next-save]').disabled,false);
});
test('clearing notes and returned markup remain safe',async()=>{
 const {document,act}=harness(()=>({ok:true,json:async()=>({notes:null})}));await act('[data-next-open]');document.getElementById('next-note-42').value='';await act('[data-next-save]');
 assert.equal(document.getElementById('next-summary-42').hidden,true);assert.equal(document.querySelector('[data-next-open]').textContent,'Record next step');
 const next=harness(()=>({ok:true,json:async()=>({notes:'<img src=x onerror=alert(1)>'})}));await next.act('[data-next-open]');await next.act('[data-next-save]');assert.equal(next.document.querySelector('img'),null);
});

test('saving and clearing notes updates the badge and assignment label without reload',async()=>{
 let notes=null;
 const {document,act}=harness(()=>({ok:true,json:async()=>({notes,assignee:null,due_date:null})}));
 const badge=document.querySelector('[data-task-notes-badge]');
 assert.equal(badge.hidden,false);
 await act('[data-next-open]');document.getElementById('next-note-42').value='';await act('[data-next-save]');
 assert.equal(badge.hidden,true);assert.equal(document.querySelector('[data-task-edit]').textContent,'Assign');
 notes='Next step recorded';await act('[data-next-open]');document.getElementById('next-note-42').value=notes;await act('[data-next-save]');
 assert.equal(badge.hidden,false);assert.equal(document.querySelector('[data-task-edit]').textContent,'Edit');
 assert.equal(document.querySelectorAll('[data-task-notes-badge]').length,1);
 assert.equal(document.querySelector('[data-answers]').hidden,false);
});
test('clearing notes keeps Edit when an assignee or due date remains',async()=>{
 for (const fields of [{assignee:'Reviewer',due_date:null},{assignee:null,due_date:'2026-10-01'}]) {
  const {document,act}=harness(()=>({ok:true,json:async()=>({notes:null,...fields})}));
  await act('[data-next-open]');document.getElementById('next-note-42').value='';await act('[data-next-save]');
  assert.equal(document.querySelector('[data-task-notes-badge]').hidden,true);
  assert.equal(document.querySelector('[data-task-edit]').textContent,'Edit');
 }
});
test('a failed save does not change the badge or assignment label',async()=>{
 const {document,act}=harness(()=>({ok:false,json:async()=>({error:'Save failed'})}));
 await act('[data-next-open]');document.getElementById('next-note-42').value='';await act('[data-next-save]');
 assert.equal(document.querySelector('[data-task-notes-badge]').hidden,false);
 assert.equal(document.querySelector('[data-task-edit]').textContent,'Edit');
});
