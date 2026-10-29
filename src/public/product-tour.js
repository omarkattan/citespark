/* A read-only tour of the real controls. It never changes views or starts work. */
(() => {
  'use strict';
  const STEPS = [
    {title:'Welcome to Cited',copy:'Find out when AI names your business, which sources it uses, and what you can improve. This quick tour shows you the path from your first site to a useful report.',path:'About 2 minutes. Skip now and return with “Take a tour”.'},
    {title:'Start with your website',copy:'Add your domain, describe what your business does and choose your market. Cited suggests buyer questions for you to review.',path:'Add site → website and market',targets:['#addSiteBtn']},
    {title:'Bring in your search and traffic data',copy:'Connect Search Console to find relevant Google searches, and Analytics to see visits from AI assistants. You can connect these now or come back later.',path:'Settings → Connections',targets:['[data-view="connections"]','[data-section="settings"]']},
    {title:'Choose the questions that matter',copy:'Review suggested questions, improve their wording and pause anything irrelevant. Include the buying and comparison questions your customers would ask. Google search evidence is shown separately from AI results.',path:'Questions → review, edit or add',targets:['[data-section="questions"]']},
    {title:'Run your first measurement',copy:'Choose what to run, check the engines and estimated cost, then confirm. Running a measurement uses your plan’s answer checks. Confirm your email before your first run.',path:'Run menu → review cost → confirm',targets:['#runBtn']},
    {title:'Read the answers behind the numbers',copy:'Open Evidence to inspect the stored AI answers and source links. “Named” means your brand appeared in the answer. “Cited” means the answer linked to your website. Results appear after a measurement finishes.',path:'Evidence → AI answers',targets:['[data-view="answers"]','[data-section="evidence"]']},
    {title:'Turn findings into useful actions',copy:'Review each opportunity and its evidence. Record a specific change or the next investigation, then choose an owner. Use content briefs when you need help planning a page update.',path:'Opportunities → To do',targets:['[data-section="opportunities"]']},
    {title:'Prepare a report you can share',copy:'Choose the reporting dates and the recommendations to include. Review the evidence, save a fixed report version, then export a PDF. You’re ready to get started, and this tour is always here if you need it.',path:'Overview or Opportunities → Prepare report',targets:['#repPrepare','.overview-ctas a[href*="/report/prepare"]','[data-section="opportunities"]']}
  ];
  let instance;
  function create({userId,status,hasProject=()=>false,onAddSite=()=>{}}={}) {
    if (instance) return instance;
    const launcher=document.getElementById('takeTourBtn');
    if (!launcher) return null;
    const key=userId ? `cited.product-tour.v1.${userId}` : null;
    const read=()=>{try{return key?JSON.parse(localStorage.getItem(key)||'null'):null;}catch{return null;}};
    const write=value=>{try{if(key)localStorage.setItem(key,JSON.stringify(value));}catch{/* Storage is optional. */}};
    let saved=read(),step=0,previousFocus,previousScroll,frame,closed=true,sessionDismissed=false;
    const terminal=value=>value==='completed'||value==='skipped';
    const persist=async value=>{
      try {
        await fetch('/api/product-tour',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:value})});
      } catch {/* Dismiss immediately; the per-user browser record can sync later. */}
    };
    if(status==='pending'&&terminal(saved?.status))void persist(saved.status);
    const dialog=document.createElement('dialog');
    dialog.id='citedTour';dialog.setAttribute('aria-labelledby','tourTitle');dialog.setAttribute('aria-describedby','tourCopy');
    dialog.innerHTML=`<div class="tour-shade" aria-hidden="true"></div><div class="tour-spotlight" aria-hidden="true" hidden></div><div class="tour-card"><div class="tour-top"><span class="tour-step" aria-live="polite"></span><button class="tour-close" type="button" aria-label="Close tour">×</button></div><div class="tour-progress" aria-hidden="true">${STEPS.map(()=>'<span></span>').join('')}</div><h2 id="tourTitle" tabindex="-1"></h2><p class="tour-copy" id="tourCopy"></p><p class="tour-path"></p><div class="tour-footer"><button class="tour-skip" type="button">Skip tour</button><div class="tour-buttons"><button class="tour-back" type="button">Back</button><button class="tour-next" type="button">Next</button></div></div></div>`;
    document.body.appendChild(dialog);
    const el=selector=>dialog.querySelector(selector),card=el('.tour-card'),spot=el('.tour-spotlight'),shade=el('.tour-shade');
    const visible=node=>Boolean(node && !node.closest('[hidden]') && node.getClientRects().length && getComputedStyle(node).visibility!=='hidden');
    const target=()=> (STEPS[step].targets||[]).map(s=>document.querySelector(s)).find(visible);
    const position=()=>{
      if(closed)return;
      const width=window.innerWidth,height=window.innerHeight,pad=12,gap=16;
      const box=target()?.getBoundingClientRect();
      const w=card.offsetWidth,h=card.offsetHeight;
      let left=(width-w)/2,top=(height-h)/2,highlight=false;
      if(box && box.bottom>0 && box.top<height){
        left=Math.min(Math.max(pad,box.left),width-w-pad);
        if(box.bottom+gap+h<=height-pad){top=box.bottom+gap;highlight=true;}
        else if(box.top-gap-h>=pad){top=box.top-gap-h;highlight=true;}
        else {left=(width-w)/2;}
      }
      card.style.left=`${Math.max(pad,left)}px`;card.style.top=`${Math.max(pad,Math.min(top,height-h-pad))}px`;
      spot.hidden=!highlight;shade.hidden=highlight;
      if(highlight){
        const x=Math.max(4,box.left-5),y=Math.max(4,box.top-5);
        Object.assign(spot.style,{left:`${x}px`,top:`${y}px`,width:`${Math.max(0,Math.min(width-4,box.right+5)-x)}px`,height:`${Math.max(0,Math.min(height-4,box.bottom+5)-y)}px`});
      }
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(position);};
    function paint(){
      const item=STEPS[step];
      el('.tour-step').textContent=`Step ${step+1} of ${STEPS.length}`;
      el('#tourTitle').textContent=item.title;el('#tourCopy').textContent=item.copy;el('.tour-path').textContent=item.path;
      el('.tour-back').disabled=step===0;
      el('.tour-next').textContent=step===STEPS.length-1?(hasProject()?'Finish tour':'Add my first site'):step===0?'Show me around':'Next';
      el('.tour-skip').textContent=step===STEPS.length-1?'Close tour':'Skip tour';
      el('.tour-progress').querySelectorAll('span').forEach((node,i)=>node.classList.toggle('is-done',i<=step));
      write({status:'in_progress',step});
      target()?.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      position();card.scrollTop=0;el('#tourTitle').focus({preventScroll:true});
    }
    function cleanup(){
      closed=true;document.body.classList.remove('cited-tour-open');cancelAnimationFrame(frame);
      if(previousScroll)window.scrollTo({left:previousScroll.x,top:previousScroll.y,behavior:'instant'});
      const focus=previousFocus?.isConnected?previousFocus:launcher;focus.focus({preventScroll:true});
    }
    function finish(value='skipped',addSite=false){
      if(closed)return;
      sessionDismissed=true;saved={status:value};write(saved);void persist(value);
      closed=true;dialog.close();cleanup();if(addSite)onAddSite();
    }
    function start(resume=false){
      if(!closed||document.querySelector('dialog[open]'))return false;
      previousFocus=document.activeElement===document.body?launcher:document.activeElement;previousScroll={x:window.scrollX,y:window.scrollY};
      const progress=read();step=resume && progress?.status==='in_progress' && Number.isInteger(progress.step)?Math.max(0,Math.min(STEPS.length-1,progress.step)):0;
      closed=false;dialog.showModal();document.body.classList.add('cited-tour-open');paint();return true;
    }
    el('.tour-next').addEventListener('click',()=>{if(step===STEPS.length-1)finish('completed',!hasProject());else{step++;paint();}});
    el('.tour-back').addEventListener('click',()=>{if(step>0){step--;paint();}});
    el('.tour-close').addEventListener('click',()=>finish());el('.tour-skip').addEventListener('click',()=>finish());
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});
    dialog.addEventListener('close',()=>{if(!closed)finish();});
    // Native modal containment plus explicit cycling keeps keyboard focus in
    // the tour, including browsers that handle a programmatically focused h2 differently.
    dialog.addEventListener('keydown',event=>{
      if(event.key!=='Tab')return;
      const buttons=[...dialog.querySelectorAll('button:not(:disabled)')],first=buttons[0],last=buttons.at(-1),active=document.activeElement;
      if(event.shiftKey&&(active===first||!buttons.includes(active))){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&(active===last||!buttons.includes(active))){event.preventDefault();first.focus();}
    });
    window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);
    launcher.disabled=false;launcher.addEventListener('click',()=>start());
    instance={start,autoStart:()=>status==='pending'&&!sessionDismissed&&!terminal(read()?.status)&&start(true)};
    return instance;
  }
  window.CitedTour={create};
})();
