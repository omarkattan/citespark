(() => {
 const el=id=>document.getElementById(id);
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const time=d=>d?new Date(d).toLocaleString():'Not recorded';
 const money=(amount,currency)=>{const format=new Intl.NumberFormat('en',{style:'currency',currency});return format.format(Number(amount)/10**format.resolvedOptions().maximumFractionDigits);};
 const rate=r=>r.percent===null?'—':`${r.percent}% (${r.converted}/${r.total})`;
 const stage=r=>r.paid_at?'Payment confirmed':r.checkout_at?'Checkout started':r.pricing_at?'Pricing viewed':r.report_at?'Report generated':r.project_at?'Project saved':r.signup_at?'Registered':'Anonymous demo';
 const table=(head,rows)=>`<div style="overflow-x:auto"><table><thead><tr>${head.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
 async function get(url){const response=await fetch(url);if(!response.ok)throw Error(response.status===401?'Sign in to view conversion data.':response.status===404?'Not available on this account.':'Could not load conversion data.');return response.json();}
 async function load(){
  try{
   const data=await get('/api/admin/conversions?days='+el('conversionDays').value),m=data.metrics;
   el('conversionDashboard').innerHTML=`<div class="cards" style="margin-top:18px">${[['Public demos',m.demos],['Signups',m.signups],['Projects',m.projects],['First reports',m.reports],['Pricing viewed',m.pricing],['Checkout started',m.checkouts],['New paying customers',m.payingCustomers]].map(([k,v])=>`<div class="card"><div class="k">${escape(k)}</div><div class="v">${v}</div></div>`).join('')}</div>
   ${table(['Conversion','Rate'],[['Demo → signup',m.demoToSignup],['Signup → project',m.signupToProject],['Project → report',m.projectToReport],['Report → paid',m.reportToPaid],['Demo → paid',m.demoToPaid]].map(([k,r])=>`<tr><td>${escape(k)}</td><td>${rate(r)}</td></tr>`))}
   <h3>Attributed receipts</h3><p>Observed cash receipts for new customers from this demo cohort, including renewals, less confirmed refunds. Includes tax where charged. Currencies are kept separate.</p>
   ${data.revenue.length?table(['Currency','Gross received','Refunded','Net received'],data.revenue.map(r=>`<tr><td>${escape(r.currency.toUpperCase())}</td><td>${escape(money(r.gross_minor,r.currency))}</td><td>${escape(money(r.refunded_minor,r.currency))}</td><td>${escape(money(Number(r.gross_minor)-Number(r.refunded_minor),r.currency))}</td></tr>`)):'<p>No attributed payment receipts recorded.</p>'}
   <details><summary>Conversions by acquisition source and engine</summary>${['bySource','byEngine'].map(key=>`<h3>${key==='bySource'?'Source':'Demo engine'}</h3>${table(['Group','Demos','Demo → signup','Report → paid','Demo → paid'],data[key].map(r=>`<tr><td>${escape(r.name)}</td><td>${r.demos}</td><td>${rate(r.demoToSignup)}</td><td>${rate(r.reportToPaid)}</td><td>${rate(r.demoToPaid)}</td></tr>`))}`).join('')}</details>
   <h3>Journeys and next steps</h3><p>${data.eligibleFollowups} eligible follow-up previews in this cohort. Showing ${data.shown} of ${data.rowCount} journeys.</p>
   ${table(['Visitor or account','Progress','Next action','Inspect'],data.leads.map(r=>`<tr><td>${r.org_id?`<b>${escape(r.org_name)}</b><div>${escape(r.email)} ${r.email_verified_at?'· verified':'· unverified'}</div>`:'<b>Anonymous demo</b>'}<div>${escape(r.domain||'No attributed demo')}</div><small>${time(r.cohort_at)}</small></td><td>${stage(r)}<div>${escape(r.plan||'No account')}${r.subscription_status?' · '+escape(r.subscription_status):''}</div></td><td>${escape(r.followup.reason)}${r.followup.status==='eligible'?`<br><button class="ghost" data-conversion-preview="${r.org_id}">Preview email</button>`:''}</td><td><button class="ghost" data-conversion-journey="${r.org_id?'org='+r.org_id:'demo='+r.journey_id}">Journey</button>${r.org_id?` <button class="ghost" data-conversion-suppress="${r.org_id}">Stop follow-ups</button>`:''}</td></tr>`))}
   <p class="hint">${escape(data.notes)}</p><p class="hint">${data.excludedTestAccounts} accounts with test payments excluded. First report means a report generated with measured answers, not a completed full analysis. Older reports and payments are not reconstructed.</p>`;
  }catch(error){el('conversionDashboard').textContent=error.message;}
 }
 el('conversionDays').addEventListener('change',load);
 document.addEventListener('click',async e=>{
  const journey=e.target.closest('[data-conversion-journey]'),preview=e.target.closest('[data-conversion-preview]'),suppress=e.target.closest('[data-conversion-suppress]');
  if(!journey&&!preview&&!suppress)return;
  const detail=el('conversionDetail');detail.hidden=false;
  try{
   if(journey){
    const d=await get('/api/admin/conversions/journey?'+journey.dataset.conversionJourney);
    detail.innerHTML=`<h3>Recorded journey</h3><p>${escape(d.journey?.domain||'No linked demo')} · Domain ownership is not verified.</p>
    ${table(['Event','Time','Details'],d.events.map(v=>`<tr><td>${escape(v.event_name)}</td><td>${time(v.occurred_at)}</td><td style="overflow-wrap:anywhere">${escape(JSON.stringify(v.detail))}</td></tr>`))}
    <details><summary>Payment and refund ledger</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(JSON.stringify({payments:d.payments,refunds:d.refunds},null,2))}</pre></details>`;
   }else if(preview){
    const d=await get(`/api/admin/conversions/${preview.dataset.conversionPreview}/preview`);
    detail.innerHTML=`<h3>Email preview, no send</h3><p>${escape(d.decision.reason)}</p>${d.template?`<h4>${escape(d.template.subject)}</h4><p style="white-space:pre-wrap">${escape(d.template.text)}</p>`:''}`;
   }else{
    const response=await fetch(`/api/admin/conversions/${suppress.dataset.conversionSuppress}/suppress`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'manual'})});
    if(!response.ok)throw Error('Could not stop follow-ups');detail.textContent='Follow-ups stopped for this account.';await load();
   }
   detail.scrollIntoView({block:'nearest'});
  }catch(error){detail.textContent=error.message;}
 });
 load();
})();
