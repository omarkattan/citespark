(()=>{
 const main=document.querySelector('[data-report-target]'),status=document.getElementById('reportStatus'),retry=document.getElementById('retry'),elapsed=document.getElementById('elapsed'),tip=document.getElementById('reportTip'),pulse=document.querySelector('.pulse');
 const tips=['“Not another dashboard. A to-do list.”','Start with the decision. Keep the evidence close.','A mention and a citation answer different questions. Report both.','Compare the same questions and engines before calling a difference a trend.'];
 let busy=false;
 async function load(){
  if(busy)return;busy=true;retry.hidden=true;pulse.hidden=false;
  const start=Date.now(),controller=new AbortController();let lastTip=0;
  status.textContent='Assembling your report from stored evidence…';elapsed.textContent='0 seconds elapsed';
  const timer=setInterval(()=>{const seconds=Math.floor((Date.now()-start)/1000);elapsed.textContent=seconds+' seconds elapsed';const next=Math.floor(seconds/9)%tips.length;if(next!==lastTip){tip.textContent=tips[next];lastTip=next;}if(seconds>=30)status.textContent='Still waiting for the report. Larger evidence sets can take longer. You can return to preparation below.';},1000);
  const timeout=setTimeout(()=>controller.abort(),120000);
  try{
   const response=await fetch(main.dataset.reportTarget,{signal:controller.signal,headers:{Accept:'text/html'},cache:'no-store'});
   if(response.redirected){const dest=new URL(response.url);if(dest.origin!==location.origin)throw Error('Unexpected report destination.');location.assign(dest.href);return;}
   if(!response.ok)throw Error('The report could not be opened ('+response.status+').');
   if(!response.headers.get('content-type')?.includes('text/html'))throw Error('The server did not return a report.');
   const html=await response.text();status.textContent='Report received. Opening your preview…';
   history.replaceState(null,'',main.dataset.reportTarget);
   document.open();document.write(html);document.close();
  }catch(error){status.textContent=error.name==='AbortError'?'This request took too long. Your saved evidence and selected recommendations are unchanged. Try again or return to preparation.':error.message+' Your saved evidence is unchanged. Try again or return to preparation.';retry.hidden=false;pulse.hidden=true;}
  finally{clearInterval(timer);clearTimeout(timeout);busy=false;}
 }
 retry.addEventListener('click',load);load();
})();
