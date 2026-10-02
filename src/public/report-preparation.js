document.addEventListener('click',event=>{if(event.target.closest('[data-refresh]'))location.reload();});
const dirtyForms=new Set();
document.addEventListener('input',event=>{if(event.target.closest('form'))dirtyForms.add(event.target.closest('form'));});
window.addEventListener('beforeunload',event=>{if(dirtyForms.size){event.preventDefault();event.returnValue='';}});
async function reportRequest(url,options){const response=await fetch(url,options);const data=await response.json();if(!response.ok)throw Error(data.error||'Could not complete the request.');return data;}
function showCopy(panel,label,value){const box=document.createElement('section');box.className='preview-box';const heading=document.createElement('h4');heading.textContent=label;box.append(heading);const title=document.createElement('strong');title.textContent=value?.title||'Not included yet';box.append(title);const body=document.createElement('p');body.className='preview-copy';body.textContent=value?.notes||'';box.append(body);panel.append(box);}
document.addEventListener('submit',async event=>{
 const form=event.target.closest('form');if(!form)return;event.preventDefault();
 const card=form.closest('[data-rec]'),status=card.querySelector('[data-status]'),button=form.querySelector('button');button.disabled=true;
 try{await reportRequest(`/api/recommendations/${card.dataset.rec}/review-decision`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});dirtyForms.delete(form);card.querySelector('[data-preview-panel]').hidden=true;status.textContent='Decision saved. Preview the report update next. Reload this page to refresh the summary counts.';}
 catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-preview],[data-remove]');if(!button)return;
 const card=button.closest('[data-rec]'),status=card.querySelector('[data-status]'),panel=card.querySelector('[data-preview-panel]');button.disabled=true;
 try{
  if(button.hasAttribute('data-remove')){await reportRequest(`/api/recommendations/${card.dataset.rec}/report-note`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({include:false})});panel.hidden=true;status.textContent='Removed from the report. Task notes are preserved. Reload to refresh the summary counts.';button.hidden=true;return;}
  const data=await reportRequest(`/api/recommendations/${card.dataset.rec}/report-note-preview`);panel.replaceChildren();panel.hidden=false;
  const intro=document.createElement('p');intro.textContent='Preview uses saved content. Unsaved form edits are not included.';panel.append(intro);
  showCopy(panel,'Currently in the report',data.current);showCopy(panel,'Proposed report copy',data.proposed);
  if(data.canInclude && (!data.current||data.changed)){
   const save=document.createElement('button');save.textContent=data.current?'Confirm report update':'Include in report';panel.append(save);
   save.addEventListener('click',async()=>{save.disabled=true;try{await reportRequest(`/api/recommendations/${card.dataset.rec}/report-note`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({include:true,version:data.version})});panel.hidden=true;status.textContent='Report copy saved. Open the client report to review it. Reload this page to refresh summary counts.';}catch(error){status.textContent=error.message;}finally{save.disabled=false;}});
  }else{const note=document.createElement('p');note.textContent=data.canInclude?'The report copy matches the saved decision.':'Save a decision or note within the report length limit before including it.';panel.append(note);}
  const close=document.createElement('button');close.className='secondary';close.textContent='Close preview';close.addEventListener('click',()=>panel.hidden=true);panel.append(close);
 }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});

// Refresh only Analytics status. Never reload or replace unsaved recommendation forms.
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-report-sync-ga4]');if(!button||button.disabled)return;
 const status=document.querySelector('[data-traffic-status]'),coverage=document.querySelector('[data-traffic-coverage]');
 button.disabled=true;status.textContent='Syncing Analytics. Your recommendation edits stay here.';
 try{
  await reportRequest(`/api/projects/${button.dataset.reportSyncGa4}/sync-ga4`,{method:'POST'});
  const t=await reportRequest(`/api/projects/${button.dataset.reportSyncGa4}/traffic?days=90`);
  document.querySelector('[data-traffic-synced]').textContent=t.syncedAt||'Not recorded';
  const covered=t.coveredFrom&&t.coveredTo?`Stored data covers ${t.coveredFrom} to ${t.coveredTo}. `:'';
  coverage.textContent=t.state==='ready'?`${covered}The requested period is covered. Coverage does not verify lead quality or tracking accuracy.`:t.state==='partial'?`${covered}Coverage is still partial for ${t.from} to ${t.to}. Do not present it as a complete ${t.days}-day period.`:t.why||'Coverage could not be verified. Do not treat missing data as zero.';
  status.textContent=`Analytics sync finished. ${t.syncedAt?`Last successful sync: ${t.syncedAt}. `:''}Reopen the report to use the latest stored data. Existing PDF downloads do not update.`;
 }catch(error){status.textContent=`Analytics refresh could not be verified: ${error.message}. Recommendation edits are preserved. Retry before sharing.`;}
 finally{button.disabled=false;}
});
