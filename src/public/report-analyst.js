document.addEventListener('click',event=>{
 const button=event.target.closest('[data-open-editor]');if(!button)return;
 const editor=document.getElementById('analysis-editor');if(!editor)return;
 editor.open=true;button.setAttribute('aria-expanded','true');
 editor.scrollIntoView({behavior:'smooth',block:'start'});
 editor.querySelector('textarea')?.focus({preventScroll:true});
});
document.addEventListener('toggle',event=>{
 if(event.target.id==='analysis-editor')document.querySelector('[data-open-editor]')?.setAttribute('aria-expanded',String(event.target.open));
},true);
let analystEditorDirty=false;
window.addEventListener('beforeunload',e=>{if(analystEditorDirty){e.preventDefault();e.returnValue='';}});
document.addEventListener('input',e=>{if(e.target.closest('[data-analysis-editor]'))analystEditorDirty=true;});
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-operation]');if(!button||button.disabled)return;
 if(analystEditorDirty){document.querySelector('#analyst-status').textContent='Save your draft edits before continuing.';return;}
 const buttons=[...document.querySelectorAll('[data-operation]')],status=document.querySelector('#analyst-status');
 const previous=buttons.map(b=>({button:b,disabled:b.disabled})),originalLabel=button.textContent;
 buttons.forEach(b=>b.disabled=true);button.setAttribute('aria-busy','true');
 button.textContent=['generate','regenerate'].includes(button.dataset.operation)?'Analysing evidence…':'Working…';
 status.setAttribute('aria-live','polite');status.scrollIntoView?.({block:'nearest',behavior:'smooth'});
 const generating=['generate','regenerate'].includes(button.dataset.operation),started=Date.now();
 const update=()=>status.textContent=generating?`Analysing saved evidence… ${Math.floor((Date.now()-started)/1000)} seconds. This can take up to 90 seconds after the evidence is prepared.`:button.dataset.operation==='recover'?'Rechecking the saved response. No new AI request…':'Saving your report selection…';
 update();const timer=setInterval(update,1000);
 try{
  const response=await fetch(document.querySelector('[data-analyst-base]').dataset.analystBase,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:button.dataset.operation,id:button.dataset.id,revision:Number(button.dataset.revision||0)})});
  if(response.redirected)throw Error('Your session may have expired. Sign in again, then refresh this page.');
  const result=await response.json();if(!response.ok)throw Error(result.error||'Could not complete the request.');
  clearInterval(timer);status.textContent='Request complete. Opening the updated analysis…';location.reload();
 }catch(error){clearInterval(timer);status.textContent=error.message+' Refresh to check whether a draft was saved before retrying.';previous.forEach(x=>x.button.disabled=x.disabled);button.textContent=originalLabel;button.removeAttribute('aria-busy');}
});

document.addEventListener('submit',async event=>{
 const form=event.target.closest('[data-analysis-editor]');if(!form)return;event.preventDefault();
 const status=form.querySelector('[data-edit-status]'),button=form.querySelector('[type=submit]');button.disabled=true;
 const operations=[...document.querySelectorAll('[data-operation]')].map(b=>({b,disabled:b.disabled}));operations.forEach(x=>x.b.disabled=true);
 status.textContent='Saving edited wording. No AI request…';
 const changes={findings:[...form.querySelectorAll('[data-finding]')].map(f=>Object.fromEntries([...f.querySelectorAll('[data-field]')].map(t=>[t.dataset.field,t.value]))),limitations:[...form.querySelectorAll('[data-limitation]')].map(t=>t.value)};
 try{
  const response=await fetch(document.querySelector('[data-analyst-base]').dataset.analystBase,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'edit',id:form.dataset.id,revision:Number(form.dataset.revision),changes})});
  if(response.redirected)throw Error('Your session may have expired. Copy your edits before signing in again.');
  const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save edits.');
  analystEditorDirty=false;status.textContent='Saved. Review the updated draft before including it.';location.reload();
 }catch(error){status.textContent=error.message+' Your edits remain in this form.';button.disabled=false;operations.forEach(x=>x.b.disabled=x.disabled);}
});
