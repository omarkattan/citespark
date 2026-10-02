/* Shared contextual help. No network calls, data writes or changes to action handlers. */
(()=>{
 if(document.querySelector('[data-cited-help-root]'))return;
 const style=document.createElement('style');style.textContent=`
 .cited-help-group{display:inline-flex;align-items:center;gap:3px;max-width:100%;min-width:0;vertical-align:middle}
 .cited-help-group[hidden]{display:none!important}
 .cited-help-button{display:inline-flex!important;position:relative;align-items:center;justify-content:center;flex:0 0 15px;vertical-align:middle;width:15px!important;min-width:15px!important;height:15px!important;padding:0!important;margin:0!important;border:1px solid #aab6b9!important;border-radius:50%!important;background:transparent!important;color:#64777c!important;font:500 10px/1 system-ui!important;cursor:help!important;box-shadow:none!important;text-transform:none!important}
 .cited-help-button:hover{color:#24474f!important;border-color:#64777c!important}
 .cited-help-button[hidden]{display:none!important}
 .cited-help-button:focus-visible{outline:3px solid #087e83!important;outline-offset:3px}
 .cited-help-popup{position:fixed;inset:auto;margin:0;box-sizing:border-box;width:320px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;padding:14px 16px;border:1px solid #627b81;border-radius:8px;background:#12333b;color:#fff;font:14px/1.5 system-ui,sans-serif;box-shadow:0 6px 22px #0003;z-index:2147483647;text-align:left;white-space:normal}
 .cited-help-popup[hidden]{display:none!important}
 @media(pointer:coarse){.cited-help-button::after{content:"";position:absolute;inset:-5px -4px}}
 @media print{.cited-help-button,.cited-help-popup{display:none!important}.cited-help-group{display:contents}}`;
 document.head.append(style);
 const popup=document.createElement('div');popup.id='cited-context-help';popup.dataset.citedHelpRoot='';popup.className='cited-help-popup';popup.role='tooltip';popup.hidden=true;document.body.append(popup);
 const operations={
 generate:'Creates an AI analysis draft from saved project evidence, or reopens a matching saved draft. A new draft uses a paid AI request. It does not run visibility checks or include itself in the report.',
 regenerate:'Requests another paid AI draft using the current evidence. Existing attempts stay recorded. The new draft still needs review before inclusion.',
 recover:'Rechecks the saved AI response against the validation rules and current evidence. No new AI request or charge. A recovered draft still needs review.',
 approve:'Includes this reviewed AI analysis in reports whose evidence matches this draft. This does not assign tasks, approve implementation or send anything to your client.',
 remove:'Removes AI analysis from this project’s reports. Saved drafts and usage records remain. Selected recommendations are separate.'
 };
 const views={overview:'See what changed, what matters and the next action for this project.',questions:'Review the buyer questions used for measurement. Their wording and source define what the results cover.',opportunities:'Review evidence, record decisions and manage work. An investigation is not an approved content change.',actions:'Review evidence, record decisions and manage work. An investigation is not an approved content change.',evidence:'Inspect stored answers, search demand, traffic and competitor evidence behind recommendations.',settings:'Manage this project’s measurement settings, connected sources and account options.',answers:'Read the stored answers behind your metrics. Opening them does not make a new AI request.',trends:'Compare measurements over time. Use matched question-and-engine samples before claiming improvement.',traffic:'Review identifiable AI referral sessions and recorded GA4 events. Events are not automatically unique leads.',searchDemand:'Use Google Search Console queries to find evidence of Google search demand. This is not AI search volume.',competitorReview:'Review brands found in stored answers, confirm relevant competitors and ignore unrelated suggestions.',rivals:'Compare tracked competitors using the stated answer coverage. Later retrospective checks are labelled separately.',sources:'See websites cited in the stored answers. A cited website is not automatically a competitor.',pages:'Inspect your pages that appeared in collected answers.',connections:'Connect or review Search Console and Analytics. They supply different evidence and do not replace AI measurements.',setup:'Set brand aliases, market and engine settings. Changes can affect cost and comparability.',billing:'Review plan limits and billing options.',assigned:'See tasks with recorded owners and follow up on progress.',landscape:'Explore broader market research. This is separate from this project’s measured question sample.'};
 const rules=[
 ['[data-operation]',el=>operations[el.dataset.operation]],
 ['[data-section]',el=>views[el.dataset.section]],['[data-view]',el=>views[el.dataset.view]],['[data-open-view]',el=>views[el.dataset.openView]],
 ['[data-report-link="full"]','Opens the full report with selected recommendations, measured results and supporting evidence. No new AI analysis or visibility checks are requested.'],
 ['[data-report-link="ceo"]','Opens the shorter management brief. Use the full report for supporting evidence and complete instructions.'],
 ['[data-analyst-link]','Generate and review AI interpretation of the saved evidence. Generating a new draft costs money; opening this screen does not.'],
 ['[data-preview],[data-report-preview]','Shows the saved wording and proposed report copy so you can review differences before including or updating it.'],
 ['[data-remove],[data-report-note][data-include="false"]','Removes this recommendation from the client report. It does not delete the task or its evidence.'],
 ['[data-report-note][data-include="true"]','Saves the reviewed wording as a report copy. Later edits to the task do not silently replace this copy.'],
 ['[data-report-sync-ga4],#ga4Sync','Refreshes stored Analytics data from the connected property. It does not run visibility checks. Updated evidence may require a fresh AI report analysis.'],
 ['#refresh-search','Refreshes dated Search Console evidence for stored query examples. Google search impressions remain separate from AI measurements.'],
 ['[data-refresh]','Reloads this page’s saved information. Save any edits first. It does not request new AI answers.'],
 ['#addSiteBtn','Creates a separate project for a website, with its own questions, sources and measurements.'],
 ['#f_scan','Scans the entered website to help prepare project details. Review the suggestions before saving.'],
 ['#siteSave','Saves the project setup and continues to connecting sources. It does not complete a visibility measurement.'],
 ['#runBtn','Choose which questions to measure. Engine calls consume your allowance and can incur provider costs.'],
 ['#runFullBtn,[data-start-first-cycle]','Opens the run review so you can check scope and estimated cost before starting the measurement.'],
 ['#runUnrunBtn','Choose active questions that have never been measured. Review the scope and estimate before running.'],
 ['#runAllBtn','Starts the account-wide measurement workflow across sites. Check scope carefully because multiple projects can consume allowance and cost.'],
 ['[data-run-confirm]','Starts the selected measurement scope with the configured engines. This uses answer checks and incurs provider costs.'],
 ['[data-reask]','Requests new answers for this question, or the named engine if specified. This uses answer checks and can incur provider costs.'],
 ['[data-see-answer]','Opens saved engine responses for this question. No new answer requests are made.'],
 ['[data-teardown]','Reviews whether the cited page is relevant to this question. It can fetch the page and use AI analysis. A citation alone does not establish relevance.'],
 ['[data-brief]','Opens a content brief based on stored question evidence. Review it before treating it as an instruction to create or change content.'],
 ['[data-question-edit]','Changes the question wording used in future measurements. Revised wording may break like-for-like comparisons with earlier results.'],
 ['[data-question-save]','Saves revised wording. Results collected for earlier wording are not evidence of a trend for the new question.'],
 ['[data-question-toggle]',el=>el.textContent.trim()==='Pause'?'Stops asking this question in future scheduled measurements. Stored results remain.':'Makes this question active for future measurements. This does not immediately request an answer.'],
 ['#q_add','Adds your question using the wording entered. Adding it does not itself collect engine answers.'],
 ['#q_topic,#q_generate,#suggestPersonas','Uses AI to propose questions or buyer types. Review suggestions before adding them. Suggestions are hypotheses, not measured search demand.'],
 ['#gscGrant','Opens Google authorisation for Search Console. Choose the correct account and property to use actual Google search queries.'],
 ['#gscSwitch','Choose which Search Console property supplies this project’s search evidence. Check that it belongs to this website.'],
 ['#gscLoad','Loads search-query suggestions from the connected Search Console property. Review relevance before adding them as questions.'],
 ['#gscImport','Adds selected Search Console-derived questions to this project. It does not run AI visibility checks.'],
 ['#gscDisconnect','Disconnects Search Console access for this project. New search evidence will need a working connection.'],
 ['#ga4Connect,#ga4Reconnect','Opens Google authorisation or account selection for Analytics. Choose the account with access to the correct property.'],
 ['#ga4Change','Selects the Analytics property used for this project. Sync and verify coverage before reporting its figures.'],
 ['#ga4Disconnect','Disconnects Analytics for this project. Reporting needs a verified connection and sync for current traffic evidence.'],
 ['[data-ga4-pick]','Uses this Analytics property for the project. Confirm the property belongs to this website.'],
 ['[data-gsc-site]','Uses this Search Console property for the project. Domain and URL-prefix properties can cover different scopes.'],
 ['[data-decision-save]','Saves your reviewed decision and delivery details. It does not complete the task, assign a suggested owner, or update an already-selected report copy.'],
 ['[data-task-edit]','Edits the task’s owner, due date and notes. A suggested owner in report text is not an assignment.'],
 ['[data-task-save]','Saves the task’s assignment, due date and notes. This does not prove the work improved AI visibility.'],
 ['[data-next-open],[data-next-save]','Records your specific next step or review conclusion on this opportunity. Report inclusion is a separate action.'],
 ['[data-rec][data-status]',el=>({done:'Marks the work complete. Completion is not proof of a visibility improvement; use a comparable follow-up measurement.',dismissed:'Dismisses this task from active work. Its status remains available for review.',doing:'Marks this task as in progress.',open:'Returns this task to the to-do list.'})[el.dataset.status]],
 ['[data-delete-rec]','Removes this recommendation and suppresses it from returning automatically. Use dismissal if you only want to take it out of active work.'],
 ['#trackSelectedCompetitors,#trackCustomCompetitor','Adds confirmed competitors for tracking and comparison. Check their names, domains and aliases first. Retrospective checks of stored answers are labelled separately.'],
 ['[data-save-tracked-aliases]','Saves the competitor names and aliases, then checks stored answers again. No new engine answers are requested. Original measurements remain separate.'],
 ['[data-candidate-decision]',el=>el.dataset.decision==='ignore'?'Hides this competitor suggestion from the review list. You can restore the suggestion later.':'Restores this ignored suggestion for review. It does not automatically track the brand.'],
 ['#s_save','Saves this project’s settings. Brand matching, model or engine changes can affect cost and historical comparability.'],
 ['#s_delete','Deletes this project and its associated data. Read the confirmation carefully before proceeding.'],
 ['[data-buy],[data-upgrade-to]','Opens the plan purchase workflow. Review the price and billing interval before confirming payment.'],
 ['[data-portal]','Opens billing management for the subscription. Review any price or renewal changes before confirming.'],
 ['#pcPreview','Previews the proposed page checks and their scope before running them.'],
 ['#pcRun','Runs the selected page checks. Review the scope and any displayed cost before starting.']
 ];
 const labels={
 'Prepare report':'Choose dates, review selected recommendations and prepare a client-ready report. Opening preparation does not request new AI answers.',
 'AI report analysis':'Generate and review AI interpretation of saved evidence before including it in a report.',
 'Preview full report':'Opens the saved results and selected recommendations as a full report. New AI analysis is not generated automatically.',
 'Open client report':'Opens the client report using the selected dates and saved evidence.',
 'Preview executive brief':'Opens the shorter management summary. The full report contains detailed evidence.',
 'Download data':'Downloads the report data as a CSV for spreadsheet analysis.',
 'Print / save PDF':'Opens your browser’s print dialog. Choose Save as PDF to download the report. This does not send it to anyone.',
 'Refresh saved overview':'Reloads saved report preparation details. Save unsaved form edits before refreshing.',
 'View report copy':'Shows the wording currently selected for the report and whether it differs from the saved decision.',
 'Save decision':'Saves your review decision. Inclusion in the report is a separate step.',
 'Remove from report':'Removes this selected report copy without deleting the underlying task.',
 'Brand named':'Answers that literally name the configured brand, divided by measured answers. A naming does not require a link to your website.',
 'Website cited':'Measured answers containing a recorded link to the tracked website. This can overlap with brand naming.',
 'Questions with presence':'Questions with at least one brand naming or website citation. This counts questions, not individual answers.',
 'From':'Start date for selecting AI measurements. GA4 uses its separately labelled reporting window.',
 'To':'End date for selecting AI measurements. Dates do not make differently worded questions comparable.'
 };
 const helpFor=el=>{
  if(el.dataset.help)return el.dataset.help;
  for(const [selector,copy] of rules)if(el.matches(selector)){const text=typeof copy==='function'?copy(el):copy;if(text)return text;}
  const label=el.textContent.trim().replace(/\s+/g,' ');return labels[label]||null;
 };
 let active=null,pinned=false,hideTimer;
 const position=()=>{if(!active)return;const r=active.getBoundingClientRect(),w=Math.min(320,innerWidth-24),height=popup.getBoundingClientRect().height;popup.style.width=w+'px';popup.style.left=Math.max(12,Math.min(r.left,innerWidth-w-12))+'px';popup.style.top=Math.max(12,Math.min(r.bottom+8,innerHeight-height-12))+'px';};
 const close=()=>{clearTimeout(hideTimer);if(active)active.removeAttribute('aria-describedby');if(typeof popup.hidePopover==='function'&&popup.matches(':popover-open'))popup.hidePopover();popup.hidden=true;active=null;pinned=false;};
 const show=button=>{clearTimeout(hideTimer);if(active!==button)close();active=button;popup.textContent=button.dataset.explanation;popup.hidden=false;button.setAttribute('aria-describedby',popup.id);if(typeof popup.showPopover==='function'){popup.setAttribute('popover','manual');if(!popup.matches(':popover-open'))popup.showPopover();}position();};
 const later=()=>{if(!pinned)hideTimer=setTimeout(close,160);};
 popup.addEventListener('pointerenter',()=>clearTimeout(hideTimer));popup.addEventListener('pointerleave',later);
 document.addEventListener('click',event=>{const button=event.target.closest('.cited-help-button');if(button){event.preventDefault();event.stopImmediatePropagation();if(active===button&&pinned)close();else{show(button);pinned=true;}return;}if(!popup.contains(event.target))close();},true);
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&active){event.preventDefault();event.stopImmediatePropagation();close();}},true);
 window.addEventListener('resize',position);document.addEventListener('scroll',()=>{if(active&&!active.isConnected)close();else position();},true);
 const attached=new Map();let pending=false;
 const observer=new MutationObserver(()=>{if(!pending){pending=true;requestAnimationFrame(()=>{pending=false;decorate();});}});
 function decorate(){
  observer.disconnect();
  for(const [el,button] of attached){if(!el.isConnected||!helpFor(el)){if(active===button)close();const group=button.parentElement;button.remove();if(group?.classList.contains('cited-help-group'))group.replaceWith(...group.childNodes);attached.delete(el);}else{button.hidden=el.hidden||!!el.parentElement?.parentElement?.closest('[hidden]');button.parentElement.hidden=button.hidden;if(button.hidden&&active===button)close();}}
  for(const el of document.querySelectorAll('button,a,label,dt,.metric b,.stat-label,.kpi-label,[data-help]')){
   if(el.closest('[data-cited-help-root]')||el.classList.contains('cited-help-button')||el.parentElement?.closest('button,a,label,summary')||el.closest('[hidden]'))continue;
   const explanation=helpFor(el);if(!explanation)continue;
   let button=attached.get(el);
   if(!button){button=document.createElement('button');button.type='button';button.className='cited-help-button';button.textContent='?';button.addEventListener('pointerenter',()=>show(button));button.addEventListener('pointerleave',later);button.addEventListener('focus',()=>show(button));button.addEventListener('blur',()=>{if(active===button)close();});const group=document.createElement('span');group.className='cited-help-group';el.before(group);group.append(el,button);attached.set(el,button);}
   button.dataset.explanation=explanation;const name=el.getAttribute('aria-label')||el.textContent.trim().replace(/\s+/g,' ').slice(0,90);button.setAttribute('aria-label','Explain '+name);
   if(active===button)popup.textContent=explanation;
  }
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','data-operation','data-status','data-view','data-include']});
 }
 decorate();
})();
