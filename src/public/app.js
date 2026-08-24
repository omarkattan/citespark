const $ = (id) => document.getElementById(id);
const state = { projectId: null, view: 'actions', overview: null, interval: null };

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const pct = (n) => `${Math.round((n || 0) * 100)}%`;

/**
 * Every call goes through here.
 *
 * A plain object passed as `body` serialises to "[object Object]" and the
 * server sees an empty request, which fails silently rather than loudly.
 * Accepting an object and encoding it here removes the trap.
 */
async function api(path, options = {}) {
  const opts = { ...options };
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  }
  const res = await fetch(path, opts);
  if (res.status === 401) { window.location.href = '/login'; return null; }

  return res.json();
}

/**
 * Catch a refusal wherever it happens.
 *
 * Thirty-three calls in this file use fetch directly rather than the helper
 * above, so handling this in the helper would have covered some paths and
 * missed others silently. Wrapping fetch itself means a limit hit from
 * anywhere, including code written later, shows a way forward.
 */
const rawFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await rawFetch(...args);

  if (res.status === 402) {
    // The body is read from a clone so the caller still gets an unread one.
    res
      .clone()
      .json()
      .then((body) => {
        if (body?.upgrade) showUpgrade(body.error);
      })
      .catch(() => {});
  }

  return res;
};

/** What is available above where they are, and what it would unlock. */
async function showUpgrade(reason) {
  const existing = document.getElementById('upgradeSheet');
  if (existing) existing.remove();

  // Two calls: what exists, and where they are now. Only what sits above
  // them is worth showing.
  const [plans, billing] = await Promise.all([
    fetch('/api/plans').then((r) => r.json()).catch(() => null),
    fetch('/api/billing').then((r) => r.json()).catch(() => null)
  ]);

  const order = (plans?.plans || []).map((p) => p.id);
  const current = billing?.plan?.id || 'free';
  const above = (plans?.plans || []).filter((p) => order.indexOf(p.id) > order.indexOf(current));
  const canPay = plans?.stripeEnabled !== false;

  const sheet = document.createElement('div');
  sheet.id = 'upgradeSheet';
  sheet.className = 'upsell';
  sheet.innerHTML = `
    <div class="upsell-box" role="dialog" aria-modal="true" aria-label="Upgrade">
      <button class="upsell-close" data-upsell-close aria-label="Close">&times;</button>
      <p class="upsell-reason">${esc(reason || 'That is beyond what this plan allows.')}</p>
      ${
        above.length
          ? `<div class="upsell-plans">
              ${above
                .slice(0, 2)
                .map(
                  (p) => `<div class="upsell-plan">
                    <div class="upsell-name">${esc(p.name)}</div>
                    <div class="upsell-price">$${p.price}<span>/month</span></div>
                    <ul>
                      <li>${p.sites} ${p.sites === 1 ? 'site' : 'sites'}</li>
                      <li>${p.questions} questions each</li>
                      <li>${p.engines} engines</li>
                      <li>${p.monthlyCalls.toLocaleString()} answer checks a month</li>
                    </ul>
                    ${
                      canPay
                        ? `<button class="btn" data-upgrade-to="${esc(p.id)}">Choose ${esc(p.name)}</button>`
                        : '<span class="hint">Contact us to switch plan</span>'
                    }
                  </div>`
                )
                .join('')}
            </div>`
          : '<p class="hint">You are already on the largest plan. Email omar@sandstormdigital.com and we will sort something out.</p>'
      }
      <button class="ghost" data-upsell-close>Not now</button>
    </div>`;
  document.body.appendChild(sheet);
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-upsell-close]')) {
    document.getElementById('upgradeSheet')?.remove();
    return;
  }

  const pick = e.target.closest('[data-upgrade-to]');
  if (pick) {
    pick.disabled = true;
    pick.textContent = 'Opening checkout';
    const d = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: pick.dataset.upgradeTo, interval: 'month' })
    }).then((r) => r.json());

    if (d?.url) window.location.href = d.url;
    else {
      pick.disabled = false;
      pick.textContent = 'Could not open checkout';
    }
  }
});

/* ---------- signature element ---------- */

/**
 * A tick means named. A ring means linked as a source but not named.
 *
 * These were collapsed into one mark, so being cited first in an AI Overview
 * without being named in the sentence showed as nothing at all. The link is
 * usually the more valuable outcome of the two.
 */
function runStrip(runs) {
  const byEngine = new Map();
  for (const r of runs) {
    if (!byEngine.has(r.engine)) byEngine.set(r.engine, []);
    byEngine.get(r.engine).push(r);
  }
  const groups = [...byEngine.entries()]
    .map(([engine, list]) => {
      const ticks = list
        .map((r) => {
          // Three states, not two: named, linked but not named, neither.
          const state = r.mentioned ? 'hit' : r.cited ? 'cited' : 'miss';
          const label = r.mentioned
            ? `named at position ${r.ordinal}`
            : r.cited
              ? 'linked as a source, but not named in the answer'
              : 'neither named nor linked';
          return `<span class="tick ${state}" title="${label}"></span>`;
        })
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

  /**
   * The report is the deliverable, so it should look like one.
   *
   * A ghost link at the end of a right-aligned row reads as a minor control,
   * and it sat below an early return, so filtering to an empty view removed
   * it altogether.
   */
  const reportBar = `<div class="reportbar">
    <div class="reportbar-text">
      <b>Client report</b>
      <span>Open it to read or print to PDF. Download the data for every citation, page and finding.</span>
    </div>
    <a class="btn" href="/api/projects/${state.projectId}/report" target="_blank" rel="noopener">Open the report</a>
    <a class="ghost" href="/api/projects/${state.projectId}/report?download=1" download>Download report</a>
    <a class="ghost" href="/api/projects/${state.projectId}/report?format=csv" download>Download data</a>
  </div>`;

  const bar = `<div class="taskbar">
      ${tab('active', 'To do', c.open + c.doing)}
      ${tab('doing', 'In progress', c.doing)}
      ${tab('done', 'Done', c.done)}
      ${tab('dismissed', 'Dismissed', c.dismissed)}
      ${tab('all', 'Everything', c.total)}
      <span class="spacer"></span>
      ${c.overdue ? `<span class="tag overdue">${c.overdue} overdue</span>` : ''}
    </div>`;

  const suppressedPanel =
    filter === 'dismissed'
      ? `<div class="panel" id="suppressedPanel" style="margin-top:18px">
          <div class="panel-head"><h2>Deleted actions</h2><div class="spacer"></div>
            <button class="ghost" id="loadSuppressed">Show</button></div>
          <p class="hint" style="margin:0">Deleted actions are not regenerated by future cycles. Restoring one lets it come back.</p>
          <div id="suppressedList"></div>
        </div>`
      : '';

  // Before the early return: an empty filter must not hide the deliverable.
  if (!data.tasks.length) {
    // The report covers every cycle, so an empty filter is no reason to hide it.
    return reportBar + bar + `<div class="empty"><h2>${
      filter === 'done' ? 'Nothing finished yet' : filter === 'dismissed' ? 'Nothing dismissed' : 'Nothing to do here'
    }</h2><p>${
      filter === 'active'
        ? 'Run a cycle and the engine writes the task list from what it finds.'
        : 'Try another filter.'
    }</p></div>` + suppressedPanel;
  }

  return reportBar + bar + data.tasks.map(taskCard).join('') + suppressedPanel;
}

const STATUS_LABEL = { open: 'To do', doing: 'In progress', done: 'Done', dismissed: 'Dismissed' };

function renderTeardown(d) {
  const st = d.structure || {};
  const signals = [
    st.headingsMatchingQuestion?.length ? `${st.headingsMatchingQuestion.length} heading${st.headingsMatchingQuestion.length === 1 ? '' : 's'} mirror the question` : null,
    st.hasFaqSchema ? 'FAQ schema' : null,
    st.hasReviewSchema ? 'Review schema' : null,
    st.hasOrganisationSchema ? 'Organisation schema' : null,
    st.hasAuthor ? 'named author' : null,
    st.tables ? `${st.tables} table${st.tables === 1 ? '' : 's'}` : null,
    st.statMentions ? `${st.statMentions} figures or prices` : null,
    st.publishedOrUpdated ? `updated ${String(st.publishedOrUpdated).slice(0, 10)}` : null,
    st.wordCount ? `${st.wordCount.toLocaleString()} words` : null
  ].filter(Boolean);

  const ex = d.explanation;
  return `
    <div class="teardown-head">
      <span class="tag">${esc(d.kind)}</span>
      ${d.cached ? '<span class="tag">from cache</span>' : ''}
      ${ex?.confidence ? `<span class="tag">${esc(ex.confidence)} confidence</span>` : ''}
      <a class="tag" href="${esc(d.url)}" target="_blank" rel="noopener">open page</a>
    </div>

    ${signals.length ? `<p class="teardown-label">What the page has</p><div class="chips">${signals.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
    ${st.headingsMatchingQuestion?.length ? `<p class="teardown-label">Headings that answer the question</p>
      <div class="chips">${st.headingsMatchingQuestion.map((h) => `<span class="chip dashed">${esc(h)}</span>`).join('')}</div>` : ''}

    ${ex?.why?.length ? `<p class="teardown-label">Why it was probably cited</p>
      <ul class="teardown-list">${ex.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}

    ${ex?.actions?.length ? `<p class="teardown-label">What to do on your page</p>
      <ul class="teardown-list actions">${ex.actions.map((a) => `<li><b>${esc(a.do)}</b><span>${esc(a.because)}</span></li>`).join('')}</ul>` : ''}

    ${st.partial ? '<p class="hint">Read through our renderer because the page blocks direct requests, so schema and table detection were unavailable.</p>' : ''}
    ${ex?.source === 'structural' ? '<p class="hint">Derived from the page structure directly.</p>' : ''}`;
}

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

/**
 * Every number on a card should open into the thing it counts. A figure a
 * reader cannot check is a claim, not evidence, and the whole product rests
 * on the difference.
 */
function detailPanel(id, label, rows) {
  if (!rows?.length) return '';
  return `<details class="qlist" id="d-${id}">
    <summary>${esc(label)}</summary>
    <div class="qlist-body">
      ${rows
        .map(
          (r) => `<div class="qrow">
            <span class="qhits"${r.hint ? ` title="${esc(r.hint)}"` : ''}>${esc(r.lead)}</span>
            <span class="qtext">${esc(r.text)}</span>
            ${r.url ? `<a class="qlink" href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(r.url)}">open</a>` : ''}
          </div>`
        )
        .join('')}
    </div>
  </details>`;
}

/** Turn whatever a rule recorded into rows the panel can show. */
function evidenceDetails(t) {
  const ev = t.evidence || {};
  const out = [];

  // A source shaping N questions: which N, and where it was cited.
  if (ev.questions?.length && typeof ev.questions[0] === 'object' && 'hits' in ev.questions[0]) {
    out.push([
      `Which ${ev.questions.length} question${ev.questions.length === 1 ? '' : 's'}`,
      ev.questions.map((q) => ({ lead: `${q.hits}\u00d7`, text: q.question, url: q.url, hint: 'Times cited for this question' }))
    ]);
  }

  // A competitor beating you: on which questions, and by how much.
  if (ev.questions?.length && typeof ev.questions[0] === 'object' && 'competitor_rate' in ev.questions[0]) {
    out.push([
      `Where ${ev.competitor || 'they'} beat you (${ev.questions.length})`,
      ev.questions.map((q) => ({
        lead: `${q.competitor_rate}%`,
        text: `${q.question}  \u2014 you ${q.own_rate}%`,
        hint: `${ev.competitor}: ${q.competitor_rate}%, you: ${q.own_rate}%`
      }))
    ]);
  }

  // Older evidence stored questions as plain strings.
  if (ev.questions?.length && typeof ev.questions[0] === 'string') {
    out.push([`Which ${ev.questions.length} questions`, ev.questions.map((q) => ({ lead: '', text: q }))]);
  }

  // Who took the citation you did not get.
  if (ev.took_the_citation?.length) {
    out.push([
      `Who got the citation (${ev.took_the_citation.length})`,
      ev.took_the_citation.map((c) => ({ lead: c.kind || '', text: c.domain, url: c.url }))
    ]);
  }

  // The search the engine ran before answering.
  if (ev.queries?.length) {
    out.push(['The searches it ran first', ev.queries.map((q) => ({ lead: '', text: q }))]);
  }

  return out.map(([label, rows], i) => detailPanel(`${t.id}-${i}`, label, rows)).join('');
}

/**
 * What each kind of action is, in words rather than in our field names.
 *
 * "decline alert" is our type identifier, and shown raw it reads as a broken
 * button: jargon, styled like the controls beside it, doing nothing when
 * clicked. These say what the action is about instead.
 */
const TYPE_LABEL = {
  decline_alert: 'visibility dropped',
  source_gap: 'a source that ignores you',
  content_gap: 'a question you lose',
  engine_gap: 'strong on one engine, absent on another',
  competitor_comparison: 'a competitor ahead of you',
  ordinal_push: 'named late in the answer',
  citable_asset: 'nothing worth quoting',
  entity_authority: 'who you are is unclear',
  fanout_target: 'the search behind the question',
  replicate_winner: 'something working, worth repeating',
  sentiment_correction: 'how you are described',
  named_not_cited: 'named, but the link went elsewhere'
};

function taskCard(t) {
  const ev = t.evidence || {};
  const bits = [];
  // A tag with detail behind it opens that detail rather than being inert.
  const opens = evidenceDetails(t) ? ' data-open-detail' : '';
  if (ev.own_rate !== undefined) bits.push(`<span class="tag">you ${ev.own_rate}%</span>`);
  if (ev.competitor_rate !== undefined) bits.push(`<span class="tag${opens ? ' clickable' : ''}"${opens}>${esc(ev.competitor)} ${ev.competitor_rate}%</span>`);
  if (ev.citations !== undefined) bits.push(`<span class="tag${opens ? ' clickable' : ''}"${opens}>${ev.citations} citations</span>`);
  if (ev.prompts !== undefined) bits.push(`<span class="tag${opens ? ' clickable' : ''}"${opens}>${ev.prompts} questions</span>`);
  if (ev.sessions !== undefined) bits.push(`<span class="tag">${ev.sessions} sessions</span>`);

  const buttons = {
    open: [['doing', 'Start'], ['done', 'Done'], ['dismissed', 'Dismiss']],
    doing: [['done', 'Mark done'], ['open', 'Back to to-do']],
    done: [['open', 'Reopen']],
    dismissed: [['open', 'Restore']]
  }[t.status] || [];

  // Deleting is offered once something is dismissed, where the intent is
  // clearly "not this, ever" rather than "not now".
  const canDelete = t.status === 'dismissed';

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
      <span class="tag kind">${esc(TYPE_LABEL[t.type] || t.type.replace(/_/g, ' '))}</span>
      ${bits.join('')}
      ${t.target_url ? `<a class="tag" href="${esc(t.target_url)}" target="_blank" rel="noopener">open source</a>` : ''}
      <span style="flex:1"></span>
      ${ev.analysable && ev.url && ev.question
        ? `<button class="ghost" data-teardown="${t.id}" data-url="${esc(ev.url)}" data-question="${esc(ev.question)}">Why were they cited?</button>`
        : ''}
      ${
        /**
         * An action about one question should open that question's answers.
         * A decline alert had no button at all: it said visibility fell and
         * then left the reader to go and find out where, which is the part
         * that needed doing.
         */
        ev.prompt_id
          ? `<button class="ghost" data-see-answer="${ev.prompt_id}">Read the answers</button>
             <button class="ghost" data-reask="${ev.prompt_id}">Ask again now</button>`
          : ''
      }
      <button class="ghost" data-task-edit="${t.id}">${t.assignee || t.due_date || t.notes ? 'Edit' : 'Assign'}</button>
      ${buttons.map(([st, label]) => `<button class="ghost" data-rec="${t.id}" data-status="${st}">${label}</button>`).join('')}
      ${canDelete ? `<button class="ghost danger" data-delete-rec="${t.id}" title="Remove it and stop it coming back">Delete</button>` : ''}
    </div>

    ${evidenceDetails(t)}

    <div class="teardown" id="teardown-${t.id}" hidden></div>
    ${ev.prompt_id ? '<div class="answers" data-answers hidden></div>' : ''}

    <div class="task-edit" id="edit-${t.id}" hidden>
      <div class="task-edit-row">
        <div class="field">
          <label for="a-${t.id}">Who is doing it</label>
          <input id="a-${t.id}" list="people-list" value="${esc(t.assignee || '')}" placeholder="Email address" />
          <span class="hint" style="margin:5px 0 0;display:block">
            An email address gets a note with the action and its due date. A name is just a label.
          </span>
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

/**
 * Who is doing what, across every site on the account. A task board per site
 * cannot answer "what has Sara got on", which is the question an agency
 * actually asks on a Monday.
 */
/**
 * Buyer personas in Setup.
 *
 * Each persona multiplies the question count and therefore the bill, so
 * nothing is applied automatically: the customer picks, and sees the cost
 * before agreeing to it.
 */
function personaCard(p) {
  const conf = p.evidence?.confidence || 'inferred';
  const qs = p.questions || [];

  return `<div class="persona ${p.active ? '' : 'off'}" data-persona="${p.id}">
    <div class="persona-top">
      <span class="pname">${esc(p.name)}</span>
      <span class="tag ${conf === 'evidence' ? 'ok' : ''}" title="${
        conf === 'evidence' ? 'Derived from real search queries' : 'Inferred, not evidenced'
      }">${conf === 'evidence' ? 'from your search data' : 'inferred'}</span>
      ${qs.length ? `<span class="tag">${qs.length} question${qs.length === 1 ? '' : 's'}</span>` : ''}
      <span class="spacer"></span>
      <button class="ghost" data-apply-persona="${p.id}">${qs.length ? 'Add more questions' : 'Add their questions'}</button>
      <button class="ghost danger" data-drop-persona="${p.id}">Remove</button>
    </div>
    <p class="pdesc">&ldquo;${esc(p.descriptor)}&rdquo;</p>
    ${p.context ? `<p class="hint" style="margin:6px 0 0">${esc(p.context)}</p>` : ''}

    ${
      qs.length
        ? `<details class="qlist" style="margin-top:10px">
            <summary>The ${qs.length} question${qs.length === 1 ? '' : 's'} they are asking</summary>
            <div class="qlist-body">
              ${qs
                .map(
                  (q) => `<div class="qrow">
                    <span class="qhits"></span>
                    <span class="qtext">${esc(q.text)}${q.active ? '' : ' <i class="paused">paused</i>'}</span>
                    <button class="qlink" data-drop-pq="${q.id}" data-of-persona="${p.id}">remove</button>
                  </div>`
                )
                .join('')}
            </div>
          </details>`
        : '<p class="hint" style="margin:8px 0 0">No questions yet for this buyer type.</p>'
    }
  </div>`;
}

/**
 * Somebody who knows their own buyers better than a model does should be
 * able to say so, and there needs to be a way forward when suggestion fails.
 */
/** Keep the cost of the choice in front of the person making it. */
function updatePqCount(id) {
  if (!id) return;
  const el = $(`pqCount-${id}`);
  if (!el) return;
  const n = document.querySelectorAll(`[data-preview="${id}"] [data-pq]:checked`).length;
  el.textContent = n
    ? `${n} more answer check${n === 1 ? '' : 's'} on every cycle`
    : 'nothing selected';
}

function manualPersonaForm() {
  return `<details class="qlist" style="margin-top:14px">
    <summary>Add one yourself</summary>
    <div class="field" style="margin-top:10px">
      <label for="pm_name">What to call them</label>
      <input id="pm_name" placeholder="Price-led SME" />
    </div>
    <div class="field">
      <label for="pm_desc">How they would describe themselves</label>
      <input id="pm_desc" placeholder="I run a five-person agency and I am watching every dirham" />
      <span class="hint" style="display:block;margin-top:5px">
        First person, as they would say it. This gets put in front of your questions.
      </span>
    </div>
    <button class="ghost" id="addPersonaManual">Add buyer type</button>
  </details>`;
}

async function loadPersonas() {
  const box = $('personaList');
  if (!box) return;
  const d = await api(`/api/projects/${state.projectId}/personas`);
  const rows = d?.personas || [];

  const lift = await api(`/api/projects/${state.projectId}/personas/lift`).catch(() => null);
  const byId = new Map((lift?.lift || []).map((l) => [l.personaId, l]));

  box.innerHTML = (rows.length
    ? rows
        .map((p) => {
          const l = byId.get(p.id);
          // Whether it is earning its cost, said plainly.
          const verdict = l
            ? `<p class="plift ${l.differentBrands.length || l.missingBrands.length ? 'good' : 'flat'}">${esc(l.verdict)}${
                l.differentBrands.length ? `. They see: ${l.differentBrands.slice(0, 4).map(esc).join(', ')}` : ''
              }${l.missingBrands.length ? `. They do not see: ${l.missingBrands.slice(0, 4).map(esc).join(', ')}` : ''}</p>`
            : '';
          return personaCard(p) + verdict;
        })
        .join('')
    : '<p class="hint" style="margin:0">No buyer types yet. Suggest some, and we will use your Search Console data if it is connected.</p>') +
    manualPersonaForm();
}

async function viewAssigned() {
  const data = await api('/api/assigned');
  if (!data) return '<div class="empty"><h2>Could not load assignments</h2></div>';

  if (!data.people.length) {
    return `<div class="empty">
      <h2>Nothing is assigned yet</h2>
      <p>Assign an action to an email address on the Actions tab. They get the task by email, and a link to their own list that works without a login.</p>
    </div>`;
  }

  const person = (p) => {
    const live = p.tasks.filter((t) => t.status !== 'done' && t.status !== 'dismissed');
    const rows = live
      .map(
        (t) => `<div class="arow${t.overdue ? ' is-overdue' : ''}">
          <span class="asite">${esc(t.site)}</span>
          <span class="atitle">${esc(t.title)}</span>
          <span class="adue">${
            t.due_date
              ? `${t.overdue ? '<b>' : ''}${new Date(t.due_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}${t.overdue ? '</b>' : ''}`
              : '&mdash;'
          }</span>
          <span class="astatus ${t.status}">${t.status === 'doing' ? 'in progress' : t.status}</span>
        </div>`
      )
      .join('');

    return `<div class="panel person">
      <div class="panel-head">
        <h2>${esc(p.assignee)}</h2>
        <div class="spacer"></div>
        ${p.overdue ? `<span class="tag overdue">${p.overdue} overdue</span>` : ''}
        <span class="tag">${p.open + p.doing} live</span>
        ${p.done ? `<span class="tag">${p.done} done</span>` : ''}
        ${/@/.test(p.assignee) ? `<button class="ghost" data-copy-link="${esc(p.assignee)}">Copy their link</button>` : ''}
      </div>
      ${live.length ? `<div class="atable">${rows}</div>` : '<p class="hint" style="margin:0">Nothing open.</p>'}
    </div>`;
  };

  return `<p class="dek">Everyone with work on this account, across every site.${
    data.unassigned ? ` <b>${data.unassigned}</b> open action${data.unassigned === 1 ? ' is' : 's are'} assigned to nobody.` : ''
  }</p>
  ${data.people.map(person).join('')}`;
}

/**
 * Search Console says which pages earn which searches. This says whether the
 * AI Overview above those searches cites them.
 *
 * Three outcomes are kept apart throughout, because they are three different
 * problems: no overview shown at all, one shown without you, and one citing
 * your site but through a different page than the one that earns the search.
 */
/**
 * What to pull from Search Console before anything is chosen.
 *
 * A path is how someone asks about one section of a site, which is usually
 * how content is actually organised and reviewed.
 */
function pcScope() {
  return `<div class="pcscope">
    <div class="field">
      <label for="pcPath">Only pages containing</label>
      <input id="pcPath" placeholder="a folder, or one full URL" autocomplete="off" />
      <span class="hint" style="display:block;margin-top:5px">
        Any part of a URL works: a folder such as <code>/insights</code>, or a single page pasted in full.
      </span>
    </div>
    <div class="field">
      <label for="pcDays">Last</label>
      <select id="pcDays">
        <option value="28">28 days</option>
        <option value="90" selected>90 days</option>
        <option value="180">6 months</option>
        <option value="480">16 months</option>
      </select>
    </div>
    <div class="field">
      <label for="pcMin">Minimum impressions</label>
      <input id="pcMin" type="number" min="1" value="1" />
    </div>
  </div>`;
}

/** Keep the count and the cost in front of the person choosing. */
function updatePcCount() {
  const el = document.getElementById('pcCount');
  if (!el) return;

  // Each group box reflects its children, so the state is readable at a glance.
  for (const g of document.querySelectorAll('.pcp-group')) {
    const kids = [...g.querySelectorAll('[data-pcq]')];
    const head = g.querySelector('[data-pcgroup]');
    if (!head || !kids.length) continue;
    const on = kids.filter((b) => b.checked).length;
    head.checked = on === kids.length;
    head.indeterminate = on > 0 && on < kids.length;
  }

  const n = document.querySelectorAll('[data-pcq]:checked').length;
  el.textContent = n ? `${n} searches, about $${(n * 0.0025).toFixed(2)}` : 'nothing selected';
  const btn = document.getElementById('pcRun');
  if (btn) btn.disabled = n === 0;
}

async function viewPages() {
  const d = await api(`/api/projects/${state.projectId}/page-checks`);

  if (!d || !d.total) {
    return `<div class="empty">
      <h2>Check your pages against the AI Overview</h2>
      <p>
        Search Console knows which of your pages earns which searches. This asks Google those same searches and
        records whether an AI Overview appears above the results, and whether it cites you.
        Ranking third and being absent from the answer above the third result are different problems.
      </p>
      ${pcScope()}
      <div class="inline-form" style="justify-content:center;margin-top:14px">
        <button class="btn" id="pcPreview">See what it would check</button>
      </div>
      <div id="pcPanel" style="margin-top:18px"></div>
    </div>`;
  }

  const rate = (n) => (d.withOverview ? Math.round((n / d.withOverview) * 100) : 0);

  const row = (r) => {
    const verdict = !r.overview
      ? '<span class="tag">no overview</span>'
      : r.page_cited
        ? '<span class="tag ok">this page cited</span>'
        : r.domain_cited
          ? '<span class="tag warn" title="Your site was cited, but through a different page">another page cited</span>'
          : '<span class="tag bad">not cited</span>';

    const rivals = (r.competitors || []).filter((c) => c.tracked);

    return `<div class="pcrow" data-filter-text="${esc(`${r.query} ${r.page || ''}`.toLowerCase())}">
      <div>
        <div class="pcq">${esc(r.query)}</div>
        ${r.page ? `<a class="pcp" href="${esc(r.page)}" target="_blank" rel="noopener">${esc(r.page.replace(/^https?:\/\/(www\.)?/, ''))}</a>` : ''}
        ${rivals.length ? `<div class="pcrivals">tracked competitor cited: ${rivals.map((c) => esc(c.domain)).join(', ')}</div>` : ''}
      </div>
      <div class="pcnum">${r.impressions.toLocaleString()}</div>
      <div class="pcnum">${r.position ?? '-'}</div>
      <div>${verdict}</div>
    </div>`;
  };

  return `<div class="figures">
      <div class="figure">
        <div class="label">Searches checked</div>
        <div class="value">${d.total}</div>
        <div class="sub">from Search Console, by impressions</div>
      </div>
      <div class="figure">
        <div class="label">Show an AI Overview</div>
        <div class="value">${d.withOverview}</div>
        <div class="sub">${d.noOverview} showed none, which is Google's choice rather than yours</div>
      </div>
      <div class="figure">
        <div class="label">Cite you</div>
        <div class="value ${rate(d.cited) < 25 ? 'down' : ''}">${rate(d.cited)}%</div>
        <div class="sub">${d.cited} of ${d.withOverview} overviews</div>
      </div>
      <div class="figure">
        <div class="label">Impressions with no mention</div>
        <div class="value ${d.missedImpressions ? 'down' : ''}">${d.missedImpressions.toLocaleString()}</div>
        <div class="sub">searches you already rank for, answered above you without you</div>
      </div>
    </div>

    ${d.wrongPage ? `<p class="warn-band" style="margin:18px 0 0">
      <b>${d.wrongPage} ${d.wrongPage === 1 ? 'search cites' : 'searches cite'} your site through a different page</b>
      than the one earning the search. The site is trusted for those questions; the page doing the ranking is not the
      one being quoted.
    </p>` : ''}

    <div class="panel" style="margin-top:18px">
      <div class="panel-head">
        <h2>Every search checked</h2>
        <div class="spacer"></div>
        <span class="meta" style="font-family:var(--mono);font-size:11px;color:var(--ink-3)">checked ${esc(new Date(d.checkedOn).toLocaleDateString())}</span>
        <button class="ghost" id="pcPreview">Run again</button>
      </div>
      ${pcScope()}
      <div id="pcPanel"></div>
      <div class="searchrow" style="max-width:420px;margin-bottom:10px">
        <input type="search" id="pcFilter" placeholder="Filter searches or pages" autocomplete="off" />
      </div>
      <div class="pchead">
        <div>Search and the page that earns it</div>
        <div class="pcnum">Impressions</div>
        <div class="pcnum">Position</div>
        <div>In the overview</div>
      </div>
      ${d.rows.map(row).join('')}
    </div>`;
}

async function viewQuestions() {
  const prompts = await api(`/api/projects/${state.projectId}/prompts`);
  if (!prompts?.length) {
    return `<div class="empty"><h2>No questions yet</h2><p>Add some in Setup, or let us suggest them from your site.</p></div>`;
  }
  const brand = state.overview?.project?.brand_name;
  const rows = prompts
    .map((p) => {
      const chips = p.citations
        .map((c) => `<span class="chip ${c.domain === state.overview?.project?.domain?.replace(/^www\./, '') ? 'own' : ''}">${esc(c.domain)}</span>`)
        .join('');
      // A persona question carries its descriptor as a prefix, which makes
      // the list unreadable. Show the question, and the buyer type beside it.
      const asked = p.persona && p.personaDescriptor && p.text.startsWith(p.personaDescriptor.replace(/[.]+$/, ''))
        ? p.text.slice(p.personaDescriptor.replace(/[.]+$/, '').length + 2)
        : p.text;

      return `
      <div class="prompt ${p.measured ? '' : 'unmeasured'}"
        data-persona="${p.personaId || ''}"
        data-cluster="${esc(p.cluster || '')}"
        data-intent="${esc(p.intent || '')}"
        data-state="${p.measured ? (p.rate === 0 ? 'invisible' : p.rate < 0.5 ? 'weak' : 'strong') : 'unrun'}"
        data-rate="${p.measured ? p.rate : -1}"
        data-volume="${p.volume || 0}"
        data-title="${esc((p.persona ? p.text.slice(-80) : p.text).toLowerCase())}"
        data-filter-text="${esc(`${p.text} ${p.cluster} ${p.intent} ${p.persona || ''} ${p.citations.map((c) => c.domain).join(' ')}`.toLowerCase())}">
        <div>
          <p class="prompt-q">${esc(asked)}</p>
          ${p.persona ? `<div class="asked-as" title="${esc(p.personaDescriptor || '')}"><span>asked as</span> ${esc(p.persona)}</div>` : ''}
          <div class="prompt-tags">
            ${esc(p.cluster)} &middot; ${esc(p.intent)} &middot; est. AI volume <b>${p.volume ?? '-'}</b>
            ${p.active ? '' : ' &middot; <span class="paused">paused</span>'}
          </div>
          ${p.measured ? runStrip(p.runs) : '<div class="notrun">not asked yet, it will run on the next cycle</div>'}
          ${p.measured ? `<button class="seeanswer" data-see-answer="${p.id}">Read what each engine said</button>` : ''}
          ${p.measured ? `<button class="seeanswer" data-reask="${p.id}">Ask again now</button>` : ''}
          <div class="answers" data-answers hidden></div>
          ${p.snippet ? `<div class="excerpt">${highlight(p.snippet, brand)}</div>` : ''}
          ${chips ? `<div class="chips">${chips}</div>` : ''}
          ${p.fanOut?.length ? `<div class="fanout"><span class="fanout-label">searched for</span>${p.fanOut.map((q) => `<span class="chip">${esc(q)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="rates">
          <div class="rate ${p.measured ? rateClass(p.seenRate ?? p.rate) : 'none'}">${p.measured ? pct(p.seenRate ?? p.rate) : '&mdash;'}</div>
          ${
            p.measured && (p.citedRate || p.rate)
              ? `<div class="ratesplit" title="Named means the answer said your name. Cited means it linked to your site as a source.">
                  named ${pct(p.rate)} &middot; cited ${pct(p.citedRate || 0)}
                </div>`
              : ''
          }
        </div>
      </div>`;
    })
    .join('');
  // Let someone read the list one buyer type at a time, which is the point
  // of having them.
  const personas = [...new Map(prompts.filter((p) => p.persona).map((p) => [p.personaId, p.persona])).entries()];
  const waiting = prompts.filter((p) => !p.measured).length;

  // Two buyer types asking the same thing costs twice and measures once.
  const dupes = await api(`/api/projects/${state.projectId}/duplicate-questions`).catch(() => null);

  /**
   * The list is long and every question is one of several kinds. Sorting and
   * grouping are the difference between a list and something you can work
   * through, and everything needed is already on each row.
   */
  const clusters = [...new Set(prompts.map((p) => p.cluster).filter(Boolean))].sort();
  const intents = [...new Set(prompts.map((p) => p.intent).filter(Boolean))].sort();

  const count = (fn) => prompts.filter(fn).length;
  const chip = (group, value, label, n) =>
    `<button class="tfilter${value === 'all' ? ' is-on' : ''}" data-group="${group}" data-value="${esc(value)}">${esc(label)}${
      n === undefined ? '' : ` ${n}`
    }</button>`;

  const filters = `
    <div class="qtools">
      <div class="qtool">
        <span class="qtool-k">Show</span>
        <div class="taskbar">
          ${chip('state', 'all', 'All', prompts.length)}
          ${count((p) => p.measured && p.rate === 0) ? chip('state', 'invisible', 'Never named', count((p) => p.measured && p.rate === 0)) : ''}
          ${count((p) => p.measured && p.rate > 0 && p.rate < 0.5) ? chip('state', 'weak', 'Named sometimes', count((p) => p.measured && p.rate > 0 && p.rate < 0.5)) : ''}
          ${count((p) => p.measured && p.rate >= 0.5) ? chip('state', 'strong', 'Named often', count((p) => p.measured && p.rate >= 0.5)) : ''}
          ${count((p) => !p.measured) ? chip('state', 'unrun', 'Not asked yet', count((p) => !p.measured)) : ''}
        </div>
      </div>

      ${
        personas.length
          ? `<div class="qtool">
              <span class="qtool-k">Buyer</span>
              <div class="taskbar">
                ${chip('persona', 'all', 'Anyone')}
                ${chip('persona', 'none', 'Asked plainly', count((p) => !p.persona))}
                ${personas.map(([id, name]) => chip('persona', String(id), name, count((p) => p.personaId === id))).join('')}
              </div>
            </div>`
          : ''
      }

      <div class="qtool qtool-row">
        ${
          clusters.length > 1
            ? `<span class="qpick">
                <label for="qcluster">Topic</label>
                <select id="qcluster" data-select-group="cluster">
                  <option value="all">Everything</option>
                  ${clusters
                    .map((c) => `<option value="${esc(c)}">${esc(c.replace(/-/g, ' '))} (${count((p) => p.cluster === c)})</option>`)
                    .join('')}
                </select>
              </span>`
            : ''
        }
        ${
          intents.length > 1
            ? `<span class="qpick">
                <label for="qintent">Intent</label>
                <select id="qintent" data-select-group="intent">
                  <option value="all">Any</option>
                  ${intents
                    .map((i) => `<option value="${esc(i)}">${esc(i)} (${count((p) => p.intent === i)})</option>`)
                    .join('')}
                </select>
              </span>`
            : ''
        }
        <span class="qpick">
          <label for="qsort">Sort</label>
          <select id="qsort">
            <option value="opportunity">Biggest opportunity</option>
            <option value="rate-asc">Least visible first</option>
            <option value="rate-desc">Most visible first</option>
            <option value="volume">Most asked first</option>
            <option value="az">A to Z</option>
          </select>
        </span>
      </div>
    </div>`;

  return `<div class="panel">
    <div class="panel-head">
      <h2>Every question on this site</h2>
      <div class="spacer"></div>
      <span class="meta" style="font-family:var(--mono);font-size:11px;color:var(--ink-3)">filled tick = you were named</span>
    </div>
    ${waiting ? `<p class="hint" style="margin:0 0 12px">${waiting} question${waiting === 1 ? ' has' : 's have'} not been asked yet. Run a cycle to measure ${waiting === 1 ? 'it' : 'them'}.</p>` : ''}
    ${
      dupes?.wasted
        ? `<div class="callout warn" style="margin:0 0 14px">
            <b>${dupes.wasted} question${dupes.wasted === 1 ? ' is' : 's are'} being asked more than once</b>
            under different buyer types. Each copy costs an answer check every cycle, and near-identical buyer types
            usually get near-identical answers.
            <details class="qlist" style="margin-top:8px">
              <summary>Show them</summary>
              <div class="qlist-body">
                ${dupes.duplicates
                  .map(
                    (d) => `<div class="qrow">
                      <span class="qhits">${d.copies.length}&times;</span>
                      <span class="qtext">${esc(d.base.slice(0, 90))}<br />
                        <i class="dupewho">${d.copies.map((c) => esc(c.persona)).join(' &middot; ')}</i>
                      </span>
                      <span class="qlink"></span>
                    </div>`
                  )
                  .join('')}
              </div>
            </details>
          </div>`
        : ''
    }
    ${filters}
    ${prompts.length > 8 ? searchBox('promptFilter', 'Filter by question, cluster or cited domain', 'promptFilterCount') : ''}
    <div id="promptList">
      ${rows}
      <p class="hint" data-filter-empty hidden>No question matches that.</p>
    </div>
  </div>`;
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
  const data = Array.isArray(rows) ? { rows } : rows || {};
  const series = data.rows || [];
  const totals = (series).reduce(
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

  const cells = (series)
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

  ${series.length ? `
  <div class="figures">
    <div class="figure">
      <div class="label">AI sessions, ${data.days || 30} days</div>
      <div class="value">${totals.sessions.toLocaleString()}</div>
      <div class="sub">
        ${cvr.toFixed(1)}% conversion${
          data.totals?.change != null
            ? ` &middot; <span class="${data.totals.change >= 0 ? 'up' : 'down'}">${
                data.totals.change >= 0 ? '+' : ''
              }${Math.round(data.totals.change * 100)}% on the previous ${data.days || 30} days</span>`
            : ''
        }
      </div>
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

  ${
    data.pages?.length
      ? `<div class="panel">
          <div class="panel-head"><h2>Where AI traffic lands</h2></div>
          <p class="hint" style="margin:0 0 12px">
            The pages assistants actually send people to, and what happens next. A page with sessions and no
            conversions is the clearest thing on this screen to go and fix.
          </p>
          <div class="pchead">
            <div>Page</div>
            <div class="pcnum">Sessions</div>
            <div class="pcnum">Conversions</div>
            <div class="pcnum">Rate</div>
          </div>
          ${data.pages
            .map((p) => {
              const rate = p.sessions ? (p.conversions / p.sessions) * 100 : 0;
              return `<div class="pcrow">
                <div><a class="pcp" href="${esc(p.landing_page)}" target="_blank" rel="noopener">${esc(
                  String(p.landing_page).replace(/^https?:\/\/(www\.)?[^/]+/, '') || '/'
                )}</a></div>
                <div class="pcnum">${p.sessions.toLocaleString()}</div>
                <div class="pcnum">${Math.round(p.conversions).toLocaleString()}</div>
                <div class="pcnum ${p.sessions > 20 && rate === 0 ? 'down' : ''}">${rate.toFixed(1)}%</div>
              </div>`;
            })
            .join('')}
        </div>`
      : ''
  }

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
  box.innerHTML =
    (d.properties.length > 6 ? searchBox('ga4Filter', 'Filter by property or account name', 'ga4FilterCount') : '') +
    `<div id="ga4List">` +
    d.properties
      .map(
        (p) => `<div class="row" data-filter-text="${esc(`${p.name} ${p.account} ${p.id}`.toLowerCase())}">
          <div class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.account)} &middot; ${esc(p.id)}</div></div>
          <button class="ghost" data-ga4-pick="${esc(p.id)}" data-ga4-name="${esc(p.name)}">Use this</button>
        </div>`
      )
      .join('') +
    `<p class="hint" data-filter-empty hidden>No property matches that.</p></div>`;
}

document.addEventListener('click', async (e) => {
  const err = (m) => { const el = $('ga4Error'); if (el) el.textContent = m || ''; };

  if (e.target.id === 'ga4Connect') {
    e.target.disabled = true;
    // Analytics only. Search Console is asked for separately, when it is
    // actually wanted, rather than bundled into this consent screen.
    const res = await fetch(`/api/projects/${state.projectId}/ga4/connect?what=ga4`);
    const d = await res.json();
    if (!res.ok) { err(d.error); e.target.disabled = false; return; }
    window.location.href = d.url;
  }

  if (e.target.id === 'gscGrant') {
    e.target.disabled = true;
    const res = await fetch(`/api/projects/${state.projectId}/ga4/connect?what=gsc`);
    const d = await res.json();
    if (!res.ok) { err(d.error); e.target.disabled = false; return; }
    window.location.href = d.url;
  }

  /**
   * Two different things, deliberately separate.
   *
   * Changing property is common and should not cost someone their Google
   * connection. Disconnecting is rare and should actually disconnect, which
   * it did not: the token went and the property choice stayed, leaving a site
   * pointing at something it could no longer read.
   */
  if (e.target.id === 'gscSwitch') {
    e.target.disabled = true;
    await api(`/api/projects/${state.projectId}/ga4/disconnect`, { method: 'POST', body: { what: 'gsc' } });
    await render();
    setTimeout(() => $('gscLoad')?.click(), 300);
    return;
  }

  if (e.target.id === 'gscDisconnect') {
    if (!confirm('Disconnect Google from this site? Analytics goes with it, since they share one connection. Questions already imported are kept.')) return;
    e.target.disabled = true;
    await api(`/api/projects/${state.projectId}/ga4/disconnect`, { method: 'POST', body: { what: 'all' } });
    await render();
    return;
  }

  if (e.target.id === 'ga4Disconnect') {
    if (!confirm('Disconnect Google Analytics from this site? Traffic data already pulled is kept.')) return;
    await fetch(`/api/projects/${state.projectId}/ga4/disconnect`, { method: 'POST' });
    await render();
  }

  if (e.target.id === 'ga4Reconnect') {
    e.target.disabled = true;
    const res = await fetch(`/api/projects/${state.projectId}/ga4/connect?what=both`);
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
  const fn = {
    actions: viewActions, assigned: viewAssigned, pages: viewPages, questions: viewQuestions, rivals: viewRivals,
    sources: viewSources, traffic: viewTraffic, setup: viewSetup, billing: viewBilling,
    trends: viewTrends, landscape: viewLandscape
  }[view];
  $('view').innerHTML = await fn();
  if (view === 'setup') { recalcEstimate(); loadPersonas(); }
  if (view === 'questions') {
    // Reset, or a filter from a previous site silently narrows this one.
    Object.assign(qState, { state: 'all', persona: 'all', cluster: 'all', intent: 'all', sort: 'opportunity', text: '' });
    for (const el of document.querySelectorAll('[data-select-group]')) el.value = 'all';
    applyQuestionView();
  }
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
  const cap = window.innerWidth < 760 ? 12 : 18;
  const short = p.name.length > cap ? p.name.slice(0, cap - 1) + '\u2026' : p.name;
  $('runBtn').innerHTML = `Run ${esc(short)} <span class="caret">&#9662;</span>`;
  $('runBtn').title =
    state.emailVerified === false
      ? 'Confirm your email address before running a cycle'
      : `Choose what to run for ${esc(p.name)}`;
  if (state.emailVerified === false) $('runBtn').classList.add('needs-verify');
  refreshRunScope();
  await renderFigures();
  await render();
}

/**
 * Which site is open lives in the URL, so it survives a reload, the back
 * button, and the round trip out to Google and back. Previously it lived
 * only in memory and any refresh of the list silently reset it to the first
 * project, which quietly moved you off whatever you were working on.
 */
function rememberProject(id) {
  const url = new URL(location.href);
  url.searchParams.set('site', String(id));
  history.replaceState({}, '', url);
}

function projectFromUrl() {
  const n = Number(new URLSearchParams(location.search).get('site'));
  return Number.isInteger(n) && n > 0 ? n : null;
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
  // Prefer, in order: an explicit choice, whatever is already open, the URL,
  // then the first project. Falling straight to the first was the bug.
  const wanted = [selectId, state.projectId, projectFromUrl()].find(
    (id) => id && projects.some((p) => p.id === Number(id))
  );
  const chosen = Number(wanted) || projects[0].id;
  $('projectPicker').innerHTML = projects
    .map((p) => `<option value="${p.id}" ${p.id === chosen ? 'selected' : ''}>${esc(p.name)}</option>`)
    .join('');
  rememberProject(chosen);
  await loadProject(chosen);
  return true;
}

/**
 * Where a Google connection should land when it comes back.
 *
 * It used to assume Analytics whatever had been asked for, so connecting
 * Search Console from Setup landed on Traffic and then failed listing
 * Analytics properties.
 */
function handleGoogleReturn() {
  const params = new URLSearchParams(location.search);
  // "ga4" is the older parameter; still read so a link in flight during a
  // deploy does not land nowhere.
  const what = params.get('connected') || (params.get('ga4') ? 'ga4' : null);
  if (!what) return null;

  const failed = params.get('error') === '1' || params.get('ga4') === 'error';
  const site = params.get('site');
  history.replaceState({}, '', site ? `/app?site=${encodeURIComponent(site)}` : '/app');

  return {
    what: what === 'gsc' ? 'gsc' : 'ga4',
    ok: !failed,
    message:
      params.get('message') ||
      (what === 'gsc' ? 'Could not connect Search Console' : 'Could not connect Google Analytics')
  };
}

async function boot() {
  const returned = handleGoogleReturn();
  const me = await api('/api/me');
  if (!me?.signedIn) { window.location.href = '/login'; return; }
  if (me.mock) $('mockNotice').hidden = false;

  // Both come from the /api/me already fetched above, so no second call.
  // The link is shown only where it works; the route enforces access itself.
  const adminLink = $('adminLink');
  if (adminLink) adminLink.hidden = !me.admin;
  showVerifyBar(me);

  /**
   * Say it on the control, not only in a banner.
   *
   * Someone can miss a bar at the top of the page, do the whole setup, click
   * Run and only then learn they cannot. Disabling the button says it before
   * the work rather than after.
   */
  state.emailVerified = me.emailVerified !== false;

  await loadProjectList();
  await refreshUsagePill();

  if (returned) {
    // Search Console lives in Setup, Analytics in Traffic.
    const tab = returned.what === 'gsc' ? 'setup' : 'traffic';
    document.querySelector(`.tab[data-view="${tab}"]`)?.click();

    if (!returned.ok) {
      setTimeout(() => {
        const el = returned.what === 'gsc' ? $('setupError') : $('ga4Error');
        if (el) el.textContent = returned.message;
      }, 400);
    } else if (returned.what === 'gsc') {
      // Straight to the thing they came for, rather than leaving them to find it.
      setTimeout(() => $('gscLoad')?.click(), 500);
    }
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

$('projectPicker').addEventListener('change', (e) => {
  const id = Number(e.target.value);
  rememberProject(id);
  loadProject(id);
});

$('signOut').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
});

/* ---------- running a cycle ---------- */

function resetRunLabel() {
  const name = state.overview?.project?.name || 'cycle';
  const cap = window.innerWidth < 760 ? 12 : 18;
  const short = name.length > cap ? name.slice(0, cap - 1) + '\u2026' : name;
  // The caret has to come back with the label, or the control stops looking
  // like the menu it is.
  $('runBtn').innerHTML = `Run ${esc(short)} <span class="caret">&#9662;</span>`;
}

const PHASE_LABEL = {
  starting: 'Starting up',
  asking: 'Asking the engines',
  thinking: 'Reading answers and writing your actions',
  done: 'Finished'
};

const ENGINE_LABEL = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  claude: 'Claude',
  perplexity: 'Perplexity',
  ai_overview: 'Google AI Overview',
  ai_mode: 'Google AI Mode'
};

/**
 * A cycle takes minutes, and a bar that only counts gives no reason to
 * believe anything is happening. Showing the actual questions going out, and
 * whether the brand came back named, turns the wait into the product.
 */
function showProgress(phase, done, total, recent = []) {
  $('cycleBar').hidden = false;
  $('cycleLabel').textContent = PHASE_LABEL[phase] || 'Working';
  $('cycleCount').textContent = total ? `${done} of ${total} answers` : '';
  const pct = phase === 'thinking' ? 100 : total ? Math.round((done / total) * 100) : 5;
  $('cycleFill').style.width = `${Math.max(3, pct)}%`;

  const feed = $('cycleFeed');
  if (!feed) return;

  if (!recent.length) {
    feed.hidden = true;
    return;
  }
  feed.hidden = false;
  feed.innerHTML = recent
    .map((r) => {
      const mark =
        r.state === 'answered'
          ? r.named
            ? '<span class="fmark named" title="You were named in this answer">named</span>'
            : '<span class="fmark missed" title="You were not named">not named</span>'
          : r.state === 'failed'
            ? '<span class="fmark failed">no answer</span>'
            : '<span class="fmark asking">asking</span>';
      return `<div class="frow ${r.state}">
        <span class="fengine">${esc(ENGINE_LABEL[r.engine] || r.engine)}</span>
        <span class="fq">${esc(r.question)}</span>
        ${mark}
      </div>`;
    })
    .join('');
}

function hideProgress() {
  $('cycleBar').hidden = true;
  $('cycleFill').style.width = '0%';
  if ($('cycleFeed')) {
    $('cycleFeed').hidden = true;
    $('cycleFeed').innerHTML = '';
  }
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
  const broken = s.failed.filter((f) => f.mostlyBroken);

  const list = s.failed
    .map((f) => {
      const pct = f.rate ? ` (${Math.round(f.rate * 100)}% of its calls)` : '';
      return `<b>${esc(f.engine)}</b> failed ${f.count} time${f.count === 1 ? '' : 's'}${pct}${f.error ? `, ${esc(f.error)}` : ''}`;
    })
    .join('; ');

  /**
   * "Invalid Field" is the provider rejecting our request, not the provider
   * being unreliable. Telling a customer to switch an engine off because of
   * it blames their configuration for our bug, and they lose a working
   * surface until someone notices.
   */
  const ourFault = s.failed.filter((f) => /invalid field/i.test(f.error || ''));
  const theirs = broken.filter((f) => !/invalid field/i.test(f.error || ''));

  const ourNote = ourFault.length
    ? `<br /><br /><b>${ourFault.map((f) => esc(f.engine)).join(' and ')}</b> ${ourFault.length === 1 ? 'was' : 'were'} rejected because
       we sent something the provider does not accept. That is a fault on our side, not yours, and not a reason to switch
       ${ourFault.length === 1 ? 'it' : 'them'} off. It is already logged for us to fix; the surface will start reporting again once it is.`
    : '';

  const theirNote = theirs.length
    ? `<br /><br /><b>${theirs.map((b) => esc(b.engine)).join(' and ')}</b> ${theirs.length === 1 ? 'is' : 'are'} failing most of the time, so ${theirs.length === 1 ? 'it is' : 'they are'} adding nothing to your numbers.
       Switch ${theirs.length === 1 ? 'it' : 'them'} off under <b>Where we look</b> until the provider is reliable again, and your remaining surfaces will run faster.
       <button class="ghost" data-goto-setup="1" style="margin-left:6px;padding:4px 9px;font-size:10px">Open Setup</button>`
    : '';

  const advice = ourNote + theirNote;

  return `<p class="report-warn">${total} of ${s.attempted} calls did not return an answer. ${list}. Those were not charged to your allowance, and the visibility figure above ignores them.${advice}</p>`;
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
  showProgress(status.phase, status.done || 0, status.total || 0, status.recent || []);
  return false;
}

/**
 * Start a cycle, optionally only over questions never asked.
 *
 * A partial run joins the most recent cycle rather than opening a new one,
 * so the trend keeps comparing like with like.
 */
async function startCycle(only = null) {
  const btn = $('runBtn');
  btn.disabled = true;
  btn.textContent = 'Starting';
  $('cycleReport').hidden = true;

  const res = await fetch(`/api/projects/${state.projectId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ only })
  });
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
}

$('runBtn').addEventListener('click', (e) => {
  // The caret is a child span, so a tap landing on it bubbles to the
  // document handler that closes the menu, and the control appears dead.
  e.stopPropagation();
  e.preventDefault();

  /**
   * Point at the reason before opening a menu that cannot be used.
   *
   * The block is enforced server side, but discovering it only after
   * choosing what to run means learning about it at the worst moment.
   */
  if (state.emailVerified === false) {
    const bar = $('verifyBar');
    if (bar) {
      bar.hidden = false;
      bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      bar.classList.add('nudge');
      setTimeout(() => bar.classList.remove('nudge'), 1200);
    }
    return;
  }

  // Opens the menu. Nothing spends money until an item is chosen.
  const open = !$('runMenu').hidden;
  $('runMenu').hidden = open;
  $('runBtn').setAttribute('aria-expanded', String(!open));
  if (!open) refreshRunScope();
});

$('runFullBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  $('runMenu').hidden = true;
  await startCycle(null);
});

$('runUnrunBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  $('runMenu').hidden = true;
  await startCycle('unrun');
});

/** Say how many are waiting, so the menu item is a decision rather than a guess. */
async function refreshRunScope() {
  if (!state.projectId) return;
  const d = await api(`/api/projects/${state.projectId}/run-scope`);
  if (!d) return;

  // Both options carry their size, so neither is chosen blind.
  const full = $('runFullCount');
  if (full) full.textContent = d.all ? ` (${d.all}, ${d.checksAll} checks)` : ' (no questions yet)';
  if ($('runFullBtn')) $('runFullBtn').disabled = d.all === 0;

  const el = $('runUnrunCount');
  if (el) el.textContent = d.unrun ? ` (${d.unrun}, ${d.checksUnrun} checks)` : ' (none waiting)';
  if ($('runUnrunBtn')) $('runUnrunBtn').disabled = d.unrun === 0;
}

document.addEventListener('click', () => {
  $('runMenu').hidden = true;
  $('runBtn').setAttribute('aria-expanded', 'false');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('runMenu').hidden) {
    $('runMenu').hidden = true;
    $('runBtn').setAttribute('aria-expanded', 'false');
    $('runBtn').focus();
  }
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

document.addEventListener('click', async (e) => {
  const lp = e.target.closest('[data-landscape]');
  if (lp) { state.landscapePlatform = lp.dataset.landscape; await render(); return; }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-report]')) $('cycleReport').hidden = true;
  if (e.target.closest('[data-goto-setup]')) document.querySelector('.tab[data-view="setup"]').click();
  const goto = e.target.closest('[data-report-goto]');
  if (goto) {
    document.querySelector(`.tab[data-view="${goto.dataset.reportGoto}"]`).click();
    document.querySelector('.tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

/**
 * Filters combine rather than replace each other, so "never named" and
 * "pricing" and "enterprise buyer" narrow to the intersection. Picking one
 * filter and having it silently clear another is the usual way these become
 * untrustworthy.
 */
const qState = { state: 'all', persona: 'all', cluster: 'all', intent: 'all', sort: 'opportunity', text: '' };

function applyQuestionView() {
  const list = document.getElementById('promptList');
  if (!list) return;

  const rows = [...list.querySelectorAll('.prompt')];
  let shown = 0;

  for (const r of rows) {
    const d = r.dataset;
    const ok =
      (qState.state === 'all' || d.state === qState.state) &&
      (qState.persona === 'all' ||
        (qState.persona === 'none' ? !d.persona : d.persona === qState.persona)) &&
      (qState.cluster === 'all' || d.cluster === qState.cluster) &&
      (qState.intent === 'all' || d.intent === qState.intent) &&
      (!qState.text || d.filterText.includes(qState.text));
    r.hidden = !ok;
    if (ok) shown++;
  }

  const num = (r, k) => Number(r.dataset[k]);
  const sorted = rows.slice().sort((a, b) => {
    switch (qState.sort) {
      case 'rate-asc':
        // Unmeasured questions carry -1 so they sort last rather than
        // appearing as the worst performers.
        return (num(a, 'rate') < 0 ? 2 : num(a, 'rate')) - (num(b, 'rate') < 0 ? 2 : num(b, 'rate'));
      case 'rate-desc':
        return num(b, 'rate') - num(a, 'rate');
      case 'volume':
        return num(b, 'volume') - num(a, 'volume');
      case 'az':
        return a.dataset.title.localeCompare(b.dataset.title);
      default: {
        // Most asked and least visible first, which is where the work is.
        const score = (r) => (num(r, 'rate') < 0 ? 0 : (1 - num(r, 'rate')) * Math.log10((num(r, 'volume') || 10) + 10));
        return score(b) - score(a);
      }
    }
  });
  for (const r of sorted) list.appendChild(r);

  const empty = list.querySelector('[data-filter-empty]');
  if (empty) {
    empty.hidden = shown > 0;
    list.appendChild(empty);
  }
  const counter = document.getElementById('promptFilterCount');
  if (counter) counter.textContent = shown === rows.length ? '' : `${shown} of ${rows.length}`;
}

document.addEventListener('click', async (e) => {
  const again = e.target.closest('[data-reask]');
  if (again) {
    const id = again.dataset.reask;
    again.disabled = true;
    again.textContent = 'Asking';
    const d = await api(`/api/prompts/${id}/reask`, { method: 'POST' });
    again.disabled = false;

    if (d?.error) {
      again.textContent = 'Ask again now';
      setupErr(d.error);
      return;
    }

    // Say what happened to the old answers rather than silently changing a
    // number: a replaced run and an added one mean different things.
    const named = (d.results || []).filter((r) => r.named).map((r) => r.engine);
    const replaced = (d.results || []).reduce((n, r) => n + (r.replaced || 0), 0);
    again.textContent = named.length
      ? `named by ${named.join(', ')}`
      : 'still not named';
    again.title = replaced
      ? `${replaced} earlier answer${replaced === 1 ? ' was' : 's were'} incomplete and have been replaced. Sound answers were kept.`
      : 'Kept alongside the earlier answers as another sample.';

    await render();
    return;
  }

  const see = e.target.closest('[data-see-answer]');
  if (see) {
    const id = see.dataset.seeAnswer;
    /**
     * Found relative to the button, not by id. The same question can appear
     * on the Questions tab and on an action card, and a shared id meant
     * clicking one filled the other.
     */
    const box = see.closest('.rec, .prompt')?.querySelector('[data-answers]');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; see.textContent = 'Read what each engine said'; return; }

    see.textContent = 'Loading';
    const d = await api(`/api/prompts/${id}/answers`);
    see.textContent = 'Hide the answers';
    box.hidden = false;
    /**
     * Everyone checks a surprising result by asking the engine themselves,
     * and then finds a different answer. That is not usually a fault in the
     * measurement, and saying so here saves the same conversation every time.
     */
    const preamble = `<p class="hint" style="margin:0 0 10px">
      This is what the engine returned to a fresh, signed-out session in ${esc(state.overview?.project?.market || 'your market')}.
      Asking the same question in your own account can differ: your history, saved memories and location all shape
      what comes back, and a brand you have been researching is far more likely to appear. Neither answer is wrong,
      but only this one describes what a stranger sees.
    </p>`;

    box.innerHTML = preamble + (d?.runs || [])
      .map((r) => {
        const verdict = r.mentioned
          ? `<span class="tag ok">named${r.ordinal ? `, ${r.ordinal}${r.ordinal === 1 ? 'st' : r.ordinal === 2 ? 'nd' : r.ordinal === 3 ? 'rd' : 'th'}` : ''}</span>`
          : '<span class="tag">not named</span>';
        return `<div class="ans">
          <div class="ans-head">
            <span class="ans-engine">${esc(r.engine)}</span>
            ${r.model ? `<span class="ans-model">${esc(r.model)}</span>` : ''}
            ${verdict}
            ${r.truncated ? '<span class="tag warn" title="The answer stopped at our length limit, so anything after that was not measured">cut short</span>' : ''}
          </div>
          ${
            r.response_text
              ? `<div class="ans-body">${esc(r.response_text)}</div>`
              : `<p class="hint" style="margin:0">${esc(r.error || 'No answer was returned.')}</p>`
          }
        </div>`;
      })
      .join('') || '<p class="hint" style="margin:0">Nothing stored for this question yet.</p>';
    return;
  }

  const chip = e.target.closest('[data-group]');
  if (!chip) return;
  const group = chip.dataset.group;
  for (const b of document.querySelectorAll(`[data-group="${group}"]`)) b.classList.toggle('is-on', b === chip);
  qState[group] = chip.dataset.value;
  applyQuestionView();
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'qsort') {
    qState.sort = e.target.value;
    applyQuestionView();
    return;
  }
  // Topic and intent are long lists that read badly as chips, so they are
  // dropdowns. They still narrow alongside everything else.
  const group = e.target.dataset?.selectGroup;
  if (!group) return;
  qState[group] = e.target.value;
  applyQuestionView();
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'promptFilter') return;
  qState.text = e.target.value.trim().toLowerCase();
  applyQuestionView();
});

/**
 * Switching a series off hides it and rescales nothing.
 *
 * Rescaling on toggle would make the remaining lines jump, which reads as the
 * data changing rather than the view. The axis stays fixed at 0 to 100.
 */
document.addEventListener('click', (e) => {
  const key = e.target.closest('[data-series][data-chart]');
  if (!key) return;

  key.classList.toggle('is-on');
  const wrap = document.querySelector(`[data-chart-id="${key.dataset.chart}"]`);
  const line = wrap?.querySelector(`.seriesline[data-series="${key.dataset.series}"]`);
  if (line) line.style.display = key.classList.contains('is-on') ? '' : 'none';
});

/** Read out every visible series at whichever date the pointer is nearest. */
function chartHover(wrap, date) {
  const id = wrap.dataset.chartId;
  const data = window.__charts?.[id];
  if (!data) return;

  const readout = wrap.querySelector('.readout');
  const on = new Set(
    [...wrap.querySelectorAll('.serieskey.is-on')].map((k) => Number(k.dataset.series))
  );

  const rows = data.series
    .map((s, i) => ({ ...s, i }))
    .filter((s) => on.has(s.i) && s.values[date] != null)
    .sort((a, b) => b.values[date] - a.values[date]);

  if (!rows.length) {
    readout.hidden = true;
    return;
  }

  readout.hidden = false;
  readout.innerHTML =
    `<div class="readout-date">${esc(shortDate(date))}</div>` +
    rows
      .map(
        (r) => `<div class="readout-row${r.own ? ' own' : ''}">
          <span class="swatch" style="--k:${r.colour}"></span>
          <span class="readout-label">${esc(r.label)}</span>
          <span class="readout-value">${Math.round(r.values[date] * 100)}%</span>
        </div>`
      )
      .join('');
}

document.addEventListener('mouseover', (e) => {
  const zone = e.target.closest('.hitzone');
  if (!zone) return;
  const wrap = zone.closest('.chartwrap');
  if (!wrap) return;

  const cross = wrap.querySelector('.crosshair');
  if (cross) {
    const x = Number(zone.getAttribute('x')) + Number(zone.getAttribute('width')) / 2;
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.style.display = '';
  }
  chartHover(wrap, zone.dataset.date);
});

document.addEventListener('mouseout', (e) => {
  const wrap = e.target.closest('.chartwrap');
  if (!wrap || wrap.contains(e.relatedTarget)) return;
  wrap.querySelector('.readout')?.setAttribute('hidden', '');
  const cross = wrap.querySelector('.crosshair');
  if (cross) cross.style.display = 'none';
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'pcSearch') {
    const needle = e.target.value.trim().toLowerCase();
    for (const q of document.querySelectorAll('.pcp-q')) {
      q.hidden = Boolean(needle) && !q.dataset.text.includes(needle);
    }
    // A page with nothing left to show is noise, and a match inside a shut
    // group would otherwise be invisible.
    for (const g of document.querySelectorAll('.pcp-group')) {
      const anyVisible = [...g.querySelectorAll('.pcp-q')].some((q) => !q.hidden);
      g.hidden = !anyVisible;
      if (needle && anyVisible) g.classList.remove('is-shut');
    }
    return;
  }
  if (e.target.id !== 'pcFilter') return;
  const needle = e.target.value.trim().toLowerCase();
  for (const r of document.querySelectorAll('.pcrow')) {
    r.hidden = Boolean(needle) && !r.dataset.filterText.includes(needle);
  }
});

document.addEventListener('click', async (e) => {
  if (e.target.id === 'resendVerify') {
    e.target.disabled = true;
    await api('/api/verify/resend', { method: 'POST' });
    e.target.textContent = 'Sent';
    return;
  }

  if (e.target.id === 'pcPreview') {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Reading Search Console';
    const q = new URLSearchParams({
      path: $('pcPath')?.value.trim() || '',
      days: $('pcDays')?.value || '90',
      min: $('pcMin')?.value || '1'
    });
    const d = await api(`/api/projects/${state.projectId}/page-checks/preview?${q}`);
    btn.disabled = false;
    btn.textContent = 'See what it would check';

    const panel = $('pcPanel');
    if (d?.error) {
      // Every error here has a fix, so every error should show one.
      const fix =
        d.fix === 'connect'
          ? '<button class="btn" id="gscGrant">Connect Search Console</button>'
          : d.fix === 'gsc'
            ? '<button class="ghost" data-goto-setup="1">Choose a property in Setup</button>'
            : '';
      panel.innerHTML = `<p class="error">${esc(d.error)}</p>${fix ? `<div class="inline-form" style="margin-top:10px">${fix}</div>` : ''}`;
      return;
    }
    // Every search, grouped by the page that earns it. Branded ones are
    // unticked by default: an AI Overview naming you for your own brand
    // confirms nothing, and on some brands that is most of the list.
    window.__pcPages = d.pages;
    // With hundreds of searches across dozens of pages, an open list is
    // unreadable. Groups collapse once there are enough of them to matter.
    const collapse = d.pages.length > 6;

    panel.innerHTML = `<div class="pq-preview" id="pcPicker">
      <div class="pcp-head">
        <p class="hint" style="margin:0">
          ${d.queries} searches from the last 90 days${
            d.branded ? `, of which <b>${d.branded}</b> mention your brand and are unticked` : ''
          }. Each check costs about $${d.costPerQuery.toFixed(4)}.
        </p>
        <div class="taskbar" style="margin-top:10px">
          <button class="tfilter" data-pcpick="unbranded">Unbranded only</button>
          <button class="tfilter" data-pcpick="all">Everything</button>
          <button class="tfilter" data-pcpick="top20">Top 20 by impressions</button>
          <button class="tfilter" data-pcpick="none">Clear</button>
        </div>
        <div class="searchrow" style="max-width:340px;margin-top:10px">
          <input type="search" id="pcSearch" placeholder="Filter searches or pages" autocomplete="off" />
        </div>
      </div>

      ${
        d.sections?.length
          ? `<div class="pcp-sections">
              <span class="qtool-k">Sections</span>
              ${d.sections
                .map(
                  (sec) => `<button class="tfilter" data-pcsection="${esc(sec.path)}" title="${sec.pages} pages, ${sec.impressions.toLocaleString()} impressions">
                    ${esc(sec.path)} <i>${sec.queries}</i>
                  </button>`
                )
                .join('')}
            </div>`
          : ''
      }

      <div class="pcp-list">
        ${d.pages
          .map(
            (g) => `<div class="pcp-group ${collapse ? 'is-shut' : ''}" data-page="${esc(g.page)}">
              <div class="pcp-grouphead">
                <input type="checkbox" data-pcgroup="${esc(g.page)}" />
                <button class="pcp-toggle" data-pctoggle aria-label="Show searches">
                  <span class="pcp-url">${esc(g.page === 'unknown' ? 'No page recorded' : g.page.replace(/^https?:\/\/(www\.)?/, ''))}</span>
                  <span class="pcp-qn">${g.queries.length}</span>
                </button>
                <span class="pcp-imp">${g.impressions.toLocaleString()}</span>
              </div>
              ${g.queries
                .map(
                  (q) => `<label class="pcp-q" data-text="${esc(`${q.query} ${g.page}`.toLowerCase())}">
                    <input type="checkbox" data-pcq="${esc(q.query)}" ${q.branded ? '' : 'checked'} />
                    <span class="pcp-qt">${esc(q.query)}${q.branded ? '<i class="pcp-brand">brand</i>' : ''}</span>
                    <span class="pcp-imp">${q.impressions.toLocaleString()}</span>
                    <span class="pcp-pos">${q.position ?? ''}</span>
                  </label>`
                )
                .join('')}
            </div>`
          )
          .join('')}
      </div>

      <div class="inline-form pcp-foot">
        <button class="btn" id="pcRun">Check selected</button>
        <span class="hint" id="pcCount"></span>
      </div>
    </div>`;
    updatePcCount();
    return;
  }

  const pick = e.target.closest('[data-pcpick]');
  if (pick) {
    const how = pick.dataset.pcpick;
    const boxes = [...document.querySelectorAll('[data-pcq]')];
    const branded = new Set(
      (window.__pcPages || []).flatMap((g) => g.queries.filter((q) => q.branded).map((q) => q.query))
    );
    const top = new Set(
      (window.__pcPages || [])
        .flatMap((g) => g.queries)
        .filter((q) => !q.branded)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 20)
        .map((q) => q.query)
    );
    for (const b of boxes) {
      const q = b.dataset.pcq;
      b.checked =
        how === 'all' ? true : how === 'none' ? false : how === 'top20' ? top.has(q) : !branded.has(q);
    }
    updatePcCount();
    return;
  }

  // A section chip re-scopes the fetch rather than filtering what is already
  // on screen, so the counts and the cost are for the section itself.
  const section = e.target.closest('[data-pcsection]');
  if (section) {
    const field = $('pcPath');
    if (field) {
      field.value = section.dataset.pcsection;
      $('pcPreview')?.click();
    }
    return;
  }

  const toggle = e.target.closest('[data-pctoggle]');
  if (toggle) {
    toggle.closest('.pcp-group').classList.toggle('is-shut');
    return;
  }

  const group = e.target.closest('[data-pcgroup]');
  if (group) {
    // The group box starts unchecked while its children may be ticked, so
    // clicking it once appeared to do nothing. Toggle on what the children
    // are, not on the box's own state.
    const box = group.closest('.pcp-group');
    const kids = [...box.querySelectorAll('[data-pcq]')];
    const allOn = kids.every((b) => b.checked);
    for (const b of kids) b.checked = !allOn;
    group.checked = !allOn;
    updatePcCount();
    return;
  }

  if (e.target.matches('[data-pcq]')) { updatePcCount(); return; }

  if (e.target.id === 'pcRun') {
    const queries = [...document.querySelectorAll('[data-pcq]:checked')].map((b) => b.dataset.pcq);
    if (!queries.length) return;
    e.target.disabled = true;
    e.target.textContent = `Checking ${queries.length}`;
    const r = await api(`/api/projects/${state.projectId}/page-checks/run`, { method: 'POST', body: { queries } });
    if (r?.checked) await render();
    return;
  }

  if (e.target.id === 'suggestPersonas') {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Reading your data';
    const d = await api(`/api/projects/${state.projectId}/personas/suggest`, { method: 'POST' });
    btn.disabled = false;
    btn.textContent = 'Suggest buyer types';
    if (!d?.personas?.length) {
      $('personaList').innerHTML =
        '<p class="hint" style="margin:0">Could not suggest buyer types just now. Try again in a moment, or add one yourself below.</p>' +
        manualPersonaForm();
      return;
    }

    // Shown for approval rather than saved: a suggested persona is a guess
    // until someone who knows the business agrees with it.
    $('personaList').innerHTML =
      `<p class="hint" style="margin:0 0 12px">${esc(d.evidence.note)} Pick the ones that match how people actually buy from you.</p>` +
      d.personas
        .map(
          (p, i) => `<label class="persona choose">
            <input type="checkbox" data-suggested="${i}" checked />
            <span>
              <span class="pname">${esc(p.name)}</span>
              <span class="pdesc">&ldquo;${esc(p.descriptor)}&rdquo;</span>
              ${p.context ? `<span class="hint">${esc(p.context)}</span>` : ''}
            </span>
          </label>`
        )
        .join('') +
      `<div class="inline-form" style="margin-top:12px">
         <button class="btn" id="savePersonas">Save selected</button>
       </div>` +
      manualPersonaForm();
    window.__suggestedPersonas = d.personas;
    return;
  }

  if (e.target.id === 'addPersonaManual') {
    const name = $('pm_name')?.value.trim();
    const descriptor = $('pm_desc')?.value.trim();
    if (!name || descriptor.length < 15) {
      setupErr('Give them a name and a sentence describing how they would introduce themselves.');
      return;
    }
    e.target.disabled = true;
    await api(`/api/projects/${state.projectId}/personas`, {
      method: 'POST',
      body: { personas: [{ name, descriptor, source: 'manual', evidence: { from: 'you', confidence: 'stated' } }] }
    });
    await loadPersonas();
    return;
  }

  if (e.target.id === 'savePersonas') {
    const chosen = [...document.querySelectorAll('[data-suggested]:checked')].map(
      (c) => window.__suggestedPersonas[Number(c.dataset.suggested)]
    );
    if (!chosen.length) return;
    e.target.disabled = true;
    const r = await api(`/api/projects/${state.projectId}/personas`, { method: 'POST', body: { personas: chosen } });
    await loadPersonas();
    if (r?.note) setupErr(r.note);
    return;
  }

  // Show the questions before adding them. Nobody should agree to something
  // billable they have not read.
  const applyP = e.target.closest('[data-apply-persona]');
  if (applyP) {
    applyP.disabled = true;
    applyP.textContent = 'Loading';
    const d = await api(`/api/personas/${applyP.dataset.applyPersona}/preview`);
    applyP.disabled = false;
    applyP.textContent = 'Add their questions';
    if (!d?.questions?.length) {
      setupErr('Add some questions to this site first, then a buyer type can be applied to them.');
      return;
    }

    const box = document.querySelector(`[data-persona="${d.persona.id}"]`);
    if (!box) return;
    const available = d.questions.filter((q) => !q.alreadyAdded);

    box.insertAdjacentHTML(
      'beforeend',
      `<div class="pq-preview" data-preview="${d.persona.id}">
        <p class="hint" style="margin:0 0 10px">
          These are your questions, asked as <b>${esc(d.persona.name)}</b>. Pick the ones worth measuring twice.
          Each one adds an answer check on every cycle.
        </p>
        ${available
          .map(
            (q, i) => `<label class="pq">
              <input type="checkbox" data-pq="${q.baseId}" ${i < 5 ? 'checked' : ''} />
              <span>${esc(q.text)}</span>
            </label>`
          )
          .join('') ||
          '<p class="hint" style="margin:0">Every one of your questions has already been added for this buyer type. Add more questions to the site first, or remove some from the list above.</p>'}
        ${d.questions.length > available.length ? `<p class="hint" style="margin:8px 0 0">${d.questions.length - available.length} already added.</p>` : ''}
        ${available.length ? `<div class="inline-form" style="margin-top:12px">
          <button class="btn" data-confirm-persona="${d.persona.id}">Add selected</button>
          <button class="ghost" data-cancel-preview="${d.persona.id}">Cancel</button>
          <span class="hint" id="pqCount-${d.persona.id}"></span>
        </div>` : ''}
      </div>`
    );
    updatePqCount(d.persona.id);
    return;
  }

  if (e.target.matches('[data-pq]')) {
    updatePqCount(e.target.closest('[data-preview]')?.dataset.preview);
    return;
  }

  const cancelPv = e.target.closest('[data-cancel-preview]');
  if (cancelPv) {
    document.querySelector(`[data-preview="${cancelPv.dataset.cancelPreview}"]`)?.remove();
    return;
  }

  const confirmP = e.target.closest('[data-confirm-persona]');
  if (confirmP) {
    const id = confirmP.dataset.confirmPersona;
    const baseIds = [...document.querySelectorAll(`[data-preview="${id}"] [data-pq]:checked`)].map((c) =>
      Number(c.dataset.pq)
    );
    if (!baseIds.length) { setupErr('Pick at least one question.'); return; }
    confirmP.disabled = true;
    confirmP.textContent = 'Adding';
    const r = await api(`/api/personas/${id}/apply`, { method: 'POST', body: { baseIds } });
    document.querySelector(`[data-preview="${id}"]`)?.remove();
    await loadPersonas();
    recalcEstimate();
    setupErr('');
    return;
  }

  const dropQ = e.target.closest('[data-drop-pq]');
  if (dropQ) {
    dropQ.disabled = true;
    await fetch(`/api/personas/${dropQ.dataset.ofPersona}/questions/${dropQ.dataset.dropPq}`, { method: 'DELETE' });
    await loadPersonas();
    recalcEstimate();
    return;
  }

  const dropP = e.target.closest('[data-drop-persona]');
  if (dropP) {
    if (!confirm('Remove this buyer type? Questions already asked as them stay in your history.')) return;
    await fetch(`/api/personas/${dropP.dataset.dropPersona}`, { method: 'DELETE' });
    await loadPersonas();
    return;
  }

  const copy = e.target.closest('[data-copy-link]');
  if (copy) {
    const r = await api(`/api/assigned/${encodeURIComponent(copy.dataset.copyLink)}/link`);
    if (r?.url) {
      await navigator.clipboard.writeText(r.url).catch(() => {});
      const was = copy.textContent;
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = was; }, 1800);
    }
    return;
  }
});

document.addEventListener('click', (e) => {
  // Clicking a count opens the panel that lists what it counts.
  const tag = e.target.closest('[data-open-detail]');
  if (!tag) return;
  const card = tag.closest('.rec');
  const panel = card?.querySelector('.qlist');
  if (panel) {
    panel.open = !panel.open;
    if (panel.open) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});

document.addEventListener('click', async (e) => {
  if (e.target.id === 'loadSuppressed') {
    const box = $('suppressedList');
    box.innerHTML = '<p class="hint">Loading</p>';
    const rows = await api(`/api/projects/${state.projectId}/suppressed`);
    box.innerHTML = rows?.length
      ? rows
          .map(
            (r) => `<div class="row">
              <div class="grow"><div class="name">${esc(r.title || r.fingerprint)}</div>
              <div class="sub">deleted ${esc(new Date(r.created_at).toLocaleDateString())}</div></div>
              <button class="ghost" data-unsuppress="${r.id}">Allow it back</button>
            </div>`
          )
          .join('')
      : '<p class="hint">Nothing has been deleted.</p>';
    return;
  }

  const un = e.target.closest('[data-unsuppress]');
  if (un) {
    un.disabled = true;
    await fetch(`/api/projects/${state.projectId}/suppressed/${un.dataset.unsuppress}`, { method: 'DELETE' });
    un.closest('.row').remove();
    return;
  }

  const tf = e.target.closest('[data-task-filter]');
  if (tf) {
    state.taskFilter = tf.dataset.taskFilter;
    await render();
    return;
  }

  const td = e.target.closest('[data-teardown]');
  if (td) {
    const id = td.dataset.teardown;
    const box = $(`teardown-${id}`);
    box.hidden = false;
    box.innerHTML = '<p class="hint">Reading the page and working out why it was chosen</p>';
    td.disabled = true;

    const res = await fetch(`/api/projects/${state.projectId}/teardown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: td.dataset.url, question: td.dataset.question })
    });
    const d = await res.json();
    td.disabled = false;

    if (!res.ok) { box.innerHTML = `<p class="error">${esc(d.error)}</p>`; return; }
    box.innerHTML = renderTeardown(d);
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
      if (updated.notified) {
        const note = document.querySelector(`[data-task="${id}"] .task-meta`);
        if (note) note.insertAdjacentHTML('beforeend', '<span class="tag" data-mailtag>sending</span>');

        // The send resolves after the response, so the result is checked a
        // moment later. Saying "emailed" when nothing sent is worse than
        // saying nothing.
        setTimeout(async () => {
          const last = await api('/api/notifications/last-assignment');
          const tag = document.querySelector(`[data-task="${id}"] [data-mailtag]`);
          if (!tag) return;
          if (last?.emailed) {
            tag.textContent = 'emailed';
            tag.classList.add('ok');
          } else {
            tag.textContent = 'email failed';
            tag.classList.add('bad');
            tag.title = last?.email_error || 'The message could not be sent.';
          }
        }, 2500);
      }
    } else {
      const j = await res.json();
      $(`saved-${id}`).textContent = j.error || 'Could not save';
    }
    return;
  }

  const del = e.target.closest('[data-delete-rec]');
  if (del) {
    if (!confirm('Delete this action permanently? It will not come back on the next cycle. You can undo this from the Dismissed filter.')) return;
    del.disabled = true;
    const res = await fetch(`/api/recommendations/${del.dataset.deleteRec}`, { method: 'DELETE' });
    if (!res.ok) { del.disabled = false; return; }
    const card = document.querySelector(`[data-task="${del.dataset.deleteRec}"]`);
    if (card) {
      card.classList.add('leaving');
      card.innerHTML = '<p class="rec-action">Deleted. It will not be regenerated.</p>';
      setTimeout(() => card.remove(), 2500);
    }
    await refreshTaskCounts();
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
      (q) => `<div class="row ${q.active ? '' : 'off'}" data-filter-text="${esc(`${q.text} ${q.cluster} ${q.intent}`.toLowerCase())}">
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
  const cost = active * chosen.length * (p.runs_per_cycle || 1);

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
        <div class="field">
          <label for="s_runs">Runs per question, per engine</label>
          <input id="s_runs" type="number" min="1" max="10" value="${p.runs_per_cycle}" />
          <span class="hint" style="display:block;margin-top:5px">
            One is enough to see whether you are named. Raising it measures how much the answer wobbles
            between identical asks, and multiplies what each cycle costs.
          </span>
        </div>
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

    <div>
    <div class="panel" id="personaPanel">
      <div class="panel-head">
        <h2>Who is asking</h2>
        <div class="spacer"></div>
        <button class="ghost" id="suggestPersonas">Suggest buyer types</button>
      </div>
      <p class="hint">
        The same question gets a different answer depending on who asks it. A price-led buyer and an enterprise
        buyer are shown different companies. One number for both hides which of them cannot see you.
      </p>
      <div id="personaList"></div>
    </div>

    <div class="panel" id="gscPanel">
      <div class="panel-head">
        <h2>From Search Console</h2>
        <div class="spacer"></div>
        ${
          p.gsc_site_url
            ? `<button class="ghost" id="gscSwitch" title="Choose a different property">Change property</button>
               <button class="ghost danger" id="gscDisconnect">Disconnect</button>`
            : ''
        }
        <button class="ghost" id="gscLoad">Find questions people already ask</button>
      </div>
      <p class="hint" style="margin:0">
        Your own Search Console data shows what people search before they find you. We cluster it, turn the ones with
        real demand into questions worth tracking, and use the impressions as the volume behind prioritisation.
        ${
          p.gsc_site_url
            ? `<br />Reading <b>${esc(p.gsc_site_url)}</b>${
                p.gsc_account_email ? ` as ${esc(p.gsc_account_email)}` : ''
              }. Analytics and Search Console can use different Google accounts.`
            : ''
        }
      </p>
      <div id="gscBody"></div>
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
      <p class="dek" style="margin:0 0 12px;font-size:13px">Write these the way a customer types them, never with the brand name in. Paused questions stay in the record but are not asked.</p>

      <div class="qcompose">
        <input id="q_text" placeholder="A question a buyer would type, or a topic to build questions from" autocomplete="off" />
        <button class="ghost" id="q_topic" title="Turn a topic into the questions a buyer would actually ask">Generate from topic</button>
        <button id="q_add">Add as written</button>
      </div>
      <p class="hint" style="margin:6px 0 0">
        A topic such as <code>retirement planning</code> becomes the questions your buyers would ask about it, using
        what this site already knows about your category and audience.
      </p>
      <div id="qTopicPanel"></div>
      <p class="error" id="setupError" role="alert"></p>

      ${data.prompts.length > 8 ? searchBox('qFilter', 'Filter questions', 'qFilterCount') : ''}
      <div id="qList">
        ${promptRows}
        <p class="hint" data-filter-empty hidden>No question matches that.</p>
      </div>
    </div>
    </div>
  </div>`;
}

/**
 * Filter a list of rows in place. Lists here get long (a GA4 account can hold
 * hundreds of properties, and a site can track sixty questions), so filtering
 * happens client-side against text already on the page rather than round
 * tripping to the server.
 */
function filterRows(containerId, term, countId) {
  const box = $(containerId);
  if (!box) return;
  const needle = term.trim().toLowerCase();
  let shown = 0;

  for (const row of box.querySelectorAll('[data-filter-text]')) {
    const hit = !needle || row.dataset.filterText.includes(needle);
    row.hidden = !hit;
    if (hit) shown++;
  }

  const empty = box.querySelector('[data-filter-empty]');
  if (empty) empty.hidden = shown > 0;
  const counter = countId && $(countId);
  if (counter) counter.textContent = needle ? `${shown} of ${box.querySelectorAll('[data-filter-text]').length}` : '';
}

function searchBox(id, placeholder, countId) {
  return `<div class="searchrow">
    <input type="search" id="${id}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" />
    ${countId ? `<span class="searchcount" id="${countId}"></span>` : ''}
  </div>`;
}

/* ---------- search console import ---------- */

/**
 * How many more questions this site can take, said before anything is picked.
 *
 * The cap was only reported after selecting and clicking, so the work of
 * choosing happened first and the refusal came second.
 */
function importRoom(d) {
  const cap = d?.limit?.questions;
  const used = d?.limit?.active;
  if (!cap || used === undefined) return '';
  const room = Math.max(0, cap - used);
  if (room === 0) {
    return `This site is at its limit of ${cap} active questions. Pause or delete one before importing, or upgrade for more.`;
  }
  return `Room for ${room} more on this plan, out of ${cap}.`;
}

function gscCandidateRow(c, i) {
  const pos = c.avgPosition ? c.avgPosition.toFixed(1) : '-';
  const haystack = `${c.text} ${c.examples.join(' ')} ${c.cluster || ''}`.toLowerCase();
  return `<div class="row ${c.alreadyTracked ? 'off' : ''}" data-filter-text="${esc(haystack)}">
    <label class="grow eng">
      <input type="checkbox" data-gsc="${i}" ${c.alreadyTracked ? 'disabled' : 'checked'} />
      <span>
        <span class="name">${esc(c.text)}</span>
        <span class="sub">
          ${c.impressions.toLocaleString()} impressions &middot; ${c.clicks} clicks &middot; position ${pos}
          ${c.variants > 1 ? ` &middot; ${c.variants} variations` : ''}
          ${c.alreadyTracked ? ' &middot; already tracked' : ''}
        </span>
        <span class="sub gsc-examples">from: ${esc(c.examples.slice(0, 3).join(', '))}</span>
      </span>
    </label>
  </div>`;
}

/**
 * A 403 from Google means several different things and each needs a different
 * fix. Offering "reconnect" for all of them sent people round in circles.
 */
function gscError(d) {
  const detail = d.detail ? `<p class="hint" style="margin-top:8px">Google said: ${esc(d.detail)}</p>` : '';

  if (d.fix === 'enable-api') {
    return `<p class="error">${esc(d.error)}</p>
      <div class="inline-form" style="margin-top:10px">
        <a class="btn ghost" href="${esc(d.link || 'https://console.cloud.google.com/apis/library/searchconsole.googleapis.com')}" target="_blank" rel="noopener">Enable the Search Console API</a>
        <button class="ghost" id="gscLoad">Try again</button>
      </div>${detail}`;
  }

  if (d.fix === 'connect') {
    return `<p class="hint" style="margin:0 0 10px">${esc(d.error)} Connecting takes one screen, and we only ask for Search Console.</p>
      <div class="inline-form">
        <button class="btn" id="gscGrant">Connect Search Console</button>
      </div>${detail}`;
  }

  if (d.fix === 'reconnect') {
    // Search Console is a separate grant now, so this is one more approval
    // rather than redoing the Analytics connection.
    return `<p class="error">${esc(d.error)}</p>
      <p class="hint" style="margin-top:8px">
        We ask for Analytics and Search Console separately, so you only hand over what you actually want to use.
        Granting this takes one screen and keeps your existing connection.
      </p>
      <div class="inline-form" style="margin-top:10px">
        <button class="btn" id="gscGrant">Allow Search Console</button>
      </div>${detail}`;
  }

  return `<p class="error">${esc(d.error)}</p>${detail}`;
}

async function loadGscCandidates() {
  const body = $('gscBody');
  body.innerHTML = '<p class="hint">Reading the last 90 days from Search Console</p>';

  const res = await fetch(`/api/projects/${state.projectId}/gsc/candidates`);
  const d = await res.json();

  if (!res.ok) {
    if (/property/i.test(d.error || '')) return loadGscSites();
    body.innerHTML = gscError(d);
    return;
  }
  if (!d.candidates.length) {
    body.innerHTML = `<p class="hint">Search Console returned ${d.rows} queries but none made a sensible buyer question. That usually means the site is new or the traffic is mostly branded.</p>`;
    return;
  }

  state.gscCandidates = d.candidates;
  const available = d.candidates.filter((c) => !c.alreadyTracked).length;

  body.innerHTML = `
    <div class="gsc-summary">
      <span class="tag">${d.rows.toLocaleString()} queries read</span>
      <span class="tag">${d.totalImpressions.toLocaleString()} impressions</span>
      <span class="tag">${d.clusters} intent clusters</span>
      <span class="tag ok">${available} worth tracking</span>
    </div>
    ${searchBox('gscFilter', 'Filter these questions', 'gscFilterCount')}
    <div id="gscList">
      ${d.candidates.map(gscCandidateRow).join('')}
      <p class="hint" data-filter-empty hidden>Nothing matches that.</p>
    </div>
    <div class="inline-form">
      <button id="gscImport">Add selected questions</button>
      <button class="ghost" id="gscAll">Select shown</button>
      <button class="ghost" id="gscNone">Clear selection</button>
      <span class="hint" id="gscNote" style="margin:0">${esc(importRoom(d))}</span>
    </div>`;
}

async function loadGscSites() {
  const body = $('gscBody');
  body.innerHTML = '<p class="hint">Loading your Search Console properties</p>';
  const res = await fetch(`/api/projects/${state.projectId}/gsc/sites`);
  const d = await res.json();

  if (!res.ok) { body.innerHTML = gscError(d); return; }
  if (!d.sites.length) {
    body.innerHTML = '<p class="hint">That Google account cannot see any Search Console properties.</p>';
    return;
  }
  body.innerHTML = `<p class="teardown-label">Which property</p>` +
    (d.sites.length > 6 ? searchBox('gscSiteFilter', 'Filter properties', 'gscSiteCount') : '') +
    `<div id="gscSiteList">` +
    d.sites
      .map(
        (s) => `<div class="row" data-filter-text="${esc(s.url.toLowerCase())}">
          <div class="grow"><div class="name">${esc(s.url)}</div><div class="sub">${esc(s.permission)}</div></div>
          <button class="ghost" data-gsc-site="${esc(s.url)}">Use this</button>
        </div>`
      )
      .join('') +
    `<p class="hint" data-filter-empty hidden>No property matches that.</p></div>`;
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'gscLoad') { e.target.disabled = true; await loadGscCandidates(); e.target.disabled = false; }

  const site = e.target.closest('[data-gsc-site]');
  if (site) {
    site.disabled = true;
    await fetch(`/api/projects/${state.projectId}/gsc/site`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteUrl: site.dataset.gscSite })
    });
    await loadGscCandidates();
  }

  if (e.target.id === 'gscNone') {
    document.querySelectorAll('input[data-gsc]').forEach((b) => { if (!b.disabled) b.checked = false; });
  }

  if (e.target.id === 'gscAll') {
    // Only what is currently visible, so it works with the filter.
    document.querySelectorAll('#gscList .row:not([hidden]) input[data-gsc]').forEach((b) => {
      if (!b.disabled) b.checked = true;
    });
  }

  if (e.target.id === 'gscImport') {
    const picked = [...document.querySelectorAll('input[data-gsc]:checked')].map(
      (b) => state.gscCandidates[Number(b.dataset.gsc)]
    );
    if (!picked.length) { $('gscNote').textContent = 'Nothing selected.'; return; }

    e.target.disabled = true;
    const res = await fetch(`/api/projects/${state.projectId}/gsc/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: picked })
    });
    const d = await res.json();
    e.target.disabled = false;

    if (!res.ok) { $('gscNote').textContent = d.error; return; }
    $('gscNote').textContent = `Added ${d.added}${d.skipped ? `, ${d.skipped} skipped for want of room on your plan` : ''}.`;
    setTimeout(() => render(), 1200);
  }
});

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

const FILTERS = {
  gscFilter: ['gscList', 'gscFilterCount'],
  gscSiteFilter: ['gscSiteList', 'gscSiteCount'],
  ga4Filter: ['ga4List', 'ga4FilterCount'],
  qFilter: ['qList', 'qFilterCount'],
  promptFilter: ['promptList', 'promptFilterCount']
};

document.addEventListener('input', (e) => {
  const target = FILTERS[e.target.id];
  if (target) { filterRows(target[0], e.target.value, target[1]); return; }
});

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

  if (t.id === 'q_topic') {
    const topic = $('q_text').value.trim();
    if (topic.length < 3) return setupErr('Give it a topic, such as retirement planning.');

    t.disabled = true;
    t.textContent = 'Thinking';
    const d = await api(`/api/projects/${state.projectId}/prompts/from-topic`, { method: 'POST', body: { topic } });
    t.disabled = false;
    t.textContent = 'Generate from topic';

    if (d?.error) return setupErr(d.error);
    setupErr('');

    // Shown for approval. A generated question is a suggestion until someone
    // who knows the business agrees with it.
    $('qTopicPanel').innerHTML = `<div class="pq-preview">
      <p class="hint" style="margin:0 0 10px">
        Questions a buyer might ask about <b>${esc(d.topic)}</b>. Pick the ones worth tracking; each one is an answer
        check on every cycle.
      </p>
      ${d.questions
        .map(
          (q, i) => `<label class="pq${q.duplicate ? ' is-dupe' : ''}">
            <input type="checkbox" data-topicq="${i}" ${q.duplicate ? 'disabled' : 'checked'} />
            <span>${esc(q.text)}${q.duplicate ? '<i class="pcp-brand">already tracked</i>' : ''}</span>
          </label>`
        )
        .join('')}
      <div class="inline-form" style="margin-top:12px">
        <button class="btn" id="q_topic_add">Add selected</button>
        <button class="ghost" id="q_topic_cancel">Cancel</button>
      </div>
    </div>`;
    window.__topicQuestions = d.questions;
    return;
  }

  if (t.id === 'q_topic_cancel') {
    $('qTopicPanel').innerHTML = '';
    return;
  }

  if (t.id === 'q_topic_add') {
    const chosen = [...document.querySelectorAll('[data-topicq]:checked')].map(
      (c) => window.__topicQuestions[Number(c.dataset.topicq)].text
    );
    if (!chosen.length) return setupErr('Pick at least one.');
    t.disabled = true;
    t.textContent = 'Adding';
    for (const text of chosen) {
      await fetch(`/api/projects/${state.projectId}/prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
    }
    await render();
    return;
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
    state.projectId = null;
    const url = new URL(location.href);
    url.searchParams.delete('site');
    history.replaceState({}, '', url);
    await loadProjectList();
    await refreshUsagePill();
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

/* ---------- feedback ---------- */

let feedbackKind = 'bug';

$('feedbackBtn').addEventListener('click', () => {
  $('fbError').textContent = '';
  $('feedbackDialog').showModal();
  $('fbMessage').focus();
});

$('fbCancel').addEventListener('click', () => $('feedbackDialog').close());

document.addEventListener('click', (e) => {
  const k = e.target.closest('.kind');
  if (!k) return;
  feedbackKind = k.dataset.kind;
  document.querySelectorAll('.kind').forEach((b) => b.classList.toggle('is-on', b === k));
});

$('fbSend').addEventListener('click', async () => {
  const message = $('fbMessage').value.trim();
  if (message.length < 4) { $('fbError').textContent = 'Tell us a little more than that.'; return; }

  $('fbSend').disabled = true;
  $('fbSend').textContent = 'Sending';

  try {
    // Attach the context so nobody has to describe where they were.
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: feedbackKind,
        message,
        email: $('fbEmail').value.trim(),
        view: state.view,
        projectId: state.projectId,
        path: location.pathname + location.search,
        viewport: `${window.innerWidth}x${window.innerHeight}`
      })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Could not send that');

    $('feedbackDialog').querySelector('form').innerHTML = `
      <div class="fb-thanks">
        <h2>Thank you</h2>
        <p class="dek" style="margin:0 auto 20px;max-width:40ch">
          Read by a person, not a queue. If you left an email we will come back to you.
        </p>
        <button type="button" id="fbClose">Close</button>
      </div>`;
    setTimeout(() => $('feedbackDialog').close(), 2600);
  } catch (err) {
    $('fbError').textContent = err.message;
    $('fbSend').disabled = false;
    $('fbSend').textContent = 'Send';
  }
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'fbClose') $('feedbackDialog').close();
});

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

/**
 * A banner while an address is unconfirmed.
 *
 * The block happens when a cycle is run, which is the right place, but
 * discovering it only at that moment is a poor first experience.
 */
function showVerifyBar(me) {
  const bar = document.getElementById('verifyBar');
  if (!bar) return;

  if (!me?.signedIn || me.emailVerified !== false) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.innerHTML = `Confirm your email to run cycles. We sent a link to <b>${esc(me.email || 'your address')}</b>.
    <button class="ghost" id="resendVerify">Send it again</button>`;
}

async function refreshUsagePill() {
  const b = await api('/api/billing');
  if (!b) return;
  state.billing = b;
  const pill = $('usagePill');
  pill.hidden = false;
  // An internal account has no sold allowance, so showing one is misleading.
  pill.textContent = b.internal
    ? `${b.plan.name} \u00b7 ${b.usage.calls} checks \u00b7 $${(b.usage.spend || 0).toFixed(2)}`
    : `${b.plan.name} \u00b7 ${b.usage.calls}/${b.usage.limit}`;
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
/**
 * A line chart you can interrogate.
 *
 * Six overlapping lines and a native SVG tooltip is a picture, not an
 * instrument. Series can be switched off, and hovering anywhere reads out
 * every visible value at that date rather than requiring an exact hit on a
 * three-pixel dot.
 */
function lineChart(series, { height = 220, showAxis = true, id = 'chart' } = {}) {
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

  // Handed to the hover readout so it does not have to parse the SVG back.
  const dataForHover = series.map((s) => ({
    label: s.label,
    colour: s.colour,
    own: Boolean(s.own),
    values: Object.fromEntries(s.points.filter((p) => p.value != null).map((p) => [p.date, p.value]))
  }));

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
      return `<g class="seriesline" data-series="${series.indexOf(s)}">
        <path d="${path}" class="line ${s.own ? 'own' : ''}" style="stroke:${s.colour}" />${dots}
      </g>`;
    })
    .join('');

  // A hit area per date, so the pointer never has to find the dot itself.
  const step = (W - pad.l - pad.r) / Math.max(dates.length - 1, 1);
  const zones = dates
    .map(
      (d, i) => `<rect class="hitzone" data-date="${esc(d)}" x="${(x(d) - step / 2).toFixed(1)}" y="${pad.t}"
        width="${step.toFixed(1)}" height="${(H - pad.t - pad.b).toFixed(1)}" fill="transparent" />`
    )
    .join('');

  const marker = `<line class="crosshair" x1="0" y1="${pad.t}" x2="0" y2="${H - pad.b}" style="display:none" />`;

  const toggles = series
    .map(
      (s, i) => `<button class="serieskey is-on" data-series="${i}" data-chart="${id}" style="--k:${s.colour}">
        <span class="swatch"></span>${esc(s.label)}
      </button>`
    )
    .join('');

  window.__charts = window.__charts || {};
  window.__charts[id] = { series: dataForHover, dates };

  return `<div class="chartwrap" data-chart-id="${id}">
    <div class="serieskeys">${toggles}</div>
    <div class="chartbox">
      <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Visibility over time" preserveAspectRatio="xMidYMid meet">
        ${grid}${xLabels}${marker}${lines}${zones}
      </svg>
      <div class="readout" hidden></div>
    </div>
  </div>`;
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
    ${lineChart(series, { id: 'rivals' }) || '<p class="hint">Not enough cycles yet.</p>'}
    ${legend(series)}
    <p class="hint" style="margin-top:12px">Share of answers each brand was named in, cycle by cycle. Hover a point for the exact figure.</p>
  </div>

  <div class="setup-grid">
    <div class="panel">
      <div class="panel-head"><h2>By surface</h2></div>
      ${lineChart(engineSeries, { height: 190, id: 'engines' }) || '<p class="hint">Not enough cycles yet.</p>'}
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

/* ---------- category landscape ---------- */

function barRow(label, value, max, { own = false, suffix = '' } = {}) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return `<div class="sov-row">
    <div class="sov-name ${own ? 'own' : ''}">${esc(label)}${own ? ' (you)' : ''}</div>
    <div class="sov-track"><div class="sov-fill ${own ? 'own' : ''}" style="width:${width}%"></div></div>
    <div class="sov-val">${value.toLocaleString()}${suffix}</div>
  </div>`;
}

async function viewLandscape() {
  const platform = state.landscapePlatform || 'google';
  const d = await api(`/api/projects/${state.projectId}/landscape?platform=${platform}`);
  if (!d) return '';
  if (d.error) return `<div class="empty"><h2>Could not read the landscape</h2><p>${esc(d.error)}</p></div>`;

  const brand = (d.brand || '').toLowerCase();
  const ownDomain = (d.ownDomain || '').replace(/^www\./, '');

  const market = state.overview?.project?.market || 'AE';
  const toggle = `<div class="switch-int" role="group" aria-label="Platform">
      <button class="int-b ${platform === 'google' ? 'is-on' : ''}" data-landscape="google">Google AI Overview</button>
      <button class="int-b ${platform === 'chat_gpt' ? 'is-on' : ''}" data-landscape="chat_gpt"
        title="${market === 'US' ? 'Covers the United States' : 'This dataset covers the United States only'}">
        ChatGPT${market === 'US' ? '' : ' <em>US only</em>'}
      </button>
    </div>`;

  const panel = (title, rows, render, note, err) => `
    <div class="panel">
      <div class="panel-head"><h2>${title}</h2></div>
      ${err ? `<p class="error">${esc(err)}</p>` : rows.length ? render : '<p class="hint">Nothing returned for this category.</p>'}
      ${note ? `<p class="hint" style="margin-top:12px">${note}</p>` : ''}
    </div>`;

  const brandsMax = Math.max(...d.brands.map((r) => r.mentions), 1);
  const domainsMax = Math.max(...d.domains.map((r) => r.mentions), 1);

  return `
  <div class="landscape-head">
    ${toggle}
    <span class="spacer"></span>
    <span class="tag">${esc((d.keywordsUsed || []).join(' | '))}</span>
    <span class="tag">${d.totalCount ? d.totalCount.toLocaleString() + ' domains in corpus' : ''}</span>
    <span class="tag">${d.cached ? 'cached' : '$' + (d.cost || 0).toFixed(2)}</span>
  </div>

  ${d.coverageWarning ? `<p class="report-warn">${esc(d.coverageWarning)}</p>` : ''}

  <p class="dek" style="margin:16px 0 20px;max-width:70ch">
    This reads what AI answers already say across your whole category, from a harvested corpus rather than by asking
    your tracked questions. It costs a fraction of a cycle and shows you brands you never thought to track.
  </p>

  ${panel('Who owns the conversation',
    d.brands,
    d.brands.slice(0, 15).map((r) => barRow(`${r.name}  ${r.share}%`, r.mentions, brandsMax,
      { own: r.domain === ownDomain })).join(''),
    `Brands named most often across this category, measured by how often their own domain is cited.
     Anyone above you here is worth adding as a tracked competitor.`,
    d.errors?.[0])}

  ${panel('Every source, including the platforms',
    d.domains,
    d.domains.slice(0, 15).map((r) => barRow(r.domain, r.mentions, domainsMax, { own: r.domain === ownDomain })).join(''),
    `The same list before platforms such as YouTube and Wikipedia are filtered out. A platform high on this list is
     itself a channel worth being present on.`)}`;
}

boot();
