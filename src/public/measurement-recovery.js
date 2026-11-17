(() => {
 const button=document.querySelector('[data-recovery]'),box=document.querySelector('[data-recovery-status]');
 if(!button||!box)return;
 const base=button.dataset.recovery;
 button.onclick=async()=>{
  button.disabled=true;box.textContent='Checking the saved measurement and remaining checks…';
  try {
   const r=await fetch(base),p=await r.json();if(!r.ok||p.blocked)throw new Error(p.error||p.reason);
   if(p.alreadyRecovered){box.textContent=p.reason+' ';const a=document.createElement('a');a.href=base.replace(/\/\d+\/recovery$/,`/${Number(p.measurementId)}`);a.textContent=`Open recovery measurement #${p.measurementId}`;box.append(a);return;}
   box.replaceChildren();const text=document.createElement('p');
   text.textContent=`Keep ${p.retained} saved records and request ${p.retry} checks from providers and restore ${p.replay||0} from saved provider responses. Estimated provider cost: $${Number(p.estimatedCost).toFixed(2)}. This creates a linked recovery measurement under the original settings. Existing answers and timestamps remain unchanged.`;box.append(text);
   const confirm=document.createElement('button');confirm.textContent=`Recover ${p.unresolved} unresolved checks`;box.append(confirm);
   confirm.onclick=async()=>{confirm.disabled=true;try{
    const result=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmedRetry:p.retry})});
    const d=await result.json();if(!result.ok)throw new Error(d.error);
    box.textContent=d.alreadyRecovered?'A recovery already exists. Reload the archive to view it.':'Recovery started. You can leave this page. Open Cited to follow progress.';
    const a=document.createElement('a');a.href='/app?site='+button.dataset.project;a.textContent='Open measurement progress';box.append(document.createElement('br'),a);
   }catch(error){box.textContent=error.message;button.disabled=false;}};
  }catch(error){box.textContent=error.message;}finally{button.disabled=false;}
 };
})();

(() => {
 const button=document.querySelector('[data-reanalyse]'),box=document.querySelector('[data-reanalysis-status]');if(!button||!box)return;
 button.onclick=async()=>{button.disabled=true;box.textContent='Reviewing saved answers with the versioned bilingual names…';
  try{const response=await fetch(button.dataset.reanalyse,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),result=await response.json();
   if(!response.ok)throw Error(result.error);box.textContent=`Saved a separate bilingual reanalysis for ${result.entities.length} entities. No provider requests were made. Original measurement scores and settings are unchanged.`;
  }catch(error){box.textContent=error.message;}finally{button.disabled=false;}
 };
})();
