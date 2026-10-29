/* A resumable, explicit path from a measured question to reviewed website copy. */
(() => {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let dialog,data,projectId,recId,step='facts',busy=false,dirty=false,opener;
  const url=s=>`/api/projects/${projectId}${s}`;
  const api=async(path,body,method=body?'POST':'GET')=>{
    const r=await fetch(path,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:undefined,...(body?{body:JSON.stringify(body)}:{})});
    let value;try{value=await r.json();}catch{throw new Error('The server did not return a result. Reopen this step to check whether it was saved.');}
    if(!r.ok)throw Object.assign(new Error(value.error||'This step could not be completed.'),{status:r.status});return value;
  };
  const key=kind=>{
    const name=`cited-faq:${projectId}:${recId}:${kind}`;let value;try{value=sessionStorage.getItem(name);}catch{}
    if(!value){value=crypto.randomUUID();try{sessionStorage.setItem(name,value);}catch{}}
    return value;
  };
  const clearKey=kind=>{try{sessionStorage.removeItem(`cited-faq:${projectId}:${recId}:${kind}`);}catch{}};
  const money=n=>n==null?'unknown':`$${Number(n).toFixed(4)}`;
  const link=(value,label=value)=>{try{const u=new URL(value,location.origin);if(u.protocol!=='https:'||u.username||u.password)return esc(label);return `<a href="${esc(u.href)}" target="_blank" rel="noopener">${esc(label)}</a>`;}catch{return esc(label);}};
  function status(message,error=false){const el=dialog.querySelector('[data-faq-status]');el.textContent=message;el.classList.toggle('faq-error',error);}
  function setBusy(value,message=''){busy=value;dialog.setAttribute('aria-busy',String(value));dialog.querySelectorAll('button,input,textarea').forEach(x=>{if(!x.hasAttribute('data-faq-close'))x.disabled=value||x.dataset.keepDisabled==='true';});if(message)status(message);}
  async function action(work,message){if(busy)return;setBusy(true,message);try{await work();}catch(e){status(e.message,true);}finally{setBusy(false);}}
  async function reload(){data=await api(url(`/content-workflow?recommendation=${recId}`));dirty=false;}
  function factsForm(){return `<h2 id="faqTitle">1. Check the facts</h2><p>Approve the facts this answer may use. Correct anything outdated or incomplete. Website text is a starting point; you decide what is accurate.</p>
    <p><button type="button" class="ghost" data-faq-extract>${data.review.facts.length?'Find more relevant facts':'Find facts from my website'}</button> <span class="hint">Uses one AI drafting request; no answer checks.</span></p>
    <div data-faq-facts>${data.review.facts.map(factRow).join('')}</div>
    <button class="ghost" type="button" data-faq-add>Add a fact manually</button>
    <div class="faq-controls"><button type="button" data-faq-save-facts>${data.draft?'Save reviewed facts':'Save facts & draft FAQ'}</button></div>
    <p class="hint">${data.draft?'Changing approved facts makes an older draft require review and regeneration.':'Next: an editable answer to your exact question. Drafting uses one AI request with up to 2,200 output tokens.'}</p>`;}
  function factRow(f={}){return `<fieldset class="faq-fact" data-fact-id="${esc(f.id||'')}" data-source-url="${esc(f.source_url||'')}"><legend>${f.origin==='owner'?'Fact supplied by you':'Fact to review'}</legend>
    <label>Fact<textarea data-fact-statement rows="2" maxlength="600" dir="auto">${esc(f.statement||'')}</textarea></label>
    ${f.source_url?`<p class="hint">Source: ${link(f.source_url)}${f.read_at?` · read ${esc(new Date(f.read_at).toLocaleDateString())}`:''}</p>`:'<label>Source page URL<input type="url" data-fact-url placeholder="https://'+esc(data.project.domain)+'/..." /></label>'}
    ${f.source_quote?`<details><summary>Original website passage</summary><blockquote dir="auto">${esc(f.source_quote)}</blockquote></details>`:'<p class="hint">Owner supplied. No website passage has been verified for this fact.</p>'}
    <div class="faq-fact-bottom"><label class="faq-check"><input type="checkbox" data-fact-approved ${f.approved?'checked':''} /> I have checked this fact and approve its use</label><button type="button" class="ghost" data-faq-remove>Remove</button></div></fieldset>`;}
  function draftForm(){const d=data.draft;if(!d)return `<h2 id="faqTitle">2. Draft the answer</h2><p>Review and approve at least one brand fact, then draft an answer to the exact measured question.</p><button data-faq-step="facts">Review facts</button>`;
    const locked=d.status==='implemented',ready=d.status==='ready'&&!d.stale;
    return `<h2 id="faqTitle">2. Review your FAQ</h2>${d.stale?'<p class="faq-warning">Your approved facts have changed. Review them, then regenerate before approving this draft.</p>':''}
    ${d.content.missing_facts?.length?`<aside class="faq-warning"><b>Facts still needed</b><ul>${d.content.missing_facts.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><p>Supply verified details or remove unsupported wording. Do not publish placeholders.</p></aside>`:''}
    <label>Question<p class="faq-exact" dir="auto">${esc(d.question)}</p></label>
    <label>Answer<textarea data-faq-answer rows="10" maxlength="3500" dir="auto" ${locked?'readonly':''}>${esc(d.content.answer)}</textarea></label>
    <label>Page to update<input data-faq-target type="url" value="${esc(d.target_url)}" ${locked?'readonly':''} placeholder="https://${esc(data.project.domain)}/..." /></label>
    <details class="faq-evidence"><summary>Approved facts and measurement evidence</summary>${(d.facts_snapshot||[]).filter(f=>d.content.fact_ids.includes(f.id)).map(f=>`<p dir="auto">${esc(f.statement)}<br>${link(f.source_url)}</p>`).join('')}<p>${link(data.action.evidence.answer_url,'Read the original measured answer')} — question evidence, not proof of product claims.</p></details>
    ${locked?'<p class="faq-success">Publication recorded. This copy is kept with its measurement baseline.</p>':`<label class="faq-check"><input type="checkbox" data-faq-approved ${ready?'checked':''} /> I have checked every claim, supplied or removed missing details, and approve this answer for use</label><div class="faq-controls"><button data-faq-save>Save answer</button><button class="ghost" data-faq-regenerate>Regenerate using reviewed facts</button></div><p class="hint">Regeneration uses one AI request and creates a new draft. Your previous saved version stays in the history.</p>`}
    <div class="faq-controls"><button class="ghost" data-faq-copy ${ready||locked?'':'disabled data-keep-disabled="true"'}>Copy approved FAQ</button><button class="ghost" data-faq-download>Download FAQ with evidence</button>${ready||locked?'<button class="ghost" data-faq-report>Review FAQ for client report</button><button data-faq-step="publish">Next: record publication</button>':''}</div>
    <p class="hint">Saving here does not publish to your website. The report button opens your action editor; review and save it, then preview its inclusion in the client report.</p>`;
  }
  function publishForm(){const d=data.draft;
    if(!d||!['ready','implemented'].includes(d.status)||d.stale&&d.status!=='implemented')return '<h2 id="faqTitle">3. Publish & check</h2><p>Review and approve the FAQ first, then copy it into your website.</p><button data-faq-step="draft">Review the draft</button>';
    if(d.status==='implemented')return `<h2 id="faqTitle">3. Publication recorded</h2><p>${link(d.implemented_url)}<br>Published ${esc(String(d.implemented_on).slice(0,10))}, as recorded by you.</p>
      <p>Once the updated page is accessible, repeat the same question with matching engines and settings. AI answers can vary, and a change is not proof of impact.</p>
      ${d.recheck?comparison(d.recheck):''}<button data-faq-scope>${d.recheck?'Check another repeat':'Check repeat settings & cost'}</button><div data-faq-scope-result></div>`;
    return `<h2 id="faqTitle">3. Publish & check</h2><p>Copy your approved FAQ into the page using your website editor. Come back here once it is published.</p>
      <button class="ghost" data-faq-copy>Copy approved FAQ</button><label>Published page URL<input type="url" data-implemented-url value="${esc(d.target_url)}" /></label>
      <label>Publication date<input type="date" data-implemented-date max="${new Date().toISOString().slice(0,10)}" value="${new Date().toISOString().slice(0,10)}" /></label>
      <label class="faq-check"><input type="checkbox" data-implemented-confirm /> I have published the reviewed answer at this URL</label>
      <div class="faq-controls"><button data-faq-implemented>Save publication & continue</button></div><p class="hint">This records your confirmation. Cited does not publish or independently verify the page change.</p>`;
  }
  function comparison(r){const c=r.comparison||{};return `<div class="faq-success"><b>${c.comparable?'Matched repeat complete':'Repeat recorded — comparison unavailable'}</b><p>${esc(r.note||'')}</p>${c.reason?`<p>${esc(c.reason)}</p>`:''}${c.before?`<table><thead><tr><th>Engine</th><th>Before: named / cited</th><th>After: named / cited</th></tr></thead><tbody>${c.before.map(b=>{const a=c.after?.find(x=>x.engine===b.engine);return `<tr><td>${esc(b.engine)}</td><td>${b.named}/${b.usable} · ${b.cited}/${b.usable}</td><td>${a?`${a.named}/${a.usable} · ${a.cited}/${a.usable}`:'No usable sample'}</td></tr>`;}).join('')}</tbody></table>`:''}<p>Repeat answer-check cost: ${money(r.spend)}.</p>${link(`/api/projects/${projectId}/measurements/${r.measurementId}`,'Open the saved repeat answers')}</div>`;}
  function render(){
    dialog.innerHTML=`<header class="faq-head"><div><p class="eyebrow">Question → website action</p><p class="faq-brand">${esc(data.project.name)}</p></div><button class="ghost" data-faq-close aria-label="Close FAQ workflow">Close</button></header>
      <nav class="faq-steps" aria-label="FAQ workflow steps">${[['facts','1. Review facts'],['draft','2. Draft answer'],['publish','3. Publish & check']].map(([key,label])=>`<button class="ghost" data-faq-step="${key}" ${key===step?'aria-current="step"':''}>${label}</button>`).join('')}</nav>
      <p class="faq-question" dir="auto">${esc(data.action.question)}</p><div class="faq-content">${step==='facts'?factsForm():step==='draft'?draftForm():publishForm()}</div>
      <p class="faq-status" data-faq-status role="status" aria-live="polite"></p>
      <details class="faq-costs"><summary>Costs: answer checks ${money(data.costs.answer_usd)} · recorded drafting ${money(data.costs.estimated_usd)}${data.costs.unknown_cost_calls?' + unknown costs':''}</summary><p>${esc(data.costs.note)}</p><p>${data.costs.recorded_calls} drafting calls with recorded usage. ${data.costs.unknown_cost_calls} calls without a reliable cost estimate.</p>${data.costs.calls?.length?`<table><thead><tr><th>Drafting request</th><th>Estimated API cost</th></tr></thead><tbody>${data.costs.calls.map(c=>`<tr><td>${esc(({brand_facts:'Website fact selection',faq_draft:'FAQ draft',immediate_actions:'Action suggestions'})[c.kind]||c.kind)}<br><small>${esc(c.model||'Usage unavailable')}</small></td><td>${money(c.estimated_cost_usd)}</td></tr>`).join('')}</tbody></table>`:''}</details>`;
    dialog.scrollTop=0;dialog.querySelector('#faqTitle')?.setAttribute('tabindex','-1');dialog.querySelector('#faqTitle')?.focus();
  }
  function collectFacts(){return [...dialog.querySelectorAll('.faq-fact')].map(el=>({id:el.dataset.factId,statement:el.querySelector('[data-fact-statement]').value,source_url:el.dataset.sourceUrl||el.querySelector('[data-fact-url]')?.value,approved:el.querySelector('[data-fact-approved]').checked}));}
  async function generate(regenerate=false){
    try{await api(url(`/faq/${recId}/draft`),{request_key:key('draft'),regenerate,revision:data.draft?.revision});clearKey('draft');}
    catch(e){if(e.status&&!/already running|Another request for this step/.test(e.message))clearKey('draft');throw e;}
    await reload();step='draft';render();status('Draft saved. Check the wording and any missing facts.');
  }
  function leave(){if(dirty&&!confirm('Discard the changes you have not saved?'))return;dialog.close();opener?.focus();}
  async function open(project,rec){
    if(busy)return;projectId=Number(project);recId=Number(rec);opener=document.activeElement;
    if(!dialog){dialog=document.createElement('dialog');dialog.className='faq-dialog';dialog.setAttribute('aria-labelledby','faqTitle');document.body.appendChild(dialog);bind();}
    dialog.innerHTML='<h2 id="faqTitle">Loading your FAQ workflow…</h2><p data-faq-status role="status"></p><button data-faq-close>Close</button>';dialog.showModal();dirty=false;
    await action(async()=>{await reload();step=data.draft?.status==='implemented'?'publish':data.draft?'draft':'facts';render();},'Loading saved facts and work…');
  }
  function bind(){
    dialog.addEventListener('cancel',e=>{e.preventDefault();leave();});
    dialog.addEventListener('input',()=>{dirty=true;});
    dialog.addEventListener('click',async e=>{
      const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-faq-close'))return leave();if(busy)return;
      if(b.dataset.faqStep){if(dirty&&!confirm('Discard the changes you have not saved?'))return;dirty=false;step=b.dataset.faqStep;render();return;}
      if(b.hasAttribute('data-faq-add')){dialog.querySelector('[data-faq-facts]').insertAdjacentHTML('beforeend',factRow({origin:'owner'}));dirty=true;return;}
      if(b.hasAttribute('data-faq-remove')){b.closest('.faq-fact').remove();dirty=true;return;}
      if(b.hasAttribute('data-faq-extract')){if(dirty){status('Save your fact edits before reading more website pages.',true);return;}return action(async()=>{
        try{await api(url('/brand-facts/extract'),{recommendation_id:recId,request_key:key('facts')});clearKey('facts');}catch(e){if(e.status&&!/already running|Another request for this step/.test(e.message))clearKey('facts');throw e;}
        await reload();render();status('Website passages found. Check and approve only the facts you want to use.');
      },'Reading the website and selecting relevant facts. This can take about a minute…');}
      if(b.hasAttribute('data-faq-save-facts'))return action(async()=>{
        const facts=collectFacts();if(!data.draft&&!facts.some(f=>f.approved))throw new Error('Approve at least one fact to draft an answer.');
        data.review=await api(url('/brand-facts'),{revision:data.review.revision,facts},'PUT');dirty=false;
        if(!data.draft)await generate();else{await reload();step='draft';render();status('Reviewed facts saved. Regenerate if the approved facts changed.');}
      },'Saving your reviewed facts…');
      if(b.hasAttribute('data-faq-regenerate')){if(!confirm('Replace this editor with a new AI draft using your approved facts? Saved versions are retained. This uses one drafting request.'))return;return action(()=>generate(true),'Drafting an answer using approved facts…');}
      if(b.hasAttribute('data-faq-save'))return action(async()=>{
        const approved=dialog.querySelector('[data-faq-approved]').checked;
        await api(url(`/faq/${recId}`),{revision:data.draft.revision,answer:dialog.querySelector('[data-faq-answer]').value,target_url:dialog.querySelector('[data-faq-target]').value,status:approved?'ready':'draft',approved,missing_resolved:approved},'PUT');
        await reload();render();status(approved?'Answer approved and saved. Copy it into your website, or review it for your client report.':'Draft saved. You can return to it at any time.');
      },'Saving your answer…');
      if(b.hasAttribute('data-faq-copy'))return action(async()=>{if(dirty)throw new Error('Save your edits before copying the approved answer.');await navigator.clipboard.writeText(data.draft.question+'\n\n'+data.draft.content.answer);status('Approved FAQ copied. Paste it into your website editor.');},'Copying…');
      if(b.hasAttribute('data-faq-download')){if(dirty){status('Save your edits before downloading.',true);return;}const d=data.draft,body=[`Cited FAQ — ${d.status}${d.stale?' (facts changed)':''}`,d.question,d.target_url,d.content.answer,'Supporting facts:',...d.facts_snapshot.filter(f=>d.content.fact_ids.includes(f.id)).map(f=>`${f.statement}\n${f.source_url}`),`Measured answer: ${new URL(data.action.evidence.answer_url,location.origin).href}`,d.implemented_url?`Publication recorded: ${d.implemented_url} on ${String(d.implemented_on).slice(0,10)}`:'Publication has not been recorded.','Editorial content, not measured demand or a predicted result.'].join('\n\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([body],{type:'text/plain;charset=utf-8'}));a.download=`cited-faq-${recId}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);status('FAQ and evidence downloaded.');return;}
      if(b.hasAttribute('data-faq-report')){if(dirty){status('Save your edits first.',true);return;}const result=await window.CitedFaqToAction?.(data);if(result!==false){dialog.close();dirty=false;}return;}
      if(b.hasAttribute('data-faq-implemented'))return action(async()=>{await api(url(`/faq/${recId}/implemented`),{revision:data.draft.revision,url:dialog.querySelector('[data-implemented-url]').value,date:dialog.querySelector('[data-implemented-date]').value,confirmed:dialog.querySelector('[data-implemented-confirm]').checked});await reload();render();status('Publication recorded. Next, check the repeat settings and cost.');},'Saving publication details…');
      if(b.hasAttribute('data-faq-scope'))return action(async()=>{const scope=await api(url(`/faq/${recId}/recheck`));dialog.querySelector('[data-faq-scope-result]').innerHTML=scope.eligible?`<p>${scope.calls} answer check${scope.calls===1?'':'s'} · estimated ${money(scope.estimated_usd)}. Same question, engines, model selections, market and collection settings as the baseline. Actual cost can vary.</p><button data-faq-recheck>Run matched repeat</button>`:`<p class="faq-warning">${esc(scope.reason)}</p>`;status(scope.eligible?'Ready when you are. The next button starts paid answer checks.':'No answer checks started.');},'Checking whether a matched repeat is possible…');
      if(b.hasAttribute('data-faq-recheck'))return action(async()=>{try{await api(url(`/faq/${recId}/recheck`),{request_key:key('recheck'),retry:Boolean(data.draft.recheck),revision:data.draft.revision});clearKey('recheck');}catch(e){if(e.status&&!/already running|Another request for this step/.test(e.message))clearKey('recheck');throw e;}await reload();render();status('Repeat saved. Read the original answers before interpreting the change.');},'Collecting the matched repeat. You can reopen this action to see the saved result…');
    });
  }
  document.addEventListener('click',e=>{const b=e.target.closest('[data-draft-faq]');if(b)void open(b.dataset.projectId,b.dataset.draftFaq);});
  window.CitedFaq={open};
})();
