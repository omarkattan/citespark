const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=id=>({chatgpt:'ChatGPT',perplexity:'Perplexity',gemini:'Gemini',claude:'Claude',ai_mode:'Google AI Mode',ai_overview:'Google AI Overviews'}[id]||id);
let projectId=Number(new URLSearchParams(location.search).get('site'))||null,billing,me,context,pollTimer,preparing=false,reportVisible=false;
const safeLink=(url,title)=>{try{const u=new URL(url);return ['https:','http:'].includes(u.protocol)?`<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(title||url)}</a>`:esc(title||url);}catch{return esc(title||url);}};
async function api(path,body){const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(response.status===401){location.assign('/login');throw new Error('Please sign in.');}const value=await response.json();if(!response.ok){const failure=new Error(value.error||'This step could not finish. Please try again.');failure.status=response.status;throw failure;}return value;}
function revealNotice(node){node.tabIndex=-1;node.focus({preventScroll:true});node.scrollIntoView?.({block:'center',behavior:'smooth'});}
function error(e){const message=e.message||String(e);$('error').textContent=message;const target=$('run-error')||$('error');$('error').hidden=target!==$('error');target.textContent=message;target.hidden=false;revealNotice(target);}
function clearError(){$('error').hidden=true;if($('run-error'))$('run-error').hidden=true;}
function upgrade(){return `<section class="panel upgrade"><h2>See what changes next.</h2><p>Keep monitoring your visibility, compare more AI engines and markets, and work through a wider action plan.</p><a class="button" href="/app?view=billing${projectId?'&site='+projectId:''}">Explore paid plans</a></section>`;}
function advanced(){return billing.advanced?`<a class="button secondary" href="/app?mode=advanced&site=${projectId}">Open advanced workspace</a> <a class="button secondary" href="/quick-start?new=1">New Quick Start</a>`:'';}
function renderVerification(){
 const top=$('verify'),inline=$('run-verify');
 top.hidden=true;top.innerHTML='';if(inline){inline.hidden=true;inline.innerHTML='';}
 if(me?.emailVerified!==false)return;
 const target=inline||top;target.hidden=false;
 target.innerHTML='<strong>Confirm your email to create your report.</strong><p>Open the confirmation link in your inbox, then come back here. Check your spam folder too. Your questions are saved.</p><button type="button" class="secondary" id="resend">Resend confirmation email</button> <button type="button" class="secondary" id="verified">I’ve confirmed my email</button><p id="verify-status" role="status"></p>';
 $('resend').onclick=()=>act($('resend'),async()=>{await api('/api/verify/resend',{});$('verify-status').textContent='Confirmation email sent. Check your inbox and spam folder.';});
 $('verified').onclick=()=>act($('verified'),async()=>{if(await verify()){if(!$('run'))await load();else{$('run').focus();}}else throw new Error('Email confirmation is still pending. Open the link in your email, then try again.');});
}
async function verify(){me=await api('/api/me');renderVerification();return me.emailVerified!==false;}

async function act(button,fn){clearError();button.disabled=true;try{await fn();}catch(e){error(e);}finally{button.disabled=false;}}
const country=code=>{try{return new Intl.DisplayNames(['en'],{type:'region'}).of(code);}catch{return code;}};
function businessFields(p={}){return `<div class="two"><div><label for="brand">Business name</label><input id="brand" required maxlength="150" value="${esc(p.brand_name)}"></div><div><label for="category">Products or services</label><input id="category" required maxlength="500" value="${esc(p.category)}"></div><div><label for="market">Customers’ country</label><select id="market">${window.countryOptions(p.market||window.DEFAULT_COUNTRY)}</select></div><div><label for="city">City or area</label><input id="city" placeholder="Optional" value="${esc(p.location_name)}"></div></div><label for="language">Question language</label><select id="language"><option value="en" ${p.language==='ar'?'':'selected'}>English</option><option value="ar" ${p.language==='ar'?'selected':''}>Arabic</option></select><label for="customer">Who you serve</label><textarea id="customer">${esc(p.qualifier)}</textarea>`;}
function fields(){return {brandName:$('brand').value.trim(),category:$('category').value.trim(),market:$('market').value,language:$('language').value,qualifier:$('customer').value.trim(),locationName:$('city').value.trim()};}
const domainKey=value=>String(value||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/.*$/,'');
async function resumeDomain(domain){
 const projects=await api('/api/projects');
 const existing=projects.find(p=>domainKey(p.domain)===domainKey(domain));
 if(!existing)return false;
 projectId=existing.id;history.replaceState({},'','/quick-start?site='+projectId);clearError();await load();return true;
}
async function createProject(details){
 let d;
 try{d=await api('/api/projects',{quickStart:true,...details,competitors:[]});}
 catch(e){if(e.status===409&&await resumeDomain(details.domain))return;throw e;}
 projectId=d.project.id;history.replaceState({},'','/quick-start?site='+projectId);await load();
}
function setup(){
 reportVisible=false;
 $('content').innerHTML=`<div class="intro"><h1>Would AI recommend your business?</h1><p class="lead">Enter your website. We’ll find the buyer questions worth checking and prepare your first report.</p><form id="setup" class="panel"><label for="domain">Your website</label><input id="domain" required placeholder="yourbusiness.com" autocomplete="url" inputmode="url"><div class="actions"><button id="discover" type="submit">Continue</button></div><p class="muted" id="discovery-note">${billing.advanced?'Quick Start uses 20 questions across ChatGPT and Perplexity.':'Free report · No card required'}</p></form></div>`;
 $('setup').onsubmit=e=>{e.preventDefault();act($('discover'),async()=>{
  const domain=$('domain').value.trim();if(!domain)throw new Error('Enter your website first.');
  $('discover').textContent='Checking your saved projects…';
  if(await resumeDomain(domain))return;
  $('discover').textContent='Reading your website…';$('discovery-note').textContent='Finding your services and customers. This can take a minute.';
  let d;try{d=await api('/api/discover',{domain});}catch{manualBusiness(domain);return;}
  if(!d.brandName||!d.category){manualBusiness(d.domain||domain,d);return;}
  $('discover').textContent='Preparing your questions…';
  await createProject({domain:d.domain||domain,brandName:d.brandName,category:d.category,market:d.market||window.DEFAULT_COUNTRY,language:'en',qualifier:(d.customerSuggestions||[]).join('; ')||d.qualifier||''});
 }).finally(()=>{if($('discover')){$('discover').textContent='Continue';$('discovery-note').textContent='Your website is ready to try again.';}});};
}
function manualBusiness(domain,d={}){
 $('content').innerHTML=`<h1>Tell us a little about your business.</h1><p>We couldn’t read enough from ${esc(domain)}. Add the details below so we can prepare useful questions.</p><form id="manual" class="panel">${businessFields({brand_name:d.brandName,category:d.category,market:d.market})}<button id="prepare" type="submit">Prepare my questions</button></form>`;
 $('manual').onsubmit=e=>{e.preventDefault();act($('prepare'),()=>createProject({domain,...fields()}));};
}
async function prepareQuestions(){
 if(context.questions.length===20)return questions();
 $('content').innerHTML='<h1>Preparing your buyer questions.</h1><p class="lead">Finding 20 questions for your business and market. No answer checks have started yet.</p><progress aria-label="Preparing questions"></progress>';
 try {
  const d=await api(`/api/projects/${projectId}/quick-start/suggestions`,{});
  if(d.questions.length!==20)throw new Error('We couldn’t finish your question set yet. Please try again. No answer checks have started.');
  await api(`/api/projects/${projectId}/quick-start/questions`,{questions:d.questions});
  context.questions=d.questions.map(text=>({text}));questions();
 } catch(e){error(e);$('content').innerHTML='<h1>Your business is saved.</h1><p>We still need to finish preparing your questions.</p><button id="retry-questions">Try again</button>';$('retry-questions').onclick=()=>act($('retry-questions'),prepareQuestions);}
}
function questions(){
 reportVisible=false;
 const p=context.project,qs=context.questions;
 $('content').innerHTML=`<h1>${context.measurement?'Prepare your next report.':'Your first report is ready to run.'}</h1><p class="lead">We’ll check whether AI recommends ${esc(p.brand_name)} when buyers look for ${esc(p.category)}.</p><section class="panel"><div class="business-summary"><div><strong>${esc(p.brand_name)}</strong><p>${esc(p.location_name||country(p.market))} · ${p.language==='ar'?'Arabic':'English'} questions</p></div><button class="text-button" id="edit-business">Edit business details</button></div><form id="business-edit" hidden>${businessFields(p)}<div class="actions"><button id="save-profile" type="submit">Update details and questions</button><button id="cancel-profile" type="button" class="secondary">Cancel</button></div></form><div id="ready"><h2>20 buyer questions, already selected.</h2><p>For example:</p><ul class="question-samples">${qs.slice(0,3).map(q=>`<li dir="auto">${esc(q.text)}</li>`).join('')}</ul><details id="question-editor"><summary>Edit all 20 questions or ask AI</summary><p class="muted">Optional. These are suggested buying questions, not measured search volumes.</p>${qs.map((q,i)=>`<label for="q${i}">${i+1}. Question</label><textarea id="q${i}" data-question maxlength="500" dir="auto">${esc(q.text)}</textarea>`).join('')}</details><div id="question-ai"></div><div id="ready-email"></div><div id="run-verify" class="notice" hidden></div><div id="run-error" class="notice" role="alert" hidden></div><div class="actions"><button id="run">${billing.advanced?'Create my report':context.claim?'Upgrade to run another report':'Create my free report'}</button></div><p class="muted">20 questions · ChatGPT + Perplexity · One scan${billing.advanced?' · Uses your plan’s checks': ' · No card required'}</p></div></section>`;
 emailControl($('ready-email'));
 aiEditor($('question-ai'),'questions',()=>[...document.querySelectorAll('[data-question]')].map(el=>el.value.trim()),items=>{items.forEach((value,i)=>{$('q'+i).value=value;});$('question-editor').open=true;});
 renderVerification();
 $('edit-business').onclick=()=>{$('business-edit').hidden=false;$('ready').hidden=true;$('edit-business').hidden=true;};
 $('cancel-profile').onclick=()=>{$('business-edit').hidden=true;$('ready').hidden=false;$('edit-business').hidden=false;};
 $('business-edit').onsubmit=e=>{e.preventDefault();act($('save-profile'),async()=>{$('save-profile').textContent='Updating your questions…';await api(`/api/projects/${projectId}/quick-start/profile`,fields());await load();}).finally(()=>{if($('save-profile'))$('save-profile').textContent='Update details and questions';});};
 $('run').onclick=()=>act($('run'),async()=>{
  if(context.claim&&!billing.advanced){location.assign('/app?view=billing&site='+projectId);return;}
  $('run').textContent='Checking your account…';
  if(!(await verify()))throw new Error('Confirm your email first. Your questions remain here.');
  if(context.measurement||context.claim){
   if(!billing.advanced)throw new Error('Your free report has been used. Upgrade to run another scan.');
   const scope=await api(`/api/projects/${projectId}/run-scope`);
   if(!window.confirm(`Run another scan using ${scope.checksAll} checks from your plan? Estimated AI usage: $${Number(scope.costAll||0).toFixed(2)}. Saving edits alone does not run a scan.`))return;
  }
  $('run').textContent='Starting your report…';
  const questions=[...document.querySelectorAll('[data-question]')].map(el=>el.value.trim());
  await api(`/api/projects/${projectId}/quick-start/questions`,{questions});
  await api(`/api/projects/${projectId}/run`,{});progressDismissed=false;waiting();await poll();
 }).finally(()=>{if($('run'))$('run').textContent=billing.advanced?'Create my report':'Create my free report';});
}
function waiting(){ reportVisible=false; $('content').innerHTML=`<h1>Preparing your first report.</h1><p class="lead">We’re collecting AI answers, checking mentions and citations, then preparing suggested next actions.</p><section class="panel"><p id="status">Starting your scan…</p><progress id="progress"></progress><p class="muted">This can take several minutes. You can return to this page later.</p></section>`;}
async function poll(){
 clearTimeout(pollTimer);
 try{const s=await api(`/api/projects/${projectId}/cycle-status`);
 if(['starting','asking','thinking'].includes(s.phase))showProgress(s);else closeProgress();
 if(s.phase==='thinking'){preparing=true;if(!reportVisible)await report();pollTimer=setTimeout(poll,5000);return;}
 if(['starting','asking'].includes(s.phase)){if(!$('status'))waiting();$('status').textContent=s.phase==='thinking'?'Reviewing answers and preparing next actions…':`${s.done||0} of ${s.total||40} checks processed`;$('progress').max=s.total||40;$('progress').value=s.done||0;pollTimer=setTimeout(poll,2500);return;}
 if(s.phase==='failed'){preparing=false;error(s.error||'The scan stopped before finishing. Available results are shown below.');await report();return;}
 if(s.phase==='done'){preparing=false;await report();return;}
 // The process may have restarted. Durable batch status takes precedence over an empty in-memory map.
 context=await api(`/api/projects/${projectId}/quick-start`);
 if(context.measurement?.status==='running'){if(Date.now()-new Date(context.measurement.started_at).getTime()>20*60*1000){error('This scan is taking longer than expected. Saved evidence is shown below. Contact support before starting another scan.');await report();return;}if(!$('status'))waiting();$('status').textContent='The scan is still being prepared. Checking saved progress…';pollTimer=setTimeout(poll,5000);return;}
 if(context.claim&&!context.measurement){error('The scan was interrupted before results were saved. Please contact support so we can restore the free report.');}
 preparing=false;
 if(context.measurement||context.claim)await report();else await prepareQuestions();
 }catch(e){error(e);pollTimer=setTimeout(poll,5000);}
}
async function report(){
 const [o,rows,recs,rivals]=await Promise.all([api(`/api/projects/${projectId}/overview`),api(`/api/projects/${projectId}/prompts`),api(`/api/projects/${projectId}/recommendations?status=active`).catch(()=>({tasks:[]})),api(`/api/projects/${projectId}/competitor-review`).catch(()=>({candidates:[]}))]);
 const prompts=(Array.isArray(rows)?rows:rows.prompts||[]).filter(p=>p.active!==false);
 const answers=prompts.flatMap(p=>p.runs||[]).filter(r=>r.mentioned!==null&&r.mentioned!==undefined);
 const cited=answers.filter(a=>a.cited).length;
 const plans=(recs.tasks||[]).filter(t=>t.evidence?.action_plan).sort((a,b)=>(a.evidence.action_plan.position||99)-(b.evidence.action_plan.position||99)).slice(0,3);
 reportVisible=true;
 $('content').innerHTML=`<h1>Your Quick Start report.</h1><p class="lead">${esc(o.project.brand_name)} · ${o.cycle?esc(new Date(o.cycle).toLocaleDateString()):'No completed measurement yet'}</p><p>Your first snapshot across the questions and AI engines below.</p>${preparing?'<p class="pill" role="status">Your results are ready. Suggested actions are still being prepared.</p>':''}<div class="grid"><article class="card"><span class="metric">${o.visibility==null?'—':Math.round(o.visibility*100)+'%'}</span>Named in measured answers</article><article class="card"><span class="metric">${cited}</span>Answers linking to your website</article><article class="card"><span class="metric">${o.runs||0}</span>Answers with a brand measurement</article></div><section class="panel"><h2>Where you appeared</h2>${(o.engines||[]).map(e=>`<p><b>${esc(label(e.engine))}</b> · Named in ${Math.round(e.rate*100)}% of ${e.runs} measured answers</p>`).join('')||'<p>No measured answers are available yet. This does not mean your business has zero visibility.</p>'}<p class="muted">This report covers the saved questions and engines shown here. Check the evidence below for missing coverage.</p></section><section class="panel"><h2>Competitors in this sample</h2><div id="competitor-results">${(o.competitors||[]).filter(c=>c.kind!=='owned').slice(0,5).map(c=>`<p>${esc(c.name)} · Named in ${Math.round(c.rate*100)}% of its measured sample</p>`).join('')||((rivals.candidates||[]).slice(0,5).map(c=>`<p><b>${esc(c.name)}</b> · Found in ${c.evidence.length} saved answer${c.evidence.length===1?'':'s'}</p>`).join('')+'<p class="muted">These are possible competitors identified in answer evidence. Review their relevance before treating them as direct competitors.</p>')}</div><details id="competitor-editor"></details></section><section class="panel"><h2>Three things to look at next</h2>${plans.map(t=>{const p=t.evidence.action_plan;return `<article><h3>${esc(p.title||t.title)}</h3>${p.generation==='page-grounded'?'':'<p class="muted">Website verification is incomplete. Treat this as a suggested check, not a confirmed content gap.</p>'}<p>${esc(p.change||t.action)}</p><p>${esc(p.rationale||'')}</p>${p.page?`<p>${safeLink(p.page,'Review the relevant page')}</p>`:''}<p class="muted">${esc(p.evidence?.observation||'Review the supporting answer before making changes.')}</p></article>`;}).join('')||(preparing?'<p>We’re checking your website against these answers. Your suggested actions will appear here automatically.</p>':'<p>No specific action could be prepared from the available evidence. Open the supporting answers below to review what AI said.</p>')}<p class="muted">Suggested actions. Check the facts before updating your website.</p></section><details class="panel"><summary>View questions and supporting answers</summary>${prompts.map(p=>`<details data-evidence="${p.id}"><summary>${esc(p.text)}</summary><div class="evidence">Open to load saved answers.</div></details>`).join('')}</details><details class="panel"><summary>How to read this report</summary><p>This is a snapshot of the saved question and engine sample, not an overall market score. Missing or failed answers are excluded, never scored as “not mentioned”. Naming and website citations are different outcomes. Suggestions do not guarantee future recommendations.</p></details><div class="actions"><a class="button" id="download-pdf" href="/api/projects/${projectId}/quick-start/report.pdf" download>Download PDF</a><button class="secondary" id="print">Print report</button>${advanced()}<button class="secondary" id="edit-report-questions">Edit questions for next scan</button><button class="secondary" id="refresh">Refresh saved report</button></div>${billing.advanced?'':upgrade()}`;
 if(preparing)$('download-pdf').replaceWith(Object.assign(document.createElement('p'),{textContent:'PDF available when next actions finish.'}));
 competitorEditor(o,rivals);
 $('edit-report-questions').onclick=()=>act($('edit-report-questions'),async()=>{context=await api(`/api/projects/${projectId}/quick-start`);questions();$('question-editor').open=true;});
 $('print').onclick=()=>window.print();$('refresh').onclick=()=>act($('refresh'),report);
 for(const detail of document.querySelectorAll('[data-evidence]'))detail.addEventListener('toggle',async()=>{if(!detail.open||detail.dataset.loaded)return;const box=detail.querySelector('.evidence');box.textContent='Loading saved evidence…';try{const d=await api(`/api/prompts/${detail.dataset.evidence}/answers`);box.innerHTML=d.runs.map(r=>`<h3>${esc(label(r.engine))}</h3><p class="pill">${r.measured?(r.mentioned?'Business named':'Business not named'):'Not measured'}${r.cited?' · Website cited':''}</p>${r.truncated?'<p>Answer may be incomplete. Interpret cautiously.</p>':''}<pre class="answer">${esc(r.response_text||r.unmeasuredReason||'No answer was returned.')}</pre><div class="sources">${(r.citations||[]).map(c=>`<p>${safeLink(c.url,c.domain||c.url)}</p>`).join('')}</div>`).join('')||'No saved answers for this question.';detail.dataset.loaded='true';}catch(e){box.textContent=e.message;}});
}
async function load(){
 billing=await api('/api/billing');
 if(!projectId && new URLSearchParams(location.search).get('new')==='1' && billing.advanced){setup();return;}
 if(!projectId){const projects=await api('/api/projects');if(projects.length){projectId=projects[0].id;history.replaceState({},'','/quick-start?site='+projectId);}else{setup();return;}}
 context=await api(`/api/projects/${projectId}/quick-start`);
 if(context.claim||context.measurement){waiting();await poll();}else await prepareQuestions();
}
let controls={},progressDismissed=false,progressState=null;
async function getControls(){controls=await api(`/api/projects/${projectId}/quick-start/controls`);return controls;}
async function emailControl(target){
 try{await getControls();if(!controls.emailAvailable){target.textContent='Completion emails are currently unavailable. Your saved report will still be here when you return.';return;}
 target.innerHTML=`<label class="check-label"><input type="checkbox" ${controls.emailWhenDone?'checked':''}> Email me when this report is ready</label><p class="muted" role="status"></p>`;
 const input=target.querySelector('input'),status=target.querySelector('[role=status]');
 input.onchange=async()=>{input.disabled=true;try{await api(`/api/projects/${projectId}/quick-start/preferences`,{emailWhenDone:input.checked});controls.emailWhenDone=input.checked;status.textContent=input.checked?'Completion email enabled. You can safely close this page.':'Completion email turned off.';}catch(e){input.checked=!input.checked;status.textContent=e.message;}finally{input.disabled=false;}};
 }catch(e){target.textContent='Email preference could not load. You can still run your report.';}
}
function closeProgress(){ $('scan-overlay')?.remove();$('scan-reopen')?.remove();progressState=null; }
function showProgress(s){
 progressState=s;
 if(!$('scan-reopen')){const b=document.createElement('button');b.id='scan-reopen';b.className='scan-reopen';b.textContent='Report running · View progress';b.onclick=()=>{progressDismissed=false;showProgress(progressState);};document.body.append(b);}
 if(progressDismissed)return;
 if(!$('scan-overlay')){const el=document.createElement('section');el.id='scan-overlay';el.className='scan-overlay';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-labelledby','scan-title');el.innerHTML='<div class="scan-dialog"><h2 id="scan-title">Your report is running</h2><p id="scan-stage" role="status"></p><progress id="scan-bar" aria-label="Answer collection"></progress><p id="scan-question"></p><p>You can close this page or continue browsing. The scan will keep running on our servers.</p><div id="scan-email"></div><button id="scan-dismiss" class="secondary">Continue browsing</button><p><a href="/quick-start?site='+projectId+'">Return to this report</a></p></div>';document.body.append(el);$('scan-dismiss').onclick=()=>{progressDismissed=true;el.remove();$('scan-reopen').focus();};el.onkeydown=e=>{if(e.key==='Escape')$('scan-dismiss').click();if(e.key==='Tab'){const nodes=[...el.querySelectorAll('button,input,a')].filter(n=>!n.disabled),first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};$('scan-dismiss').focus();emailControl($('scan-email'));}
 const thinking=s.phase==='thinking';$('scan-stage').textContent=thinking?'Preparing your three next actions…':s.phase==='starting'?'Starting your scan…':`${s.done||0} of ${s.total||40} checks processed. Collecting answers and checking mentions and citations.`;
 const bar=$('scan-bar');if(thinking||s.phase==='starting')bar.removeAttribute('value');else{bar.max=s.total||40;bar.value=s.done||0;}
 const recent=s.recent?.at(-1);$('scan-question').textContent=thinking?'Reviewing the answer evidence and your website.':recent?.question?`${label(recent.engine)}: ${recent.question}`:'';
}
function aiEditor(target,scope,read,apply){
 target.innerHTML=`<label>Tell AI what to change<textarea maxlength="1500" placeholder="${scope==='questions'?'Focus the questions on small businesses in Dubai.':'Remove Clutch and add my competitor, Example Agency.'}"></textarea></label><button type="button" class="secondary">Preview changes</button><p class="muted">AI edits are suggestions. Review and apply them before saving. This does not start a scan.</p><div class="ai-preview" role="status"></div>`;
 const button=target.querySelector('button'),input=target.querySelector('textarea'),preview=target.querySelector('.ai-preview');
 button.onclick=()=>act(button,async()=>{const original=read();button.textContent='Preparing preview…';try{const d=await api(`/api/projects/${projectId}/quick-start/assistant`,{scope,instruction:input.value,items:original});preview.innerHTML='<h3>Proposed changes</h3>'+d.items.map((item,i)=>{const before=original[i],a=scope==='questions'?String(item):`${item.name} | ${item.domain||''}`,b=scope==='questions'?String(before||''):before?`${before.name} | ${before.domain||''}`:'';if(scope==='competitors')return `<p><strong>${esc(a)}</strong></p>`;return a===b?'':`<p>${b?`<del>${esc(b)}</del><br>`:''}<strong>${esc(a)}</strong></p>`;}).join('')+(scope==='competitors'?original.filter(old=>!d.items.some(item=>item.name.toLowerCase()===old.name.toLowerCase())).map(old=>`<p>Remove: <del>${esc(old.name)}</del></p>`).join(''):'')+'<button type="button">Apply to editor</button> <button type="button" class="secondary">Discard</button>';const buttons=preview.querySelectorAll('button');buttons[0].onclick=()=>{apply(d.items);preview.textContent='Applied to the editor. Save your changes when ready.';};buttons[1].onclick=()=>{preview.textContent='Discarded. Nothing changed.';};}finally{button.textContent='Preview changes';}});
}
async function competitorEditor(o,rivals){
 const target=$('competitor-editor');if(!target)return;
 try{await getControls();const selected=controls.customCompetitors?controls.competitors:(controls.competitors.length?controls.competitors:(rivals.candidates||[]).slice(0,15));
 const read=()=>target.querySelector('#competitor-lines').value.split('\n').filter(x=>x.trim()).map(line=>{const [name,domain='']=line.split('|');return {name:name.trim(),domain:domain.trim()};});
 target.innerHTML='<summary>Edit competitors or ask AI</summary><p>Remove directories such as Clutch if they are not direct competitors. Add up to 15 companies, one per line: Name | website.</p><textarea id="competitor-lines" rows="7" aria-label="Competitors"></textarea><div id="competitor-ai"></div><button type="button" id="save-competitors">Save competitors</button><p class="muted">New competitors need a new scan for measurements. Saving this list does not run or charge for a scan.</p>';
 const apply=items=>{$('competitor-lines').value=items.map(c=>`${c.name} | ${c.domain||''}`).join('\n');};apply(selected);aiEditor($('competitor-ai'),'competitors',read,apply);
 $('save-competitors').onclick=()=>act($('save-competitors'),async()=>{await api(`/api/projects/${projectId}/quick-start/competitors`,{competitors:read()});await report();});
 if(controls.customCompetitors){$('competitor-results').innerHTML=controls.competitors.map(c=>{const measured=(o.competitors||[]).find(m=>m.name.toLowerCase()===c.name.toLowerCase());return `<p>${esc(c.name)} · ${measured?.rate!=null?`Named in ${Math.round(measured.rate*100)}% of its measured sample`:'Added for next scan · Not measured'}</p>`;}).join('')||'<p>No competitors selected.</p>';}
 }catch(e){target.innerHTML='<summary>Edit competitors</summary><p>Could not load competitor controls. Refresh to try again.</p>';}
}

$('logout').onclick=()=>act($('logout'),async()=>{await api('/api/logout',{});location.assign('/login');});
try{await verify();await load();}catch(e){error(e);$('content').innerHTML='<h1>Your workspace could not load.</h1><button onclick="location.reload()">Try again</button>';}
