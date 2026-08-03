const $ = (id) => document.getElementById(id);
const state = { projectId: null, view: 'actions', overview: null, interval: null };

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
  const filter = state.taskFilter || 'active';
  const data = await api(`/api/projects/${state.projectId}/recommendations?status=${filter}`);
  if (!data) return '';
  state.people = data.people || [];

  const c = data.counts;
  const tab = (id, label, n) =>
    `<button class="tfilter ${filter === id ? 'is-on' : ''}" data-task-filter="${id}">${label}${n !== null ? ` <span>${n}</span>` : ''}</button>`;

  const bar = `<div class="taskbar">
      ${tab('active', 'To do', c.open + c.doing)}
      ${tab('doing', 'In progress', c.doing)}
      ${tab('done', 'Done', c.done)}
      ${tab('dismissed', 'Dismissed', c.dismissed)}
      ${tab('all', 'Everything', c.total)}
      <span class="spacer"></span>
      ${c.overdue ? `<span class="tag overdue">${c.overdue} overdue</span>` : ''}
    </div>`;

  if (!data.tasks.length) {
    return bar + `<div class="empty"><h2>${
      filter === 'done' ? 'Nothing finished yet' : filter === 'dismissed' ? 'Nothing dismissed' : 'Nothing to do here'
    }</h2><p>${
      filter === 'active'
        ? 'Run a cycle and the engine writes the task list from what it finds.'
        : 'Try another filter.'
    }</p></div>`;
  }

  return bar + data.tasks.map(taskCard).join('');
}

const STATUS_LABEL = { open: 'To do', doing: 'In progress', done: 'Done', dismissed: 'Dismissed' };

function dueLabel(t) {
  if (!t.due_date) return '';
  const d = new Date(t.due_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  const when = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const live = t.status === 'open' || t.status === 'doing';

  if (!live) return `<span class="tag">due ${when}</span>`;
  if (days < 0) return `<span class="tag overdue">${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue</span>`;
  if (days === 0) return `<span class="tag soon">due today</span>`;
  if (days <= 3) return `<span class="tag soon">due in ${days} day${days === 1 ? '' : 's'}</span>`;
  return `<span class="tag">due ${when}</span>`;
}

function taskCard(t) {
  const ev = t.evidence || {};
  const bits = [];
  if (ev.own_rate !== undefined) bits.push(`<span class="tag">you ${ev.own_rate}%</span>`);
  if (ev.competitor_rate !== undefined) bits.push(`<span class="tag">${esc(ev.competitor)} ${ev.competitor_rate}%</span>`);
  if (ev.citations !== undefined) bits.push(`<span class="tag">${ev.citations} citations</span>`);
  if (ev.sessions !== undefined) bits.push(`<span class="tag">${ev.sessions} sessions</span>`);
  if (ev.queries) bits.push(...ev.queries.slice(0, 2).map((q) => `<span class="tag">${esc(q)}</span>`));

  const buttons = {
    open: [['doing', 'Start'], ['done', 'Done'], ['dismissed', 'Dismiss']],
    doing: [['done', 'Mark done'], ['open', 'Back to to-do']],
    done: [['open', 'Reopen']],
    dismissed: [['open', 'Restore']]
  }[t.status] || [];

  return `
  <article class="rec ${t.status}" data-type="${esc(t.type)}" data-task="${t.id}">
    <div class="rec-top">
      <div class="rec-title">${esc(t.title)}</div>
      <div class="rec-pri">priority ${Number(t.priority).toFixed(1)} &middot; effort ${Number(t.effort)}/5</div>
    </div>

    <div class="task-meta">
      <span class="status-chip ${t.status}">${STATUS_LABEL[t.status]}</span>
      ${t.assignee ? `<span class="tag person">${esc(t.assignee)}</span>` : ''}
      ${dueLabel(t)}
      ${t.notes ? '<span class="tag">has notes</span>' : ''}
    </div>

    <p class="rec-action">${esc(t.action)}</p>
    ${ev.snippet ? `<div class="excerpt">${highlight(ev.snippet, state.overview?.project?.brand_name)}</div>` : ''}

    <div class="rec-foot">
      <span class="tag">${esc(t.type.replace(/_/g, ' '))}</span>
      ${bits.join('')}
      ${t.target_url ? `<a class="tag" href="${esc(t.target_url)}" target="_blank" rel="noopener">open source</a>` : ''}
      <span style="flex:1"></span>
      <button class="ghost" data-task-edit="${t.id}">${t.assignee || t.due_date || t.notes ? 'Edit' : 'Assign'}</button>
      ${buttons.map(([st, label]) => `<button class="ghost" data-rec="${t.id}" data-status="${st}">${label}</button>`).join('')}
    </div>

    <div class="task-edit" id="edit-${t.id}" hidden>
      <div class="task-edit-row">
        <div class="field">
          <label for="a-${t.id}">Who is doing it</label>
          <input id="a-${t.id}" list="people-list" value="${esc(t.assignee || '')}" placeholder="Name or email" />
        </div>
        <div class="field">
          <label for="d-${t.id}">Due by</label>
          <input id="d-${t.id}" type="date" value="${t.due_date ? String(t.due_date).slice(0, 10) : ''}" />
        </div>
      </div>
      <div class="field">
        <label for="n-${t.id}">Notes</label>
        <textarea id="n-${t.id}" rows="3" placeholder="What was changed, what is blocking it, links to the work">${esc(t.notes || '')}</textarea>
      </div>
      <div class="task-edit-foot">
        <button data-task-save="${t.id}">Save</button>
        <button class="ghost" data-task-cancel="${t.id}">Cancel</button>
        <span class="hint" id="saved-${t.id}"></span>
      </div>
    </div>
  </article>`;
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
          ${p.fanOut?.length ? `<div class="fanout"><span class="fanout-label">searched for</span>${p.fanOut.map((q) => `<span class="chip">${esc(q)}</span>`).join('')}</div>` : ''}
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
  const [conn, rows] = await Promise.all([
    api(`/api/projects/${state.projectId}/ga4`),
    api(`/api/projects/${state.projectId}/traffic`)
  ]);
  if (!conn) return '';

  /* not connected */
  if (!conn.connected) {
    const others = (await api('/api/ga4/connections'))?.connections || [];
    const reuse = others.length
      ? `<div class="reuse">
          <p class="reuse-label">Already connected on this account</p>
          ${others
            .map(
              (o) => `<div class="row">
                <div class="grow"><div class="name">${esc(o.email)}</div><div class="sub">used on ${o.sites} site${o.sites === 1 ? '' : 's'}</div></div>
                <button class="ghost" data-ga4-reuse="${esc(o.email)}">Use here too</button>
              </div>`
            )
            .join('')}
          <p class="hint" style="margin-top:10px">Or connect a different Google account below.</p>
        </div>`
      : '';

    return `<div class="panel connect-card">
      <div class="connect-mark">
        <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="15" y="3" width="5" height="18" rx="2.5" fill="var(--you)"/>
          <rect x="9.5" y="8" width="5" height="13" rx="2.5" fill="var(--you)" opacity="0.65"/>
          <rect x="4" y="13" width="5" height="8" rx="2.5" fill="var(--you)" opacity="0.4"/>
        </svg>
      </div>
      <h2>Connect Google Analytics</h2>
      <p class="dek" style="max-width:56ch">
        This is where visibility turns into money. We read the AI Assistant channel Google added in 2026,
        and run our own classification from session source so your history reaches back before that channel existed.
      </p>
      <ul class="connect-list">
        <li>Sessions and conversions from ChatGPT, Perplexity, Gemini, Claude and Copilot</li>
        <li>Which landing pages AI traffic actually converts on</li>
        <li>Read-only access, and you can disconnect at any time</li>
      </ul>
      ${reuse}
      ${conn.configured
        ? `<button id="ga4Connect">${others.length ? 'Connect a different Google account' : 'Connect Google Analytics'}</button>`
        : `<p class="notice" style="margin:0">Google sign-in is not configured on this deployment. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.</p>`}
      <p class="error" id="ga4Error" role="alert"></p>
    </div>`;
  }

  /* connected but no property chosen yet */
  if (!conn.propertyId) {
    return `<div class="panel">
      <div class="panel-head">
        <h2>Choose a property</h2>
        <div class="spacer"></div>
        <button class="ghost" id="ga4Disconnect">Disconnect</button>
      </div>
      <p class="dek" style="margin-bottom:16px">
        Connected as <b>${esc(conn.email || 'your Google account')}</b>. Pick the property that measures ${esc(state.overview?.project?.domain || 'this site')}.
      </p>
      <div id="ga4Props"><p class="hint">Loading your properties</p></div>
      <p class="hint" style="margin-top:14px">
        Wrong account? <button type="button" class="ghost" id="ga4Reconnect" style="padding:4px 9px;font-size:10px">Connect a different one</button>
      </p>
      <p class="error" id="ga4Error" role="alert"></p>
    </div>`;
  }

  /* connected and configured */
  const totals = (rows || []).reduce(
    (acc, r) => {
      if (r.classification_method === 'derived') {
        acc.sessions += r.sessions;
        acc.conversions += Number(r.conversions);
        acc.revenue += Number(r.revenue);
      }
      return acc;
    },
    { sessions: 0, conversions: 0, revenue: 0 }
  );
  const cvr = totals.sessions ? (totals.conversions / totals.sessions) * 100 : 0;

  const cells = (rows || [])
    .map((r) => {
      const rate = r.sessions ? (r.conversions / r.sessions) * 100 : 0;
      return `<div class="figure">
        <div class="label">${esc(r.platform)} &middot; ${esc(r.classification_method)}</div>
        <div class="value">${r.sessions}</div>
        <div class="sub">${rate.toFixed(1)}% conversion${r.revenue ? ` &middot; ${Math.round(r.revenue)}` : ''}</div>
      </div>`;
    })
    .join('');

  return `
  <div class="panel">
    <div class="panel-head">
      <h2>Google Analytics</h2>
      <div class="spacer"></div>
      <button class="ghost" id="ga4Sync">Sync now</button>
      <button class="ghost" id="ga4Reconnect">Change account</button>
      <button class="ghost" id="ga4Disconnect">Disconnect</button>
    </div>
    <div class="conn-status">
      <span class="tag ok">Connected</span>
      ${conn.email ? `<span class="tag">${esc(conn.email)}</span>` : ''}
      <span class="tag">${esc(conn.propertyName || `property ${conn.propertyId}`)}</span>
      ${conn.syncedAt ? `<span class="tag">synced ${esc(shortDate(conn.syncedAt))}</span>` : '<span class="tag soon">never synced</span>'}
      <button class="ghost" id="ga4Change" style="padding:4px 9px;font-size:10px">Change property</button>
    </div>
    <p class="error" id="ga4Error" role="alert"></p>
  </div>

  ${rows?.length ? `
  <div class="figures">
    <div class="figure">
      <div class="label">AI sessions, 30 days</div>
      <div class="value">${totals.sessions.toLocaleString()}</div>
      <div class="sub">${cvr.toFixed(1)}% conversion</div>
    </div>
    <div class="figure">
      <div class="label">Conversions</div>
      <div class="value">${Math.round(totals.conversions).toLocaleString()}</div>
      <div class="sub">from AI referrals</div>
    </div>
    <div class="figure">
      <div class="label">Revenue</div>
      <div class="value">${totals.revenue ? Math.round(totals.revenue).toLocaleString() : '-'}</div>
      <div class="sub">attributed, 30 days</div>
    </div>
  </div>
  <div class="figures">${cells}</div>
  <div class="panel"><p class="dek" style="margin:0;font-size:13.5px">
    <b>native</b> is Google's AI Assistant channel, accurate but only from mid-2026 onward.
    <b>derived</b> is our own classification from session source, which works on historical data and catches
    platforms Google has not yet recognised. Some AI traffic arrives with no referrer and lands in Direct,
    so treat both as a floor rather than a total.
  </p></div>`
    : `<div class="empty"><h2>No data yet</h2><p>Press <b>Sync now</b> to pull the last 18 months. It takes a minute the first time.</p></div>`}`;
}

async function loadGa4Properties() {
  const box = $('ga4Props');
  if (!box) return;
  const res = await fetch(`/api/projects/${state.projectId}/ga4/properties`);
  const d = await res.json();
  if (!res.ok) { box.innerHTML = `<p class="error">${esc(d.error)}</p>`; return; }
  if (!d.properties.length) {
    box.innerHTML = `<p class="hint">That Google account cannot see any GA4 properties. Connect a different account, or ask for read access.</p>`;
    return;
  }
  box.innerHTML = d.properties
    .map(
      (p) => `<div class="row">
        <div class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.account)} &middot; ${esc(p.id)}</div></div>
        <button class="ghost" data-ga4-pick="${esc(p.id)}" data-ga4-name="${esc(p.name)}">Use this</button>
      </div>`
    )
    .join('');
}

document.addEventListener('click', async (e) => {
  const err = (m) => { const el = $('ga4Error'); if (el) el.textContent = m || ''; };

  if (e.target.id === 'ga4Connect') {
    e.target.disabled = true;
    const res = await fetch(`/api/projects/${state.projectId}/ga4/connect`);
    const d = await res.json();
    if (!res.ok) { err(d.error); e.target.disabled = false; return; }
    window.location.href = d.url;
  }

  if (e.target.id === 'ga4Disconnect') {
    if (!confirm('Disconnect Google Analytics from this site? Traffic data already pulled is kept.')) return;
    await fetch(`/api/projects/${state.projectId}/ga4/disconnect`, { method: 'POST' });
    await render();
  }

  if (e.target.id === 'ga4Reconnect') {
    e.target.disabled = true;
    const res = await fetch(`/api/projects/${state.projectId}/ga4/connect`);
    const d = await res.json();
    if (!res.ok) { err(d.error); e.target.disabled = false; return; }
    window.location.href = d.url;
  }

  const reuse = e.target.closest('[data-ga4-reuse]');
  if (reuse) {
    reuse.disabled = true;
    const res = await fetch(`/api/projects/${state.projectId}/ga4/reuse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: reuse.dataset.ga4Reuse })
    });
    if (!res.ok) { err((await res.json()).error); reuse.disabled = false; return; }
    await render();
    loadGa4Properties();
  }

  if (e.target.id === 'ga4Change') {
    await fetch(`/api/projects/${state.projectId}/ga4/property`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ propertyId: '' })
    });
    await render();
    loadGa4Properties();
  }

  const pick = e.target.closest('[data-ga4-pick]');
  if (pick) {
    pick.disabled = true;
    const res = await fetch(`/api/projects/${state.projectId}/ga4/property`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ propertyId: pick.dataset.ga4Pick, propertyName: pick.dataset.ga4Name })
    });
    if (!res.ok) { err((await res.json()).error); pick.disabled = false; return; }
    await render();
  }

  if (e.target.id === 'ga4Sync') {
    e.target.disabled = true;
    e.target.textContent = 'Syncing';
    const res = await fetch(`/api/projects/${state.projectId}/sync-ga4`, { method: 'POST' });
    const d = await res.json();
    e.target.disabled = false;
    e.target.textContent = 'Sync now';
    if (!res.ok) err(d.error);
    else if (d.skipped) err(d.reason);
    else await render();
  }
});

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
  const fn = { actions: viewActions, questions: viewQuestions, rivals: viewRivals, sources: viewSources, traffic: viewTraffic, setup: viewSetup, billing: viewBilling, trends: viewTrends }[view];
  $('view').innerHTML = await fn();
  if (view === 'setup') recalcEstimate();
  if (view === 'traffic' && $('ga4Props')) loadGa4Properties();
  if (view === 'actions' && state.people?.length) {
    const dl = document.createElement('datalist');
    dl.id = 'people-list';
    dl.innerHTML = state.people.map((p) => `<option value="${esc(p)}"></option>`).join('');
    $('view').appendChild(dl);
  }
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
  const short = p.name.length > 18 ? p.name.slice(0, 17) + '\u2026' : p.name;
  $('runBtn').textContent = `Run ${short}`;
  $('runBtn').title = `Runs a cycle for ${p.name} only`;
  await renderFigures();
  await render();
}

async function loadProjectList(selectId) {
  const projects = await api('/api/projects');
  if (!projects?.length) {
    $('projectPicker').innerHTML = '';
    $('brandTitle').textContent = 'No sites yet';
    $('brandDek').textContent = 'Add your first site to start measuring what the answer engines say about it.';
    $('figures').innerHTML = '';
    $('view').innerHTML = `<div class="empty"><h2>Nothing tracked yet</h2><p>Press <b>Add site</b> in the top bar. Give us the domain, what the business does and who it sells to, and we will write the question set for you.</p></div>`;
    return false;
  }
  const chosen = selectId && projects.some((p) => p.id === selectId) ? selectId : projects[0].id;
  $('projectPicker').innerHTML = projects
    .map((p) => `<option value="${p.id}" ${p.id === chosen ? 'selected' : ''}>${esc(p.name)}</option>`)
    .join('');
  await loadProject(chosen);
  return true;
}

function handleGa4Return() {
  const params = new URLSearchParams(location.search);
  const status = params.get('ga4');
  if (!status) return null;
  history.replaceState({}, '', '/app');
  return status === 'connected'
    ? { ok: true }
    : { ok: false, message: params.get('message') || 'Could not connect Google Analytics' };
}

async function boot() {
  const ga4 = handleGa4Return();
  const me = await api('/api/me');
  if (!me?.signedIn) { window.location.href = '/login'; return; }
  if (me.mock) $('mockNotice').hidden = false;
  await loadProjectList();
  await refreshUsagePill();

  if (ga4) {
    document.querySelector('.tab[data-view="traffic"]').click();
    if (!ga4.ok) setTimeout(() => { const el = $('ga4Error'); if (el) el.textContent = ga4.message; }, 400);
  }

  // Someone may have started a cycle then refreshed or switched device.
  const running = await api(`/api/projects/${state.projectId}/cycle-status`);
  if (running && ['starting', 'asking', 'thinking'].includes(running.phase)) {
    $('runBtn').disabled = true;
    $('runBtn').textContent = 'Running';
    const tick = async () => {
      const finished = await pollCycle();
      if (finished) { $('runBtn').disabled = false; resetRunLabel(); }
      else setTimeout(tick, 1500);
    };
    tick();
  }
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

/* ---------- running a cycle ---------- */

function resetRunLabel() {
  const name = state.overview?.project?.name || 'cycle';
  const short = name.length > 18 ? name.slice(0, 17) + '\u2026' : name;
  $('runBtn').textContent = `Run ${short}`;
}

const PHASE_LABEL = {
  starting: 'Starting up',
  asking: 'Asking the engines',
  thinking: 'Reading answers and writing your actions',
  done: 'Finished'
};

function showProgress(phase, done, total) {
  $('cycleBar').hidden = false;
  $('cycleLabel').textContent = PHASE_LABEL[phase] || 'Working';
  $('cycleCount').textContent = total ? `${done} of ${total} answers` : '';
  const pct = phase === 'thinking' ? 100 : total ? Math.round((done / total) * 100) : 5;
  $('cycleFill').style.width = `${Math.max(3, pct)}%`;
}

function hideProgress() {
  $('cycleBar').hidden = true;
  $('cycleFill').style.width = '0%';
}

function deltaFig(s) {
  if (s.delta === null || s.delta === undefined) {
    return `<div class="report-fig"><div class="k">Change</div><div class="v">-</div><div class="n">first cycle, nothing to compare</div></div>`;
  }
  const pts = Math.round(s.delta * 100);
  const dir = pts > 0 ? 'up' : pts < 0 ? 'down' : '';
  return `<div class="report-fig">
    <div class="k">Change</div>
    <div class="v ${dir}">${pts > 0 ? '+' : ''}${pts}<span style="font-size:15px"> pts</span></div>
    <div class="n">was ${Math.round(s.visibilityBefore * 100)}%</div>
  </div>`;
}

function headline(s) {
  if (s.visibility === 0) {
    return `No engine named you in any of the ${s.runs} answers we read. Every action below exists to change that.`;
  }
  if (s.delta !== null && Math.round(s.delta * 100) <= -10) {
    return `You slipped ${Math.abs(Math.round(s.delta * 100))} points since the last cycle. The decline actions below are worth reading first.`;
  }
  if (s.delta !== null && Math.round(s.delta * 100) >= 10) {
    return `Up ${Math.round(s.delta * 100)} points since the last cycle. Whatever you shipped is working, so the actions below are about widening the lead.`;
  }
  if (s.topRival && s.topRival.rate > (s.visibility || 0) + 0.2) {
    return `${esc(s.topRival.name)} is named in ${Math.round(s.topRival.rate * 100)}% of answers against your ${Math.round((s.visibility || 0) * 100)}%. Closing that gap is what the top actions are for.`;
  }
  return `You were named in ${Math.round((s.visibility || 0) * 100)}% of the ${s.runs} answers we read. Here is what to do about the rest.`;
}

function failureNote(s) {
  if (!s.failed?.length) return '';
  const total = s.failed.reduce((n, f) => n + f.count, 0);
  const list = s.failed
    .map((f) => `<b>${esc(f.engine)}</b> failed ${f.count} time${f.count === 1 ? '' : 's'}${f.error ? ` (${esc(f.error)})` : ''}`)
    .join(', ');
  return `<p class="report-warn">${total} of ${s.attempted} calls did not return an answer. ${list}. Those were not charged to your allowance, and the visibility figure above ignores them.</p>`;
}

function showReport(s) {
  const sources = s.topSources?.length
    ? `<p class="report-lede" style="margin-top:14px;font-size:13.5px;color:var(--ink-3)">
         Most cited sources this cycle: ${s.topSources.map((x) => `<b>${esc(x.domain)}</b>`).join(', ')}.
       </p>`
    : '';

  $('cycleReport').innerHTML = `
    <div class="report">
      <button class="report-close" aria-label="Dismiss" data-close-report>&times;</button>
      <div class="report-top"><h2>Cycle finished</h2></div>
      <p class="report-lede">${headline(s)}</p>
      ${failureNote(s)}

      <div class="report-figures">
        <div class="report-fig">
          <div class="k">Visibility</div>
          <div class="v">${Math.round((s.visibility || 0) * 100)}%</div>
          <div class="n">${s.runs} answers read${s.attempted && s.attempted !== s.runs ? ` of ${s.attempted}` : ''}</div>
        </div>
        ${deltaFig(s)}
        <div class="report-fig">
          <div class="k">Open actions</div>
          <div class="v">${s.openActions}</div>
          <div class="n">${s.recommendations} refreshed this cycle</div>
        </div>
        <div class="report-fig">
          <div class="k">Cost</div>
          <div class="v">$${(s.spend || 0).toFixed(2)}</div>
          <div class="n">${
            s.estimated && s.spend !== null && s.estimated > s.spend * 1.15
              ? `estimated $${s.estimated.toFixed(2)}, came in under`
              : s.trimmed ? 'trimmed to your allowance' : 'actual, this cycle'
          }${s.billable !== undefined && s.billable !== s.attempted ? ` &middot; ${s.billable} checks used` : ''}</div>
        </div>
      </div>

      ${s.topActions?.length ? `<ul class="report-list">${s.topActions.map((a) => `<li>${esc(a.title)}</li>`).join('')}</ul>` : ''}
      ${sources}

      <div class="report-actions" style="margin-top:16px">
        <button data-report-goto="actions">See all ${s.openActions} actions</button>
        <button class="ghost" data-report-goto="questions">Question by question</button>
        <button class="ghost" data-report-goto="sources">Who gets cited</button>
      </div>
    </div>`;
  $('cycleReport').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function pollCycle() {
  const status = await api(`/api/projects/${state.projectId}/cycle-status`);
  if (!status) return true;

  if (status.phase === 'failed') {
    hideProgress();
    setupErr(status.error);
    return true;
  }
  if (status.phase === 'done') {
    hideProgress();
    await loadProject(state.projectId);
    await refreshUsagePill();
    if (status.summary) showReport(status.summary);
    return true;
  }
  if (status.phase === 'idle') {
    hideProgress();
    await loadProject(state.projectId);
    return true;
  }
  showProgress(status.phase, status.done || 0, status.total || 0);
  return false;
}

$('runBtn').addEventListener('click', async () => {
  const btn = $('runBtn');
  btn.disabled = true;
  btn.textContent = 'Starting';
  $('cycleReport').hidden = true;

  const res = await fetch(`/api/projects/${state.projectId}/run`, { method: 'POST' });
  const json = await res.json();

  if (!res.ok) {
    btn.disabled = false;
    resetRunLabel();
    if (res.status === 402) {
      alert(json.error);
      document.querySelector('.tab[data-view="billing"]').click();
    } else {
      alert(json.error || 'Could not start the cycle.');
    }
    return;
  }

  btn.textContent = 'Running';
  showProgress('starting', 0, json.calls);

  const tick = async () => {
    const finished = await pollCycle();
    if (finished) {
      btn.disabled = false;
      resetRunLabel();
    } else {
      setTimeout(tick, 1500);
    }
  };
  setTimeout(tick, 1200);
});

$('runMoreBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !$('runMenu').hidden;
  $('runMenu').hidden = open;
  $('runMoreBtn').setAttribute('aria-expanded', String(!open));
});

document.addEventListener('click', () => {
  $('runMenu').hidden = true;
  $('runMoreBtn').setAttribute('aria-expanded', 'false');
});

$('runAllBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  $('runMenu').hidden = true;
  const res = await fetch('/api/run-all', { method: 'POST' });
  const json = await res.json();
  if (!res.ok) { alert(json.error || 'Could not start.'); return; }

  const lines = [];
  if (json.started.length) {
    lines.push(`Started ${json.started.length} site${json.started.length === 1 ? '' : 's'}: ${json.started.map((s) => s.name).join(', ')}.`);
  }
  if (json.skipped.length) {
    lines.push(`Skipped ${json.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}.`);
  }
  alert(lines.join('\n\n') || 'Nothing to run.');

  if (json.started.some((s) => s.id === state.projectId)) {
    $('runBtn').disabled = true;
    $('runBtn').textContent = 'Running';
    const tick = async () => {
      const finished = await pollCycle();
      if (finished) { $('runBtn').disabled = false; resetRunLabel(); }
      else setTimeout(tick, 1500);
    };
    setTimeout(tick, 1200);
  }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-report]')) $('cycleReport').hidden = true;
  const goto = e.target.closest('[data-report-goto]');
  if (goto) {
    document.querySelector(`.tab[data-view="${goto.dataset.reportGoto}"]`).click();
    document.querySelector('.tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

document.addEventListener('click', async (e) => {
  const tf = e.target.closest('[data-task-filter]');
  if (tf) {
    state.taskFilter = tf.dataset.taskFilter;
    await render();
    return;
  }

  const edit = e.target.closest('[data-task-edit]');
  if (edit) {
    const box = $(`edit-${edit.dataset.taskEdit}`);
    box.hidden = !box.hidden;
    if (!box.hidden) box.querySelector('input')?.focus();
    return;
  }

  const cancel = e.target.closest('[data-task-cancel]');
  if (cancel) { $(`edit-${cancel.dataset.taskCancel}`).hidden = true; return; }

  const save = e.target.closest('[data-task-save]');
  if (save) {
    const id = save.dataset.taskSave;
    save.disabled = true;
    const res = await fetch(`/api/recommendations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignee: $(`a-${id}`).value,
        dueDate: $(`d-${id}`).value,
        notes: $(`n-${id}`).value
      })
    });
    save.disabled = false;
    if (res.ok) {
      const updated = await res.json();
      replaceCard(id, updated);
    } else {
      const j = await res.json();
      $(`saved-${id}`).textContent = j.error || 'Could not save';
    }
    return;
  }

  const btn = e.target.closest('button[data-rec]');
  if (!btn) return;

  btn.disabled = true;
  const res = await fetch(`/api/recommendations/${btn.dataset.rec}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: btn.dataset.status })
  });
  btn.disabled = false;
  if (!res.ok) return;

  const updated = await res.json();
  const filter = state.taskFilter || 'active';
  const stillVisible =
    filter === 'all' ||
    (filter === 'active' && ['open', 'doing'].includes(updated.status)) ||
    filter === updated.status;

  // Moving a task out of the current filter should say so rather than
  // having it vanish with no explanation.
  if (stillVisible) replaceCard(btn.dataset.rec, updated);
  else {
    const card = document.querySelector(`[data-task="${btn.dataset.rec}"]`);
    if (card) {
      card.classList.add('leaving');
      card.innerHTML = `<p class="rec-action">Moved to <b>${STATUS_LABEL[updated.status]}</b>. <button class="ghost" data-task-filter="${updated.status}">Show ${STATUS_LABEL[updated.status].toLowerCase()}</button></p>`;
      setTimeout(() => card.remove(), 4000);
    }
    await refreshTaskCounts();
  }
});

/** Swap one card without re-rendering the list and losing scroll position. */
function replaceCard(id, task) {
  const card = document.querySelector(`[data-task="${id}"]`);
  if (!card) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = taskCard(task);
  card.replaceWith(wrapper.firstElementChild);
  refreshTaskCounts();
}

async function refreshTaskCounts() {
  const data = await api(`/api/projects/${state.projectId}/recommendations?status=${state.taskFilter || 'active'}`);
  if (!data) return;
  const c = data.counts;
  const set = (id, n) => {
    const el = document.querySelector(`[data-task-filter="${id}"] span`);
    if (el) el.textContent = n;
  };
  set('active', c.open + c.doing);
  set('doing', c.doing);
  set('done', c.done);
  set('dismissed', c.dismissed);
  set('all', c.total);
}

/* ---------- setup ---------- */

async function viewSetup() {
  const [data, engines, billing] = await Promise.all([
    api(`/api/projects/${state.projectId}/setup`),
    state.engines ? Promise.resolve(state.engines) : api('/api/engines'),
    api('/api/billing')
  ]);
  if (!data) return '';
  state.engines = engines;
  state.costs = data.costs || {};
  state.measured = data.measured || [];
  const p = data.project;
  const rivals = data.entities.filter((e) => e.kind === 'competitor');
  const active = data.prompts.filter((q) => q.active).length;

  const rivalRows = rivals.length
    ? rivals
        .map(
          (e) => `<div class="row">
            <div class="grow"><div class="name">${esc(e.name)}</div><div class="sub">${esc(e.domain || 'no domain set')}</div></div>
            <button class="ghost" data-del-entity="${e.id}">Remove</button>
          </div>`
        )
        .join('')
    : `<p class="sub" style="font-family:var(--mono);font-size:12px;color:var(--ink-3)">No competitors yet. Add the ones you actually lose pitches to.</p>`;

  const promptRows = data.prompts
    .map(
      (q) => `<div class="row ${q.active ? '' : 'off'}">
        <div class="grow">
          <div class="name">${esc(q.text)}</div>
          <div class="sub">${esc(q.cluster)} &middot; ${esc(q.intent)} &middot; volume ${q.ai_search_volume}</div>
        </div>
        <button class="ghost" data-toggle-prompt="${q.id}" data-active="${q.active}">${q.active ? 'Pause' : 'Resume'}</button>
        <button class="ghost" data-del-prompt="${q.id}">Delete</button>
      </div>`
    )
    .join('');

  const chosen = p.engines?.length ? p.engines : ['chatgpt'];
  const allowed = billing?.plan?.engines ?? 1;
  const cost = active * chosen.length * (p.runs_per_cycle || 3);

  const engineRows = engines
    .map((e) => {
      const on = chosen.includes(e.id);
      const blocked = !on && chosen.length >= allowed;
      return `<div class="row ${blocked ? 'off' : ''}">
        <label class="grow eng">
          <input type="checkbox" data-engine="${e.id}" ${on ? 'checked' : ''} ${blocked ? 'disabled' : ''} />
          <span><span class="name">${esc(e.label)}</span><span class="sub">${esc(e.note || '')}</span></span>
        </label>
      </div>`;
    })
    .join('');

  return `
  <div class="setup-grid">
    <div>
      <div class="panel">
        <div class="panel-head"><h2>This site</h2></div>
        <div class="field"><label for="s_name">Project name</label><input id="s_name" value="${esc(p.name)}" /></div>
        <div class="field"><label for="s_brand">Brand name</label><input id="s_brand" value="${esc(p.brand_name)}" /></div>
        <div class="field"><label for="s_aliases">Also known as, comma separated</label><input id="s_aliases" value="${esc((p.aliases || []).join(', '))}" placeholder="Shortenings, misspellings, the legal name" /></div>
        <div class="field"><label for="s_category">What the business does</label><input id="s_category" value="${esc(p.category || '')}" /></div>
        <div class="field"><label for="s_qualifier">Who the customer is</label><input id="s_qualifier" value="${esc(p.qualifier || '')}" /></div>
        <div class="field"><label for="s_market">Market</label><select id="s_market">${window.countryOptions(p.market)}</select></div>
        <div class="field"><label for="s_runs">Runs per question, per engine</label><input id="s_runs" type="number" min="1" max="10" value="${p.runs_per_cycle}" /></div>
        <div class="field">
          <label>Automatic weekly cycle</label>
          <label class="eng" style="padding:4px 0">
            <input type="checkbox" id="s_auto" ${p.auto_cycle ? 'checked' : ''} />
            <span><span class="name">Run this site every week without being asked</span>
            <span class="sub">Turn off to keep the site set up but stop it spending anything until you run it by hand.</span></span>
          </label>
        </div>
        <div class="estimate" data-active-count="${active}" data-runs="${p.runs_per_cycle}">
          <div class="estimate-line">
            <span data-n>${active}</span> questions &times;
            <span data-surfaces-n>${chosen.length}</span> <span data-surfaces-word>${chosen.length === 1 ? 'surface' : 'surfaces'}</span> &times;
            <span data-runs-n>${p.runs_per_cycle}</span> runs =
            <b data-calls>${cost}</b> answer checks
          </div>
          <div class="estimate-cost">
            <span class="amt" data-cycle-cost>-</span>
            <span class="per" data-cost-label>per cycle</span>
            <span class="month" data-month-cost></span>
          </div>
          <p class="hint" data-cost-source style="margin-top:8px"></p>
        </div>
        <button id="s_save">Save changes</button>
        <span id="s_saved" class="sub" style="font-family:var(--mono);font-size:11px;color:var(--good);margin-left:10px"></span>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>Where we look</h2>
          <div class="spacer"></div>
          <div class="bulk">
            <button class="ghost" data-bulk-engines="all">Use all ${Math.min(allowed, engines.length)}</button>
            <button class="ghost" data-bulk-engines="min">Just ChatGPT</button>
          </div>
          <span class="sub" data-engine-allowance="${allowed}" style="font-family:var(--mono);font-size:11px;color:var(--ink-3);margin-left:10px">${chosen.length} of ${allowed} allowed</span>
        </div>
        ${engineRows}
        <p class="hint" style="margin-top:12px">
          Each surface you add multiplies the cost of every cycle. Two or three chosen deliberately beats all six switched on.
          ${allowed < engines.length ? `Your plan allows ${allowed}. <button type="button" class="ghost" data-goto-billing="1" style="padding:3px 8px;font-size:10px">Upgrade</button>` : ''}
        </p>
        <span id="e_saved" class="sub" style="font-family:var(--mono);font-size:11px;color:var(--good)"></span>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>Competitors</h2></div>
        ${rivalRows}
        <div class="inline-form">
          <input id="r_name" placeholder="Name" />
          <input id="r_domain" placeholder="domain.com" />
          <button id="r_add">Add</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>Remove this site</h2></div>
        <p class="dek" style="margin:0 0 14px;font-size:13.5px">Deletes <b>${esc(p.name)}</b>, its questions, every answer recorded against it and its action list. There is no undo, so export anything you need first.</p>
        <button class="ghost danger" id="s_delete">Delete ${esc(p.name)}</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>Questions</h2>
        <div class="spacer"></div>
        <div class="bulk">
          <button class="ghost" data-bulk-prompts="true" ${active === data.prompts.length ? 'disabled' : ''}>Resume all</button>
          <button class="ghost" data-bulk-prompts="false" ${active === 0 ? 'disabled' : ''}>Pause all</button>
        </div>
        <button class="ghost" id="q_generate">Suggest 10 more</button>
      </div>
      <p class="dek" style="margin:0 0 4px;font-size:13px">Write these the way a customer types them, never with the brand name in. Paused questions stay in the record but are not asked.</p>
      ${promptRows}
      <div class="inline-form">
        <input id="q_text" placeholder="Write it exactly as a customer would type it, without your brand name" />
        <button id="q_add">Add</button>
      </div>
      <p class="error" id="setupError" role="alert"></p>
    </div>
  </div>`;
}

/* ---------- setup handlers ---------- */

const setupErr = (msg) => { const el = $('setupError'); if (el) el.textContent = msg || ''; };

/**
 * Recalculate the estimate from whatever is currently ticked.
 * Priced per engine, because a SERP surface costs a fraction of an LLM call.
 */
function recalcEstimate() {
  const box = document.querySelector('[data-active-count]');
  if (!box) return;

  const questions = Number(box.dataset.activeCount);
  const runs = Number(box.dataset.runs);
  const chosen = [...document.querySelectorAll('input[data-engine]:checked')].map((b) => b.dataset.engine);

  const calls = questions * chosen.length * runs;
  const perCycle = chosen.reduce((sum, id) => sum + questions * runs * (state.costs?.[id] ?? 0.02), 0);

  box.querySelector('[data-n]').textContent = questions;
  box.querySelector('[data-surfaces-n]').textContent = chosen.length;
  box.querySelector('[data-surfaces-word]').textContent = chosen.length === 1 ? 'surface' : 'surfaces';
  box.querySelector('[data-runs-n]').textContent = runs;
  box.querySelector('[data-calls]').textContent = calls;
  box.querySelector('[data-cycle-cost]').textContent = `$${perCycle.toFixed(2)}`;
  box.querySelector('[data-month-cost]').textContent =
    perCycle > 0 ? `about $${(perCycle * 4.33).toFixed(0)} a month at weekly cadence` : '';

  const priced = chosen.filter((id) => state.measured?.includes(id));
  const note = box.querySelector('[data-cost-source]');
  const label = box.querySelector('[data-cost-label]');

  if (!chosen.length) {
    note.textContent = 'Pick at least one surface.';
    if (label) label.textContent = 'per cycle';
  } else if (priced.length === chosen.length) {
    note.textContent = 'Your own measured cost for these surfaces, averaged over previous runs.';
    if (label) label.textContent = 'per cycle';
  } else if (priced.length) {
    note.textContent = `Measured for ${priced.length} of ${chosen.length} surfaces. The rest use a deliberate over-estimate until they have run a few times, so the real figure is usually lower.`;
    if (label) label.textContent = 'per cycle, at most';
  } else {
    note.textContent = 'A ceiling, not a guess. Engines refund the unused part of each call, so your first few cycles usually come in well under this. It converges on your real cost after that.';
    if (label) label.textContent = 'per cycle, at most';
  }
}

/** Keep the "x active questions = y checks per cycle" line honest without a reload. */
function bumpActiveCount(delta) {
  const el = document.querySelector('[data-active-count]');
  if (!el) return;
  el.dataset.activeCount = String(Math.max(0, Number(el.dataset.activeCount) + delta));
  recalcEstimate();
}

/**
 * Redraw only the parts that depend on the engine selection: the allowance
 * counter, the cost line, and which unchecked boxes are still reachable.
 * Re-rendering the whole tab for a checkbox threw away scroll position and
 * felt like a page load.
 */
function syncEngineUi() {
  const boxes = [...document.querySelectorAll('input[data-engine]')];
  const chosen = boxes.filter((b) => b.checked);
  const allowed = Number(document.querySelector('[data-engine-allowance]')?.dataset.engineAllowance || 1);
  const atLimit = chosen.length >= allowed;

  for (const b of boxes) {
    const blocked = !b.checked && atLimit;
    b.disabled = blocked;
    b.closest('.row')?.classList.toggle('off', blocked);
  }

  const counter = document.querySelector('[data-engine-allowance]');
  if (counter) counter.textContent = `${chosen.length} of ${allowed} allowed`;

  recalcEstimate();
}

document.addEventListener('input', (e) => {
  if (e.target.id !== 's_runs') return;
  const box = document.querySelector('[data-active-count]');
  if (!box) return;
  box.dataset.runs = String(Math.min(10, Math.max(1, Number(e.target.value) || 1)));
  recalcEstimate();
});

document.addEventListener('change', async (e) => {
  const box = e.target.closest('input[data-engine]');
  if (!box) return;

  const chosen = [...document.querySelectorAll('input[data-engine]:checked')].map((b) => b.dataset.engine);
  if (!chosen.length) {
    box.checked = true;
    setupErr('Keep at least one surface switched on.');
    return;
  }

  setupErr('');
  syncEngineUi();

  try {
    const res = await fetch(`/api/projects/${state.projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engines: chosen })
    });
    if (!res.ok) throw new Error('save failed');
    const note = $('e_saved');
    if (note) { note.textContent = 'Saved'; setTimeout(() => { note.textContent = ''; }, 1800); }
  } catch {
    box.checked = !box.checked;
    syncEngineUi();
    setupErr('Could not save that. Check your connection and try again.');
  }
});

/** Repaint every question row from the server's answer, without a re-render. */
function applyBulkPrompts(activeIds) {
  const set = new Set(activeIds.map(String));
  for (const btn of document.querySelectorAll('button[data-toggle-prompt]')) {
    const on = set.has(String(btn.dataset.togglePrompt));
    btn.dataset.active = String(on);
    btn.textContent = on ? 'Pause' : 'Resume';
    btn.closest('.row')?.classList.toggle('off', !on);
  }
  const cost = document.querySelector('[data-active-count]');
  if (cost) {
    cost.dataset.activeCount = String(set.size);
    recalcEstimate();
  }
  const resumeBtn = document.querySelector('[data-bulk-prompts="true"]');
  const pauseBtn = document.querySelector('[data-bulk-prompts="false"]');
  const total = document.querySelectorAll('button[data-toggle-prompt]').length;
  if (resumeBtn) resumeBtn.disabled = set.size === total;
  if (pauseBtn) pauseBtn.disabled = set.size === 0;
}

document.addEventListener('click', async (e) => {
  const t = e.target;

  const bulkP = t.closest('button[data-bulk-prompts]');
  if (bulkP) {
    const wantActive = bulkP.dataset.bulkPrompts === 'true';
    bulkP.disabled = true;
    setupErr('');
    try {
      const res = await fetch(`/api/projects/${state.projectId}/prompts/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: wantActive })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not update');

      const fresh = await api(`/api/projects/${state.projectId}/setup`);
      applyBulkPrompts(fresh.prompts.filter((q) => q.active).map((q) => q.id));
      if (json.capped > 0) {
        setupErr(`Resumed ${json.activeNow}, the most searched ones. The ${json.planName} plan allows ${json.limit} active questions, so ${json.capped} stayed paused.`);
      }
    } catch (err) {
      setupErr(err.message);
      bulkP.disabled = false;
    }
    return;
  }

  const bulkE = t.closest('button[data-bulk-engines]');
  if (bulkE) {
    const boxes = [...document.querySelectorAll('input[data-engine]')];
    const allowed = Number(document.querySelector('[data-engine-allowance]')?.dataset.engineAllowance || 1);
    const wanted = bulkE.dataset.bulkEngines === 'all'
      ? boxes.slice(0, allowed).map((b) => b.dataset.engine)
      : ['chatgpt'];

    for (const b of boxes) b.checked = wanted.includes(b.dataset.engine);
    syncEngineUi();
    setupErr('');

    const res = await fetch(`/api/projects/${state.projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engines: wanted })
    });
    const note = $('e_saved');
    if (res.ok && note) { note.textContent = 'Saved'; setTimeout(() => { note.textContent = ''; }, 1800); }
    if (!res.ok) setupErr('Could not save that. Try again.');
    return;
  }

  if (t.id === 's_save') {
    t.disabled = true;
    await fetch(`/api/projects/${state.projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('s_name').value,
        brandName: $('s_brand').value,
        aliases: $('s_aliases').value.split(',').map((x) => x.trim()).filter(Boolean),
        category: $('s_category').value,
        qualifier: $('s_qualifier').value,
        market: $('s_market').value,
        runsPerCycle: Number($('s_runs').value),
        autoCycle: $('s_auto').checked
      })
    });
    $('s_saved').textContent = 'Saved';
    t.disabled = false;
    await loadProjectList();
    setTimeout(() => { const el = $('s_saved'); if (el) el.textContent = ''; }, 2500);
  }

  if (t.id === 'r_add') {
    const res = await fetch(`/api/projects/${state.projectId}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('r_name').value, domain: $('r_domain').value })
    });
    const json = await res.json();
    if (!res.ok) return setupErr(json.error);
    await render();
  }

  if (t.dataset.delEntity) {
    await fetch(`/api/entities/${t.dataset.delEntity}`, { method: 'DELETE' });
    await render();
  }

  if (t.id === 'q_add') {
    const res = await fetch(`/api/projects/${state.projectId}/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: $('q_text').value })
    });
    const json = await res.json();
    if (!res.ok) return setupErr(json.error);
    await render();
  }

  if (t.dataset.delPrompt) {
    await fetch(`/api/prompts/${t.dataset.delPrompt}`, { method: 'DELETE' });
    await render();
  }

  if (t.dataset.togglePrompt) {
    // Update the row immediately and let the request settle behind it.
    // Re-rendering the whole tab for a one-field change felt broken.
    const wasActive = t.dataset.active === 'true';
    const next = !wasActive;
    const row = t.closest('.row');

    t.disabled = true;
    row.classList.toggle('off', !next);
    t.textContent = next ? 'Pause' : 'Resume';
    t.dataset.active = String(next);

    try {
      const res = await fetch(`/api/prompts/${t.dataset.togglePrompt}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: next })
      });
      if (!res.ok) throw new Error('save failed');
      bumpActiveCount(next ? 1 : -1);
    } catch {
      // Put it back the way it was rather than leaving a lie on screen.
      row.classList.toggle('off', !wasActive);
      t.textContent = wasActive ? 'Pause' : 'Resume';
      t.dataset.active = String(wasActive);
      setupErr('Could not save that. Check your connection and try again.');
    } finally {
      t.disabled = false;
    }
  }

  if (t.id === 'q_generate') {
    t.disabled = true;
    t.textContent = 'Writing';
    const res = await fetch(`/api/projects/${state.projectId}/generate-prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 10 })
    });
    const json = await res.json();
    await render();
    if (json.added === 0) setupErr('Nothing new to add. Every suggestion was already on the list.');
  }

  if (t.id === 's_delete') {
    if (!confirm('Delete this site and everything measured against it?')) return;
    await fetch(`/api/projects/${state.projectId}`, { method: 'DELETE' });
    window.location.reload();
  }
});

/* ---------- add site ---------- */

function parseRivals(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, domain] = line.split(',').map((x) => (x || '').trim());
      return { name, domain };
    })
    .filter((r) => r.name);
}

$('addSiteBtn').addEventListener('click', () => {
  $('f_market').innerHTML = window.countryOptions(window.DEFAULT_COUNTRY);
  $('siteDialog').showModal();
  $('f_domain').focus();
});

$('f_scan').addEventListener('click', async () => {
  const btn = $('f_scan');
  const note = $('f_scanned');
  const domain = $('f_domain').value.trim();
  if (!domain) { note.className = 'hint warn'; note.textContent = 'Enter a domain first.'; return; }

  btn.disabled = true;
  btn.textContent = 'Reading';
  note.className = 'hint';
  note.textContent = 'Reading the homepage';
  $('siteError').textContent = '';

  try {
    const res = await fetch('/api/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Could not read that site');

    $('f_domain').value = d.domain;
    $('f_brand').value = d.brandName || '';
    $('f_aliases').value = (d.aliases || []).join(', ');
    $('f_category').value = d.category || '';
    $('f_qualifier').value = d.qualifier || '';
    $('f_market').innerHTML = window.countryOptions(d.market || window.DEFAULT_COUNTRY);
    if (d.competitors?.length) {
      $('f_rivals').value = d.competitors.map((c) => `${c.name}${c.domain ? ', ' + c.domain : ''}`).join('\n');
    }

    const how = { dataforseo: ' Read through our renderer, since the site blocks direct requests.',
                  browserless: ' Read with a headless browser.' }[d.via] || '';
    note.className = d.confident ? 'hint good' : 'hint warn';
    note.textContent = (d.confident
      ? 'Filled in from the homepage. Check every field, especially who the customer is.'
      : 'Read the page but could not infer much. Fill the fields in yourself.') + how;
  } catch (err) {
    // A failed scan must not be a dead end. Every field can be typed.
    note.className = 'hint warn';
    note.textContent = `${err.message} Fill the fields in below and carry on.`;
    $('f_brand').focus();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan site';
  }
});
$('siteCancel').addEventListener('click', () => $('siteDialog').close());

$('siteSave').addEventListener('click', async () => {
  const btn = $('siteSave');
  $('siteError').textContent = '';
  btn.disabled = true;
  btn.textContent = 'Writing questions';
  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandName: $('f_brand').value,
        aliases: $('f_aliases').value.split(',').map((x) => x.trim()).filter(Boolean),
        domain: $('f_domain').value,
        category: $('f_category').value,
        qualifier: $('f_qualifier').value,
        market: $('f_market').value,
        competitors: parseRivals($('f_rivals').value)
      })
    });
    const json = await res.json();
    if (res.status === 402) {
      $('siteError').innerHTML =
        `<span class="limit-msg">${esc(json.error)}</span>` +
        `<button type="button" class="ghost" data-goto-billing="1">See plans</button>`;
      return;
    }
    if (!res.ok) throw new Error(json.error || 'Could not create the site');
    $('siteDialog').close();
    await loadProjectList(json.project.id);
    document.querySelector('.tab[data-view="setup"]').click();
  } catch (err) {
    $('siteError').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create and write questions';
  }
});

/* ---------- plan and usage ---------- */

function renewLine(b) {
  if (b.plan.id === 'free' || !b.currentPeriodEnd) return '';
  const d = new Date(b.currentPeriodEnd);
  if (Number.isNaN(d.getTime())) return '';
  const when = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return ` &middot; ${b.cancelAtPeriodEnd ? 'access until' : 'renews'} ${when}`;
}

async function viewBilling() {
  const [b, meta] = await Promise.all([api('/api/billing'), api('/api/plans')]);
  if (!b) return '';
  state.billing = b;

  const u = b.usage;
  const barClass = u.percent >= 90 ? 'over' : u.percent >= 70 ? 'warn' : '';
  const spent = u.spend ? `$${Number(u.spend).toFixed(2)} of engine cost` : 'no spend recorded yet';

  // Open on the interval the customer is actually paying for, not always monthly.
  if (state.interval === null) state.interval = b.plan.id === 'free' ? 'month' : b.interval || 'month';
  const yearly = state.interval === 'year';

  const cards = meta.plans
    .map((p) => {
      const samePlan = p.id === b.plan.id;
      const sameInterval = p.id === 'free' || b.interval === state.interval;
      const monthlyEquivalent = yearly && p.priceAnnual ? Math.round(p.priceAnnual / 12) : p.price;

      let cta;
      if (samePlan && sameInterval) {
        cta = `<button class="ghost" disabled>Your plan</button>`;
      } else if (samePlan) {
        // Same plan, other billing period. Stripe's portal handles the swap.
        cta = `<button class="ghost" data-portal="1">Switch to ${yearly ? 'yearly' : 'monthly'}</button>`;
      } else if (p.id === 'free') {
        cta = `<button class="ghost" data-portal="1">Downgrade</button>`;
      } else {
        cta = `<button data-buy="${p.id}">Choose ${esc(p.name)}</button>`;
      }

      return `
      <div class="plan ${samePlan ? 'is-current' : ''} ${p.popular && !samePlan ? 'is-popular' : ''}">
        ${samePlan ? '<div class="plan-flag">Current</div>' : ''}
        <div class="plan-name">${esc(p.name)}</div>
        <div class="plan-price">${p.price ? '$' + monthlyEquivalent : 'Free'}<span>${p.price ? '/mo' : ''}</span></div>
        ${p.price && yearly ? `<div class="plan-annual">$${p.priceAnnual} billed yearly</div>` : ''}
        <p class="plan-blurb">${esc(p.blurb)}</p>
        <div class="plan-limits">
          <span>${p.sites} site${p.sites > 1 ? 's' : ''}</span>
          <span>${p.questions} questions</span>
          <span>${p.engines} engine${p.engines > 1 ? 's' : ''}</span>
          <span>${p.runs} run${p.runs > 1 ? 's' : ''}</span>
          <span>${p.monthlyCalls.toLocaleString()} checks</span>
        </div>
        ${cta}
      </div>`;
    })
    .join('');

  return `
  <div class="panel">
    <div class="panel-head">
      <h2>Your plan</h2>
      <div class="spacer"></div>
      ${b.hasStripeCustomer ? '<button class="ghost" data-portal="1">Manage billing</button>' : ''}
    </div>

    <div class="current-plan">
      <div>
        <div class="current-name">${esc(b.plan.name)}</div>
        <div class="current-meta">
          ${b.plan.id === 'free'
            ? 'No card on file'
            : `$${b.interval === 'year' ? b.plan.priceAnnual : b.plan.price} billed ${b.interval === 'year' ? 'yearly' : 'monthly'}`}
          ${renewLine(b)}
        </div>
      </div>
      ${b.cancelAtPeriodEnd ? '<div class="tag" style="background:#fbe9e7;color:var(--alert)">Cancels at period end</div>' : ''}
    </div>

    <div class="usage-top">
      <div>
        <div class="usage-big">${u.calls.toLocaleString()} <span>of ${u.limit.toLocaleString()}</span></div>
        <div class="sub" style="font-family:var(--mono);font-size:11px;color:var(--ink-3)">answer checks used this month &middot; ${spent}</div>
      </div>
    </div>

    <div class="usage-track"><div class="usage-fill ${barClass}" style="width:${Math.max(u.percent, u.budgetPercent || 0)}%"></div></div>
    <p class="hint" style="margin-top:10px">
      ${(u.budgetPercent || 0) > u.percent
        ? `Heavier surfaces such as ChatGPT use more of the allowance than Google's AI Overview does, so you are ${u.budgetPercent}% through this month's usage on ${u.percent}% of your checks. Switching a site to lighter surfaces makes the allowance go further.<br />`
        : ''}
      ${u.remaining > 0
        ? `${u.remaining.toLocaleString()} left, resetting on the 1st. A cycle trims itself to fit rather than running you over.`
        : 'Allowance used for this month. Cycles are paused until the 1st, or upgrade to carry on now.'}
    </p>

    <div class="usage-counts">
      <span><b>${b.counts.sites}</b> of ${b.plan.sites} sites</span>
      <span><b>${b.counts.questions}</b> active questions</span>
      <span>${b.plan.engines} engine${b.plan.engines > 1 ? 's' : ''} allowed</span>
      <span>${b.plan.runs} run${b.plan.runs > 1 ? 's' : ''} per question</span>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <h2>Plans</h2>
      <div class="spacer"></div>
      <div class="switch-int" role="group" aria-label="Billing period">
        <button class="int-b ${yearly ? '' : 'is-on'}" data-interval="month">Monthly</button>
        <button class="int-b ${yearly ? 'is-on' : ''}" data-interval="year">Yearly &middot; 2 months free</button>
      </div>
    </div>
    ${b.stripeEnabled ? '' : '<p class="notice" style="margin-bottom:16px">Billing is not configured on this deployment, so everything runs on the Free plan. Add your Stripe keys to enable upgrades.</p>'}
    <div class="plans">${cards}</div>
    <p class="hint" style="margin-top:16px">
      One answer check is one question put to one engine, once. Questions multiply by engines and by runs, which is why the
      allowance is the number worth watching.
    </p>
    <p class="error" id="billingError" role="alert"></p>
  </div>`;
}

async function goToStripe(path, body) {
  const err = $('billingError');
  if (err) err.textContent = '';
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const json = await res.json();
  if (!res.ok) { if (err) err.textContent = json.error; return; }
  window.location.href = json.url;
}

document.addEventListener('click', async (e) => {
  const buy = e.target.closest('button[data-buy]');
  if (buy) {
    buy.disabled = true;
    await goToStripe('/api/billing/checkout', { plan: buy.dataset.buy, interval: state.interval });
    buy.disabled = false;
  }
  if (e.target.closest('button[data-portal]')) {
    await goToStripe('/api/billing/portal');
  }
  const int = e.target.closest('button[data-interval]');
  if (int && int.classList.contains('int-b')) {
    state.interval = int.dataset.interval;
    await render();
  }
  const goBilling = e.target.closest('[data-goto-billing]');
  if (goBilling) {
    e.preventDefault();
    // Close the Add site sheet first, otherwise the Plan tab loads behind it
    // and the person has to work out that they need to cancel.
    const sheet = $('siteDialog');
    if (sheet?.open) sheet.close();
    document.querySelector('.tab[data-view="billing"]').click();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

async function refreshUsagePill() {
  const b = await api('/api/billing');
  if (!b) return;
  state.billing = b;
  const pill = $('usagePill');
  pill.hidden = false;
  pill.textContent = `${b.plan.name} \u00b7 ${b.usage.calls}/${b.usage.limit}`;
  pill.className = 'pill' + (b.usage.percent >= 90 ? ' over' : b.usage.percent >= 70 ? ' warn' : '');
}

/* ---------- trend ---------- */

const DATE_FMT = { day: 'numeric', month: 'short' };
const shortDate = (d) => new Date(d).toLocaleDateString(undefined, DATE_FMT);

/**
 * Hand-rolled SVG rather than a charting library. The data is a handful of
 * points on a shared date axis, and a dependency would cost more than it
 * saves while fighting the design tokens.
 */
function lineChart(series, { height = 220, showAxis = true } = {}) {
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  if (dates.length < 2) return null;

  const W = 760;
  const H = height;
  const pad = { l: 38, r: 12, t: 14, b: 26 };
  const x = (d) => pad.l + (dates.indexOf(d) / (dates.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v) * (H - pad.t - pad.b);

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (v) => `<line x1="${pad.l}" y1="${y(v)}" x2="${W - pad.r}" y2="${y(v)}" class="gridline" />
              ${showAxis ? `<text x="${pad.l - 8}" y="${y(v) + 4}" class="axis" text-anchor="end">${Math.round(v * 100)}%</text>` : ''}`
    )
    .join('');

  const xLabels = dates
    .filter((_, i) => dates.length <= 6 || i % Math.ceil(dates.length / 6) === 0 || i === dates.length - 1)
    .map((d) => `<text x="${x(d)}" y="${H - 6}" class="axis" text-anchor="middle">${shortDate(d)}</text>`)
    .join('');

  const lines = series
    .map((s) => {
      const pts = s.points.filter((p) => p.value !== null && p.value !== undefined).sort((a, b) => (a.date < b.date ? -1 : 1));
      if (!pts.length) return '';
      const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
      const dots = pts
        .map(
          (p) => `<circle cx="${x(p.date).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${s.own ? 4 : 3}" class="dot" style="fill:${s.colour}">
                    <title>${esc(s.label)} &middot; ${shortDate(p.date)} &middot; ${Math.round(p.value * 100)}%</title>
                  </circle>`
        )
        .join('');
      return `<path d="${path}" class="line ${s.own ? 'own' : ''}" style="stroke:${s.colour}" />${dots}`;
    })
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Visibility over time">
    ${grid}${xLabels}${lines}
  </svg>`;
}

function legend(series) {
  return `<div class="legend">${series
    .map((s) => `<span class="legend-item"><i style="background:${s.colour}"></i>${esc(s.label)}</span>`)
    .join('')}</div>`;
}

const RIVAL_COLOURS = ['#a8601b', '#7b5ea8', '#1f7a8c', '#8a6d3b', '#6b7280'];

async function viewTrends() {
  const h = await api(`/api/projects/${state.projectId}/history`);
  if (!h) return '';

  if (h.cycles.length === 0) {
    return `<div class="empty"><h2>Nothing measured yet</h2><p>Run a cycle and the trend starts here.</p></div>`;
  }
  if (h.cycles.length === 1) {
    const c = h.cycles[0];
    return `<div class="empty">
      <h2>One cycle so far</h2>
      <p>You were named in <b>${Math.round(c.rate * 100)}%</b> of ${c.runs} answers on ${esc(shortDate(c.date))}.
      Movement needs a second cycle to compare against, so this page fills in from the next run.</p>
    </div>`;
  }

  const first = h.cycles[0];
  const last = h.cycles[h.cycles.length - 1];
  const change = last.rate - first.rate;
  const best = h.cycles.reduce((a, b) => (b.rate > a.rate ? b : a));

  /* headline: you against your competitors */
  const byName = new Map();
  for (const row of h.byEntity) {
    if (!byName.has(row.name)) byName.set(row.name, { label: row.name, kind: row.kind, points: [] });
    byName.get(row.name).points.push({ date: row.date, value: row.rate });
  }
  const own = [...byName.values()].find((s) => s.kind === 'owned');
  const rivals = [...byName.values()]
    .filter((s) => s.kind !== 'owned')
    .sort((a, b) => b.points[b.points.length - 1].value - a.points[a.points.length - 1].value)
    .slice(0, 5);

  const series = [
    { ...own, colour: 'var(--you)', own: true },
    ...rivals.map((r, i) => ({ ...r, colour: RIVAL_COLOURS[i % RIVAL_COLOURS.length] }))
  ].filter(Boolean);

  /* per engine */
  const engineMap = new Map();
  for (const row of h.byEngine) {
    if (!engineMap.has(row.engine)) engineMap.set(row.engine, { label: row.engine, points: [] });
    engineMap.get(row.engine).points.push({ date: row.date, value: row.rate });
  }
  const engineSeries = [...engineMap.values()].map((s, i) => ({ ...s, colour: RIVAL_COLOURS[i % RIVAL_COLOURS.length] }));

  const moversRows = h.movers.length
    ? h.movers
        .map((m) => {
          const pts = Math.round(m.delta * 100);
          return `<div class="mover">
            <div class="mover-q">${esc(m.text)}</div>
            <div class="mover-delta ${pts > 0 ? 'up' : 'down'}">${pts > 0 ? '+' : ''}${pts} pts</div>
            <div class="mover-nums">${Math.round(m.before * 100)}% &rarr; ${Math.round(m.after * 100)}%</div>
          </div>`;
        })
        .join('')
    : `<p class="hint">No question changed between the last two cycles.</p>`;

  const totalSpend = h.spend.reduce((n, s) => n + Number(s.cost), 0);

  return `
  <div class="figures">
    <div class="figure">
      <div class="label">Since ${esc(shortDate(first.date))}</div>
      <div class="value ${change > 0 ? 'up' : change < 0 ? 'down' : 'dim'}">${change > 0 ? '+' : ''}${Math.round(change * 100)}<span style="font-size:16px"> pts</span></div>
      <div class="sub">was ${Math.round(first.rate * 100)}%</div>
    </div>
    <div class="figure">
      <div class="label">Best cycle</div>
      <div class="value">${Math.round(best.rate * 100)}%</div>
      <div class="sub">${esc(shortDate(best.date))}</div>
    </div>
    <div class="figure">
      <div class="label">Position in answer</div>
      <div class="value">${last.avg_ordinal ? Number(last.avg_ordinal).toFixed(1) : '-'}</div>
      <div class="sub">${first.avg_ordinal ? `was ${Number(first.avg_ordinal).toFixed(1)}` : 'no earlier reading'}</div>
    </div>
    <div class="figure">
      <div class="label">Cycles run</div>
      <div class="value">${h.cycles.length}</div>
      <div class="sub">$${totalSpend.toFixed(2)} all in</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h2>You against the field</h2></div>
    ${lineChart(series) || '<p class="hint">Not enough cycles yet.</p>'}
    ${legend(series)}
    <p class="hint" style="margin-top:12px">Share of answers each brand was named in, cycle by cycle. Hover a point for the exact figure.</p>
  </div>

  <div class="setup-grid">
    <div class="panel">
      <div class="panel-head"><h2>By surface</h2></div>
      ${lineChart(engineSeries, { height: 190 }) || '<p class="hint">Not enough cycles yet.</p>'}
      ${legend(engineSeries)}
      <p class="hint" style="margin-top:12px">A surface that moves alone usually points at a crawler or freshness problem rather than your content.</p>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>What moved</h2></div>
      ${moversRows}
      <p class="hint" style="margin-top:12px">Biggest changes between the last two cycles, per question.</p>
    </div>
  </div>`;
}

boot();
