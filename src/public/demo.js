/* Cited: public demo. Three steps, no account. */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

// Where the visitor came from, so the index page can be judged as a funnel.
const demo = {
  site: null,
  source: new URLSearchParams(location.search).get('from') ||
    (location.hash.includes('from=uae') ? 'uae' : null) ||
    (document.referrer.includes('/uae') ? 'uae' : 'landing')
};

function note(msg, kind = '') {
  const el = $('demoNote');
  el.textContent = msg;
  el.className = `demo-note ${kind}`;
}

function highlight(text, brand) {
  const safe = esc(text);
  if (!brand) return safe;
  const re = new RegExp(`(${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

/* ---------- step one ---------- */

async function scan() {
  const domain = $('demoDomain').value.trim();
  if (!domain) return note('Enter a domain first.', 'warn');

  $('demoScan').disabled = true;
  $('demoScan').textContent = 'Reading';
  note('Reading the homepage and working out what you do');

  try {
    const res = await fetch('/api/demo/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Could not read that site');

    demo.site = d;
    $('demoRead').innerHTML = `
      <div class="demo-read-line"><span class="k">Brand</span><span class="v">${esc(d.brandName)}</span></div>
      <div class="demo-read-line"><span class="k">What you do</span><span class="v">${esc(d.category)}</span></div>
      <div class="demo-read-line"><span class="k">Who buys</span><span class="v">${esc(d.qualifier)}</span></div>`;

    $('demoQuestions').innerHTML = d.questions
      .map(
        (q, i) => `<button class="demo-q" data-q="${i}">
          <span class="demo-q-text">${esc(q.text)}</span>
          ${q.why ? `<span class="demo-q-why">${esc(q.why)}</span>` : ''}
        </button>`
      )
      .join('');

    $('demoStep1').hidden = true;
    $('demoStep2').hidden = false;
  } catch (err) {
    note(err.message, 'warn');
  } finally {
    $('demoScan').disabled = false;
    $('demoScan').textContent = 'Read my site';
  }
}

/* ---------- step two ---------- */

const WORKING = [
  'Asking ChatGPT',
  'Asking again, because answers vary',
  'Once more for a trustworthy number',
  'Reading what came back'
];

async function run(index) {
  const q = demo.site.questions[index];
  $('demoStep2').hidden = true;
  $('demoStep3').hidden = false;

  let i = 0;
  const cycle = setInterval(() => {
    i = Math.min(i + 1, WORKING.length - 1);
    $('demoWorking').textContent = WORKING[i];
  }, 4000);

  try {
    const res = await fetch('/api/demo/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: demo.site.domain,
        brandName: demo.site.brandName,
        market: demo.site.market,
        question: q.text,
        token: q.token,
        source: demo.source
      })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'That did not work');
    showResult(d);
  } catch (err) {
    $('demoStep3').hidden = true;
    $('demoStep2').hidden = false;
    note(err.message, 'warn');
    $('demoStep1').hidden = false;
  } finally {
    clearInterval(cycle);
  }
}

/* ---------- step three ---------- */

function verdict(d) {
  const pct = Math.round(d.rate * 100);
  if (pct === 0) {
    return {
      head: 'Not named once.',
      body: `ChatGPT answered this question ${d.runs} times and did not mention ${esc(d.brandName)} in any of them. It named ${d.others.length ? esc(d.others.slice(0, 3).join(', ')) : 'other businesses'} instead.`
    };
  }
  if (pct === 100) {
    return {
      head: `Named every time${d.avgOrdinal ? `, position ${d.avgOrdinal.toFixed(1)}` : ''}.`,
      body: `${esc(d.brandName)} came back in all ${d.runs} answers. ${d.avgOrdinal > 2 ? 'Worth pushing higher up the list, since few people read past the first two.' : 'That is a strong position to defend.'}`
    };
  }
  return {
    head: `Named in ${d.mentions} of ${d.runs} answers.`,
    body: `Ask the same question again and you may not appear at all. That inconsistency is invisible to every rank tracker, and it is the number worth improving.`
  };
}

function showResult(d) {
  const v = verdict(d);
  const pct = Math.round(d.rate * 100);
  const strip = d.strip.map((hit) => `<span class="tick ${hit ? 'hit' : ''}"></span>`).join('');

  $('demoResult').innerHTML = `
    <div class="demo-verdict ${pct === 0 ? 'bad' : pct === 100 ? 'good' : 'mixed'}">
      <div class="demo-score">
        <div class="demo-pct">${pct}%</div>
        <div class="ticks">${strip}</div>
      </div>
      <div class="demo-verdict-text">
        <h3>${v.head}</h3>
        <p>${v.body}</p>
      </div>
    </div>

    <p class="demo-label">What it said</p>
    <div class="demo-excerpt">${highlight(d.excerpt, d.brandName)}</div>

    ${d.others.length ? `<p class="demo-label">Who it named instead</p>
      <div class="chips">${d.others.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</div>` : ''}

    ${d.sources.length ? `<p class="demo-label">What it read to answer</p>
      <div class="chips">${d.sources.map((s) => `<span class="chip ${s.domain === d.domain ? 'own' : ''}">${esc(s.domain)}${s.domain === d.domain ? ' (you)' : ''}</span>`).join('')}</div>` : ''}

    ${d.fanOut.length ? `<p class="demo-label">The search it ran first</p>
      <div class="chips">${d.fanOut.map((q) => `<span class="chip dashed">${esc(q)}</span>`).join('')}</div>
      <p class="demo-hint">That is an ordinary Google query. If you do not rank for it, you were never a candidate for the answer.</p>` : ''}

    <div class="demo-cta">
      <p><b>That was one question, on one engine, three times.</b> Cited tracks twenty-five of them across six AI surfaces every week, and tells you what to change.</p>
      <div class="demo-cta-row">
        <a class="btn" href="/login">Create a free account</a>
        <button class="btn ghost" id="demoAgain">Try another question</button>
      </div>
    </div>`;

  $('demoStep3').hidden = true;
  $('demoResult').hidden = false;
  $('demoResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- wiring ---------- */

$('demoScan').addEventListener('click', scan);
$('demoDomain').addEventListener('keydown', (e) => { if (e.key === 'Enter') scan(); });

document.addEventListener('click', (e) => {
  const q = e.target.closest('[data-q]');
  if (q) run(Number(q.dataset.q));

  if (e.target.id === 'demoAgain') {
    $('demoResult').hidden = true;
    $('demoStep2').hidden = false;
    $('demoStep2').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});
