document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-operation]');if(!button||button.disabled)return;
 const buttons=[...document.querySelectorAll('[data-operation]')],status=document.querySelector('#analyst-status');
 buttons.forEach(b=>b.disabled=true);
 const generating=['generate','regenerate'].includes(button.dataset.operation),started=Date.now();
 const update=()=>status.textContent=generating?`Analysing saved evidence… ${Math.floor((Date.now()-started)/1000)} seconds. This can take up to 90 seconds after the evidence is prepared.`:'Saving your report selection…';
 update();const timer=setInterval(update,1000);
 try{
  const response=await fetch(document.querySelector('[data-analyst-base]').dataset.analystBase,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:button.dataset.operation,id:button.dataset.id})});
  if(response.redirected)throw Error('Your session may have expired. Sign in again, then refresh this page.');
  const result=await response.json();if(!response.ok)throw Error(result.error||'Could not complete the request.');
  clearInterval(timer);location.reload();
 }catch(error){clearInterval(timer);status.textContent=error.message+' Refresh to check whether a draft was saved before retrying.';buttons.forEach(b=>b.disabled=false);}
});
