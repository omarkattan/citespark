const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function reportRange(query={}){
 const p=new URLSearchParams();
 for(const key of ['from','to'])if(typeof query[key]==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(query[key])&&Number.isFinite(Date.parse(query[key]+'T00:00:00Z'))&&new Date(query[key]+'T00:00:00Z').toISOString().slice(0,10)===query[key])p.set(key,query[key]);
 return p;
}
export function reportLoadingHtml(project,query={}){
 const q=reportRange(query);if(query.view==='ceo')q.set('view','ceo');if(query.detail==='1')q.set('detail','1');
 const target=`/api/projects/${Number(project.id)}/report${q.size?'?'+q.toString():''}`;
 const back=`/api/projects/${Number(project.id)}/report/prepare${reportRange(query).size?'?'+reportRange(query).toString():''}`;
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preparing ${esc(project.name)} report | Cited</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap" rel="stylesheet"><style>
 *{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#12333b;font:16px/1.6 system-ui,sans-serif}main{max-width:720px;margin:8vh auto;padding:32px}:root{--display:"Instrument Serif",Georgia,serif;--mono:"IBM Plex Mono",ui-monospace,monospace;--ink:#0b1a12;--you:#157a4a}.wordmark { display: inline-flex; align-items: center; gap: 9px; text-decoration: none; }
.wordmark svg { display: block; flex: none; }
.wordmark-text {
  font-family: var(--display);
  font-size: 23px;
  line-height: 1;
  letter-spacing: -0.005em;
  color: var(--ink);
}
.wordmark-text em { font-style: normal; color: var(--you); }

.beta {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--you);
  border: 1px solid var(--you);
  border-radius: 2px;
  padding: 2px 5px;
  margin-left: 8px;
  vertical-align: middle;
  position: relative;
  top: -1px;
}.brand{margin:16px 0}.wordmark{color:var(--ink)}.wordmark:focus-visible{outline:2px solid var(--you);outline-offset:5px}h1{font:42px/1.15 Georgia,serif}h2{font-size:16px}.card{padding:24px;background:white;border:1px solid #cbd8d3;border-radius:12px}.muted{font-size:14px;color:#526a6f}a{color:#087e83}button{font:inherit;padding:12px 20px;border:0;border-radius:6px;background:#12333b;color:white;cursor:pointer}.pulse{width:38px;height:38px;border:3px solid #d4e4df;border-top-color:#087e83;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.pulse{animation:none}}blockquote{margin:28px 0;font:25px/1.4 Georgia,serif}li{margin:8px 0}[hidden]{display:none!important}@media(max-width:600px){main{padding:22px;margin:2vh auto}h1{font-size:32px}}</style></head><body><main data-report-target="${esc(target)}"><div class="brand"><a class="wordmark" href="/" title="Cited home" aria-label="Cited home"><svg width="26" height="26" viewBox="0 0 40 40" role="img" aria-hidden="true">
        <path d="M15 8H9v24h6M25 8h6v24h-6" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M20 11l2.6 6.4L29 20l-6.4 2.6L20 29l-2.6-6.4L11 20l6.4-2.6z" fill="var(--you)"/>
      </svg><span class="wordmark-text">Cit<em>ed</em></span><span class="beta" title="Cited is in beta. Things will change, and your feedback shapes what changes.">beta</span></a></div><p>${esc(project.name)} · ${query.view==='ceo'?'Executive brief':'Full report'}</p><h1>Your evidence, ready to share.</h1><div class="card"><div class="pulse" aria-hidden="true"></div><p role="status" id="reportStatus">Requesting your report…</p><p class="muted" id="elapsed">0 seconds elapsed</p><h2>What this report brings together</h2><ul><li>Stored AI answers and measurement coverage</li><li>Selected recommendations and supporting evidence</li><li>Available Search Console context and Analytics data</li></ul><p class="muted">This is a description of the report contents, not a live task checklist. No new AI checks are run.</p><button id="retry" hidden>Try again</button></div><blockquote id="reportTip">“Not another dashboard. A to-do list.”</blockquote><p class="muted">Cited reporting tips</p><a href="${esc(back)}">← Back to report preparation</a><noscript><p>JavaScript is off. <a href="${esc(target)}">Open the report directly</a>.</p></noscript></main><script src="/report-loading.js?v=80"></script><script src="/context-help.js?v=93" defer></script></body></html>`;
}
