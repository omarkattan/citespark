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
      if (ev.queries) bits.push(...ev.queries.slice(0, 3).map((q) => `<span class="tag">${esc(q)}</span>`));
      return `
      <article class="rec" data-type="${esc(r.type)}">
        <div class="rec-top">
          <div class="rec-title">${esc(r.title)}</div>
          <div class="rec-pri">priority ${Number(r.priority).toFixed(1)} &middot; effort ${Number(r.effort)}/5</div>
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
  const fn = { actions: viewActions, questions: viewQuestions, rivals: viewRivals, sources: viewSources, traffic: viewTraffic, setup: viewSetup, billing: viewBilling }[view];
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

async function boot() {
  const me = await api('/api/me');
  if (!me?.signedIn) { window.location.href = '/login'; return; }
  if (me.mock) $('mockNotice').hidden = false;
  await loadProjectList();
  await refreshUsagePill();
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
  const btn = $('runBtn');
  btn.disabled = true;
  btn.textContent = 'Starting';

  const res = await fetch(`/api/projects/${state.projectId}/run`, { method: 'POST' });
  const json = await res.json();

  if (res.status === 402) {
    btn.disabled = false;
    btn.textContent = 'Run cycle';
    alert(`${json.error}`);
    document.querySelector('.tab[data-view="billing"]').click();
    return;
  }

  btn.textContent = json.trimmed ? `Running ${json.calls} (trimmed)` : `Running ${json.calls}`;
  setTimeout(async () => {
    await loadProject(state.projectId);
    await refreshUsagePill();
    btn.disabled = false;
    btn.textContent = 'Run cycle';
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

/* ---------- setup ---------- */

async function viewSetup() {
  const data = await api(`/api/projects/${state.projectId}/setup`);
  if (!data) return '';
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

  const cost = active * 3 * (p.runs_per_cycle || 3);

  return `
  <div class="setup-grid">
    <div>
      <div class="panel">
        <div class="panel-head"><h2>This site</h2></div>
        <div class="field"><label for="s_name">Project name</label><input id="s_name" value="${esc(p.name)}" /></div>
        <div class="field"><label for="s_brand">Brand name</label><input id="s_brand" value="${esc(p.brand_name)}" /></div>
        <div class="field"><label for="s_aliases">Also known as, comma separated</label><input id="s_aliases" value="${esc((p.aliases || []).join(', '))}" placeholder="Sandstorm, Sandstorm Digital Ltd" /></div>
        <div class="field"><label for="s_category">What the business does</label><input id="s_category" value="${esc(p.category || '')}" /></div>
        <div class="field"><label for="s_qualifier">Who the customer is</label><input id="s_qualifier" value="${esc(p.qualifier || '')}" /></div>
        <div class="field"><label for="s_market">Market</label><select id="s_market">${window.countryOptions(p.market)}</select></div>
        <div class="field"><label for="s_runs">Runs per question, per engine</label><input id="s_runs" type="number" min="1" max="10" value="${p.runs_per_cycle}" /></div>
        <p class="sub" style="font-family:var(--mono);font-size:11px;color:var(--ink-3);margin:0 0 14px">
          ${active} active questions &times; 3 engines &times; ${p.runs_per_cycle} runs = ${cost} calls per cycle.
          More runs means a more trustworthy percentage. More questions means broader coverage. Runs usually win.
        </p>
        <button id="s_save">Save changes</button>
        <span id="s_saved" class="sub" style="font-family:var(--mono);font-size:11px;color:var(--good);margin-left:10px"></span>
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
        <button class="ghost" id="q_generate">Suggest 10 more</button>
      </div>
      <p class="dek" style="margin:0 0 4px;font-size:13px">Write these the way a customer types them, never with the brand name in. Paused questions stay in the record but are not asked.</p>
      ${promptRows}
      <div class="inline-form">
        <input id="q_text" placeholder="Which SEO agency is best for a UK ecommerce brand?" />
        <button id="q_add">Add</button>
      </div>
      <p class="error" id="setupError" role="alert"></p>
    </div>
  </div>`;
}

/* ---------- setup handlers ---------- */

const setupErr = (msg) => { const el = $('setupError'); if (el) el.textContent = msg || ''; };

document.addEventListener('click', async (e) => {
  const t = e.target;

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
        runsPerCycle: Number($('s_runs').value)
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
    await fetch(`/api/prompts/${t.dataset.togglePrompt}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: t.dataset.active !== 'true' })
    });
    await render();
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
  $('f_market').innerHTML = window.countryOptions('GB');
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
    $('f_market').innerHTML = window.countryOptions(d.market || 'GB');
    if (d.competitors?.length) {
      $('f_rivals').value = d.competitors.map((c) => `${c.name}${c.domain ? ', ' + c.domain : ''}`).join('\n');
    }

    note.className = d.confident ? 'hint good' : 'hint warn';
    note.textContent = d.confident
      ? 'Filled in from the homepage. Check every field, especially who the customer is.'
      : 'Read the page but could not infer much. Fill the fields in yourself.';
  } catch (err) {
    note.className = 'hint warn';
    note.textContent = err.message;
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
      $('siteError').innerHTML = `${esc(json.error)} <a href="#" data-goto-billing="1">See plans</a>`;
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

async function viewBilling() {
  const [b, meta] = await Promise.all([api('/api/billing'), api('/api/plans')]);
  if (!b) return '';
  state.billing = b;

  const u = b.usage;
  const barClass = u.percent >= 90 ? 'over' : u.percent >= 70 ? 'warn' : '';
  const spent = u.spend ? `$${Number(u.spend).toFixed(2)} of engine cost` : 'no spend recorded yet';

  const cards = meta.plans
    .map((p) => {
      const current = p.id === b.plan.id;
      const cta = current
        ? `<button class="ghost" disabled>Current plan</button>`
        : p.id === 'free'
          ? `<button class="ghost" data-portal="1">Downgrade</button>`
          : `<button data-buy="${p.id}">Choose ${esc(p.name)}</button>`;
      return `
      <div class="plan ${current ? 'is-current' : ''} ${p.popular ? 'is-popular' : ''}">
        <div class="plan-name">${esc(p.name)}</div>
        <div class="plan-price">${p.price ? '$' + p.price : 'Free'}<span>${p.price ? '/mo' : ''}</span></div>
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
      <h2>This month</h2>
      <div class="spacer"></div>
      ${b.hasStripeCustomer ? '<button class="ghost" data-portal="1">Manage billing</button>' : ''}
    </div>

    <div class="usage-top">
      <div>
        <div class="usage-big">${u.calls.toLocaleString()} <span>of ${u.limit.toLocaleString()}</span></div>
        <div class="sub" style="font-family:var(--mono);font-size:11px;color:var(--ink-3)">answer checks used &middot; ${spent}</div>
      </div>
      <div class="usage-plan">
        <div class="tag">${esc(b.plan.name)} plan</div>
        ${b.cancelAtPeriodEnd ? '<div class="tag" style="background:#fbe9e7;color:#9e2b25">Cancels at period end</div>' : ''}
      </div>
    </div>

    <div class="usage-track"><div class="usage-fill ${barClass}" style="width:${u.percent}%"></div></div>
    <p class="hint" style="margin-top:10px">
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
    <div class="panel-head"><h2>Plans</h2></div>
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
    await goToStripe('/api/billing/checkout', { plan: buy.dataset.buy, interval: 'month' });
    buy.disabled = false;
  }
  if (e.target.closest('button[data-portal]')) {
    await goToStripe('/api/billing/portal');
  }
  if (e.target.closest('[data-goto-billing]')) {
    document.querySelector('.tab[data-view="billing"]').click();
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

boot();
