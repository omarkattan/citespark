(()=>{
 const panel=document.querySelector('[data-report-snapshots]');if(!panel)return;
 const base=panel.dataset.reportSnapshots,button=panel.querySelector('[data-save-snapshot]'),status=panel.querySelector('[data-snapshot-status]'),list=panel.querySelector('[data-snapshot-list]');
 let busy=false,lastKey,lastId;
 async function request(url,options={}){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),120000);
  try{
   const response=await fetch(url,{...options,signal:controller.signal,cache:'no-store'});
   if(response.redirected)throw Error('Sign in again to access saved versions.');
   const data=await response.json();if(!response.ok)throw Error(data.error||'Saved versions are unavailable. Check the deployment and database migration.');return data;
  }finally{clearTimeout(timeout);}
 }
 function links(id){
  const span=document.createElement('span');
  for(const [label,suffix] of [['Full report',''],['Executive brief','?view=ceo']]){
   const a=document.createElement('a');a.textContent=label;a.href=base+'/'+encodeURIComponent(id)+suffix;a.target='_blank';a.rel='noopener';span.append(a,document.createTextNode(' '));
  }
  return span;
 }
 async function refresh(){
  try{
   const data=await request(base);list.replaceChildren();
   if(!data.snapshots.length){list.textContent='No saved report versions yet.';return;}
   const ul=document.createElement('ul');
   for(const row of data.snapshots){
    const li=document.createElement('li'),label=document.createElement('p');
    const period=row.period||{};
    label.textContent=new Date(row.created_at).toLocaleString()+' · '+(row.analysis_state==='included'?'Reviewed AI analysis included':'AI analysis not included')+' · AI measurement period: '+(period.from||'earliest available')+' to '+(period.to||'latest available');
    li.append(label,links(row.id));ul.append(li);
   }list.append(ul);
  }catch(error){list.textContent=error.message;}
 }
 button.addEventListener('click',async()=>{
  if(busy)return;
  if(typeof dirtyForms!=='undefined'&&dirtyForms.size){status.textContent='Save your recommendation edits and confirm any report-copy updates before saving a report version.';return;}
  const from=document.querySelector('[data-report-from]').value,to=document.querySelector('[data-report-to]').value;
  if(from&&to&&from>to){status.textContent='Choose a valid reporting period first.';return;}
  const key=base+':'+from+':'+to;
  // Keep the request ID on failure so a retry cannot duplicate a completed save.
  if(lastKey!==key){lastKey=key;lastId=null;}
  try{lastId=lastId||sessionStorage.getItem(key)||crypto.randomUUID();sessionStorage.setItem(key,lastId);}catch{lastId=lastId||crypto.randomUUID();}
  busy=true;button.disabled=true;const start=Date.now();
  const update=()=>status.textContent=`Saving a fixed copy of the current report… ${Math.floor((Date.now()-start)/1000)}s. No paid AI request.`;
  update();const timer=setInterval(update,1000);
  try{
   const saved=await request(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from,to,requestId:lastId})});
   clearInterval(timer);status.replaceChildren(document.createTextNode('Saved. Open and review this version before sharing. '),links(saved.id));
   try{sessionStorage.removeItem(key);}catch{}lastId=null;await refresh();
  }catch(error){status.textContent=(error.name==='AbortError'?'The save is taking longer than expected.':error.message)+' Check Saved versions below before retrying. Retrying uses the same save ID.';await refresh();}
  finally{clearInterval(timer);busy=false;button.disabled=false;}
 });
 refresh();
})();
