(()=>{
 const panel=document.querySelector('[data-analysis-check]');if(!panel)return;
 const status=panel.querySelector('[data-analysis-inclusion]'),button=panel.querySelector('[data-recheck-analysis]');
 let version=0,controller;
 const messages={
  included:'Included: reviewed AI analysis matches the current report evidence.',
  draft:'Not included: a current draft is ready for review. Open AI report analysis, check its findings, then include it.',
  stale:'Not included: the saved analysis no longer matches the current evidence or analysis requirements. Wording edits alone do not refresh it. Open AI report analysis to prepare a current draft.',
  none:'Not included: no AI analysis has been generated. The report still contains its measured results and selected recommendations.',
  failed:'Not included: the latest analysis attempt failed. Open AI report analysis to review the saved attempt before requesting another draft.',
  generating:'Not included yet: an analysis request was started. Check again shortly. If it remains unfinished, review the latest attempt in AI report analysis.'
 };
 async function check(){
  const request=++version;controller?.abort();controller=new AbortController();const currentController=controller;
  const from=document.querySelector('[data-report-from]').value,to=document.querySelector('[data-report-to]').value;
  if(from&&to&&from>to){status.textContent='Choose a valid reporting period before checking analysis inclusion.';button.disabled=false;return;}
  const params=new URLSearchParams();if(from)params.set('from',from);if(to)params.set('to',to);
  status.textContent='Checking whether reviewed AI analysis is included…';button.disabled=true;
  const timeout=setTimeout(()=>currentController.abort(),90000);
  try{
   const response=await fetch(panel.dataset.analysisCheck+(params.size?'?'+params:''),{signal:controller.signal,cache:'no-store'});
   if(response.redirected)throw Error('Please sign in again to check analysis inclusion.');
   if(!response.ok)throw Error('Analysis inclusion could not be verified. Open AI report analysis before sharing.');
   const data=await response.json();if(request!==version)return;
   if(!messages[data.state])throw Error('Analysis inclusion could not be verified. Try checking again.');
   status.textContent=messages[data.state]+(data.state==='included'?` Draft ${data.draftId}, wording version ${data.revision}.`:'');
  }catch(error){if(request===version)status.textContent=error.name==='AbortError'?'The inclusion check timed out. Check again or open AI report analysis before sharing.':error.message;}
  finally{clearTimeout(timeout);if(request===version)button.disabled=false;}
 }
 button.addEventListener('click',check);
 document.addEventListener('change',event=>{if(event.target.matches('[data-report-from],[data-report-to]'))check();});
 // Mutations can change the evidence. Invalidate promptly, without touching unsaved forms.
 document.addEventListener('click',event=>{
  if(!event.target.closest('[data-report-sync-ga4],[data-remove],[data-preview-panel] button'))return;
  ++version;controller?.abort();button.disabled=false;
  status.textContent='Evidence may have changed. When your update finishes, check analysis inclusion again before sharing.';
 });
 window.addEventListener('pageshow',check);
})();
