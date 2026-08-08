/* A private task list for one assignee, opened from an email link. */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const token = new URLSearchParams(location.search).get('t') || '';
let DATA = null;

function dueLabel(t) {
  if (!t.due_date) return '';
  const d = new Date(t.due_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  const when = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (t.status === 'done') return `<span class="tag">was due ${when}</span>`;
  if (days < 0) return `<span class="tag overdue">${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue</span>`;
  if (days === 0) return '<span class="tag soon">due today</span>';
  if (days <= 3) return `<span class="tag soon">due in ${days} day${days === 1 ? '' : 's'}</span>`;
  return `<span class="tag">due ${when}</span>`;
}

function card(t) {
  const ev = t.evidence || {};
  const next = { open: ['doing', 'Start'], doing: ['done', 'Mark done'], done: ['open', 'Reopen'] }[t.status];

  return `<article class="rec ${t.status}" data-id="${t.id}">
    <div class="rec-top">
      <div class="rec-title">${esc(t.title)}</div>
      <div class="rec-pri">${esc(t.site)}</div>
    </div>
    <div class="task-meta">
      <span class="status-chip ${t.status}">${{ open: 'To do', doing: 'In progress', done: 'Done' }[t.status] || t.status}</span>
      ${dueLabel(t)}
    </div>
    <p class="rec-action">${esc(t.action)}</p>
    ${t.notes ? `<div class="notes"><span class="k">Notes</span>${esc(t.notes)}</div>` : ''}
    ${ev.questions?.length ? `<details class="qlist">
      <summary>The ${ev.questions.length} question${ev.questions.length === 1 ? '' : 's'} behind this</summary>
      <div class="qlist-body">
        ${ev.questions
          .map((q) => {
            const text = typeof q === 'string' ? q : q.question;
            const lead = typeof q === 'string' ? '' : q.hits ? `${q.hits}\u00d7` : q.competitor_rate !== undefined ? `${q.competitor_rate}%` : '';
            const url = typeof q === 'string' ? null : q.url;
            return `<div class="qrow"><span class="qhits">${esc(lead)}</span><span class="qtext">${esc(text)}</span>${
              url ? `<a class="qlink" href="${esc(url)}" target="_blank" rel="noopener">open</a>` : ''
            }</div>`;
          })
          .join('')}
      </div>
    </details>` : ''}
    <div class="rec-foot">
      ${t.target_url ? `<a class="tag" href="${esc(t.target_url)}" target="_blank" rel="noopener">open the page</a>` : ''}
      <span style="flex:1"></span>
      ${next ? `<button class="ghost" data-set="${next[0]}" data-id="${t.id}">${next[1]}</button>` : ''}
    </div>
  </article>`;
}

function render() {
  const open = DATA.tasks.filter((t) => t.status !== 'done' && t.status !== 'dismissed');
  const done = DATA.tasks.filter((t) => t.status === 'done');
  const overdue = open.filter((t) => t.due_date && new Date(t.due_date) < new Date().setHours(0, 0, 0, 0));

  $('who').innerHTML =
    `${esc(DATA.assignee)} &middot; ${open.length} open${overdue.length ? `, <b class="over">${overdue.length} overdue</b>` : ''}` +
    `${done.length ? ` &middot; ${done.length} done` : ''}`;

  $('list').innerHTML = open.length || done.length
    ? open.map(card).join('') +
      (done.length
        ? `<details class="donelist"><summary>${done.length} finished</summary>${done.map(card).join('')}</details>`
        : '')
    : '<div class="empty"><h2>Nothing assigned to you</h2><p>When someone assigns you a task it will appear here.</p></div>';
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-set]');
  if (!b) return;
  b.disabled = true;
  const res = await fetch(`/api/tasks/${b.dataset.id}?t=${encodeURIComponent(token)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: b.dataset.set })
  });
  if (!res.ok) { b.disabled = false; return; }
  const updated = await res.json();
  const t = DATA.tasks.find((x) => x.id === updated.id);
  if (t) t.status = updated.status;
  render();
});

fetch(`/api/tasks?t=${encodeURIComponent(token)}`)
  .then((r) => r.json())
  .then((d) => {
    if (d.error) throw new Error(d.error);
    DATA = d;
    document.title = `Tasks for ${d.assignee} | Cited`;
    render();
  })
  .catch((err) => {
    $('list').innerHTML = `<div class="empty"><h2>Could not open that list</h2><p>${esc(err.message)}</p></div>`;
  });
