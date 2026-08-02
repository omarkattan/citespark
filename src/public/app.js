const $ = (id) => document.getElementById(id);
const state = { projectId: null, view: 'actions', overview: null };

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const pct = (n) => `${Math.round((n || 0) * 100)}%`;

async function api(path, options) {
  const res = await fetch(path, options);
  if (res.status === 401) { window.location.href = '/login'; return null; }
  return res.json();
}

/* ---------- signature element ---------- */

function runStrip(runs) {
  const byEngine = new Map();
  for (const r of runs) {
    if (!byEngine.has(r.engine)) byEngine.set(r.engine, []);
    byEngine.get(r.engine).push(r);
  }
  const groups = [...byEngine.entries()]
    .map(([engine, list]) => {
      const ticks = list
        .map((r) => `<span class="tick ${r.mentioned ? 'hit' : 'miss'}" title="${r.mentioned ? `named at position ${r.ordinal}` : 'not named'}"></span>`)
        .join('');
      return `<div class="runstrip-group"><div class="ticks">${ticks}</div><div class="runstrip-label">${esc(engine)}</div></div>`;
    })
    .join('');
  return `<div class="runstrip">${groups}</div>`;
}

function highlight(text, brand) {
  if (!text) return '';
  const safe = esc(text);
  if (!brand) return safe;
  const re = new RegExp(`(${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

/* ---------- views ---------- */

function rateClass(rate) {
  if (rate === 0) return 'zero';
  if (rate < 0.35) return 'low';
  return 'good';
}

async function viewActions() {
  const recs = await api(`/api/projects/${state.projectId}/recommendations`);
  if (!recs?.length) {
    return `<div class="empty"><h2>No open actions</h2><p>Run a cycle to measure visibility, then the engine writes the action list from what it finds.</p></div>`;
  }
  return recs
    .map((r) => {
      const ev = r.evidence || {};
      const bits = [];
      if (ev.own_rate !== undefined) bits.push(`<span class="tag">you ${ev.own_rate}%</span>`);
      if (ev.competitor_rate !== undefined) bits.push(`<span class="tag">${esc(ev.competitor)} ${ev.competitor_rate}%</span>`);
      if (ev.citations !== undefined) bits.push(`<span class="tag">${ev.citations} citations</span>`);
      if (ev.sessions !== undefined) bits.push(`<span class="tag">${ev.sessions} sessions</span>`);
      return `
      <article class="rec" data-type="${esc(r.type)}">
        <div class="rec-top">
          <div class="rec-title">${esc(r.title)}</div>
          <div class="rec-pri">priority ${Number(r.priority).toFixed(1)} &middot; effort ${r.effort}/5</div>
        </div>
        <p class="rec-action">${esc(r.action)}</p>
        ${ev.snippet ? `<div class="excerpt">${highlight(ev.snippet, state.overview?.project?.brand_name)}</div>` : ''}
        <div class="rec-foot">
          <span class="tag">${esc(r.type.replace(/_/g, ' '))}</span>
          ${bits.join('')}
          ${r.target_url ? `<a class="tag" href="${esc(r.target_url)}" target="_blank" rel="noopener">open source</a>` : ''}
          <span style="flex:1"></span>
          <button class="ghost" data-rec="${r.id}" data-status="doing">Start</button>
          <button class="ghost" data-rec="${r.id}" data-status="done">Done</button>
          <button class="ghost" data-rec="${r.id}" data-status="dismissed">Dismiss</button>
        </div>
      </article>`;
    })
    .join('');
}

async function viewQuestions() {
  const prompts = await api(`/api/projects/${state.projectId}/prompts`);
  if (!prompts?.length) {
    return `<div class="empty"><h2>No measured questions yet</h2><p>Run a cycle to ask every tracked question across the engines.</p></div>`;
  }
  const brand = state.overview?.project?.brand_name;
  const rows = prompts
    .map((p) => {
      const chips = p.citations
        .map((c) => `<span class="chip ${c.domain === state.overview?.project?.domain?.replace(/^www\./, '') ? 'own' : ''}">${esc(c.domain)}</span>`)
        .join('');
      return `
      <div class="prompt">
        <div>
          <p class="prompt-q">${esc(p.text)}</p>
          <div class="prompt-tags">${esc(p.cluster)} &middot; ${esc(p.intent)} &middot; est. AI volume <b>${p.volume}</b></div>
          ${runStrip(p.runs)}
          ${p.snippet ? `<div class="excerpt">${highlight(p.snippet, brand)}</div>` : ''}
          ${chips ? `<div class="chips">${chips}</div>` : ''}
        </div>
        <div class="rate ${rateClass(p.rate)}">${pct(p.rate)}</div>
      </div>`;
    })
    .join('');
  return `<div class="panel"><div class="panel-head"><h2>Every tracked question</h2><div class="spacer"></div><span class="meta" style="font-family:var(--mono);font-size:11px;color:var(--ink-3)">filled tick = you were named</span></div>${rows}</div>`;
}

async function viewRivals() {
  const o = state.overview;
  if (!o?.competitors?.length) return `<div class="empty"><h2>Nothing measured yet</h2><p>Run a cycle first.</p></div>`;
  const max = Math.max(...o.competitors.map((c) => c.rate), 0.01);
  const rows = o.competitors
    .map(
      (c) => `
      <div class="sov-row">
        <div class="sov-name ${c.kind === 'owned' ? 'own' : ''}">${esc(c.name)}</div>
        <div class="sov-track"><div class="sov-fill ${c.kind === 'owned' ? 'own' : ''}" style="width:${(c.rate / max) * 100}%"></div></div>
        <div class="sov-val">${pct(c.rate)}</div>
      </div>`
    )
    .join('');
  return `<div class="panel"><div class="panel-head"><h2>Who gets named</h2></div>${rows}<p class="dek" style="margin:18px 0 0;font-size:13px">Share of answers in which each brand is named, across every tracked question and engine this cycle.</p></div>`;
}

async function viewSources() {
  const sources = await api(`/api/projects/${state.projectId}/sources`);
  if (!sources?.length) return `<div class="empty"><h2>No citations captured</h2><p>Run a cycle first.</p></div>`;
  const max = Math.max(...sources.map((s) => s.citations), 1);
  const rows = sources
    .map(
      (s) => `
      <div class="sov-row">
        <div class="sov-name ${s.owned ? 'own' : ''}">${esc(s.domain)}${s.owned ? ' (you)' : ''}</div>
        <div class="sov-track"><div class="sov-fill ${s.owned ? 'own' : ''}" style="width:${(s.citations / max) * 100}%"></div></div>
        <div class="sov-val">${s.citations}</div>
      </div>`
    )
    .join('');
  return `<div class="panel"><div class="panel-head"><h2>What the engines read</h2></div>${rows}<p class="dek" style="margin:18px 0 0;font-size:13px">These domains shape the answers in your category. Every one you are absent from is an outreach target with a measurable payoff.</p></div>`;
}

async function viewTraffic() {
  const rows = await api(`/api/projects/${state.projectId}/traffic`);
  if (!rows?.length) {
    return `<div class="empty"><h2>GA4 is not connected</h2><p>Connect Google Analytics to pull the AI Assistant channel plus a source-derived series that reaches back before the channel existed.</p></div>`;
  }
  const cells = rows
    .map((r) => {
      const cvr = r.sessions ? (r.conversions / r.sessions) * 100 : 0;
      return `<div class="figure">
        <div class="label">${esc(r.platform)} &middot; ${esc(r.classification_method)}</div>
        <div class="value">${r.sessions}</div>
        <div class="sub">${cvr.toFixed(1)}% conversion &middot; ${r.revenue ? '£' + Math.round(r.revenue) : 'no revenue'}</div>
      </div>`;
    })
    .join('');
  return `<div class="figures">${cells}</div>
    <div class="panel"><p class="dek" style="margin:0;font-size:13.5px"><b>native</b> is Google's AI Assistant channel, accurate but only from mid-2026 onward. <b>derived</b> is our own classification from session source, which works on historical data and catches platforms Google has not yet recognised. Some AI traffic still arrives without a referrer and lands in Direct, so treat both as a floor.</p></div>`;
}

/* ---------- render ---------- */

async function renderFigures() {
  const o = state.overview;
  if (!o || !o.cycle) {
    $('figures').innerHTML = `<div class="figure"><div class="label">Status</div><div class="value dim">Not run</div><div class="sub">press run cycle</div></div>`;
    return;
  }
  const engineCells = o.engines
    .map((e) => `<div class="figure"><div class="label">${esc(e.engine)}</div><div class="value">${pct(e.rate)}</div><div class="sub">${e.runs} runs</div></div>`)
    .join('');
  $('figures').innerHTML = `
    <div class="figure">
      <div class="label">Visibility</div>
      <div class="value">${pct(o.visibility)}</div>
      <div class="sub">${o.runs} answers read</div>
    </div>
    <div class="figure">
      <div class="label">Avg position in answer</div>
      <div class="value ${o.avgOrdinal ? '' : 'dim'}">${o.avgOrdinal ? o.avgOrdinal.toFixed(1) : '-'}</div>
      <div class="sub">1 is first named</div>
    </div>
    ${engineCells}
    <div class="figure">
      <div class="label">Cycle cost</div>
      <div class="value">$${(o.spend || 0).toFixed(2)}</div>
      <div class="sub">${esc(o.cycle)}</div>
    </div>`;
}

async function render() {
  const view = state.view;
  $('view').innerHTML = '<div class="empty">Loading</div>';
  const fn = { actions: viewActions, questions: viewQuestions, rivals: viewRivals, sources: viewSources, traffic: viewTraffic }[view];
  $('view').innerHTML = await fn();
}

async function loadProject(id) {
  state.projectId = id;
  state.overview = await api(`/api/projects/${id}/overview`);
  const p = state.overview.project;
  $('brandTitle').textContent = p.brand_name;
  $('brandDek').textContent = state.overview.cycle
    ? `Measured across ${state.overview.runs} answers on ${state.overview.cycle}. Every action below is derived from that evidence.`
    : 'Nothing measured yet. Run a cycle to ask every tracked question across the engines.';
  $('cycleMeta').textContent = state.overview.cycle ? `cycle ${state.overview.cycle}` : 'no data';
  await renderFigures();
  await render();
}

async function boot() {
  const me = await api('/api/me');
  if (!me?.signedIn) { window.location.href = '/login'; return; }
  if (me.mock) $('mockNotice').hidden = false;

  const projects = await api('/api/projects');
  if (!projects?.length) {
    $('view').innerHTML = `<div class="empty"><h2>No projects yet</h2><p>Run <code>npm run seed</code> to create one.</p></div>`;
    return;
  }
  $('projectPicker').innerHTML = projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  await loadProject(projects[0].id);
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', async () => {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    state.view = tab.dataset.view;
    await render();
  });
});

$('projectPicker').addEventListener('change', (e) => loadProject(Number(e.target.value)));

$('signOut').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
});

$('runBtn').addEventListener('click', async () => {
  $('runBtn').disabled = true;
  $('runBtn').textContent = 'Running';
  await api(`/api/projects/${state.projectId}/run`, { method: 'POST' });
  setTimeout(async () => {
    await loadProject(state.projectId);
    $('runBtn').disabled = false;
    $('runBtn').textContent = 'Run cycle';
  }, 12000);
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-rec]');
  if (!btn) return;
  await fetch(`/api/recommendations/${btn.dataset.rec}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: btn.dataset.status })
  });
  await render();
});

boot();
