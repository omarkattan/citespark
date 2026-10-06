/* Cited: public demo. Three steps, no account. */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

// Where the visitor came from, so the index page can be judged as a funnel.
const demo = {
  site: null,
  results: new Map(),
  running: false,
  source: new URLSearchParams(location.search).get('from') ||
    (location.hash.includes('from=uae') ? 'uae' : null) ||
    (document.referrer.includes('/uae') ? 'uae' : 'landing')
};

function note(msg, kind = '') {
  const el = $('demoNote');
  el.textContent = msg;
  el.className = `demo-note ${kind}`;
  if(kind === 'limit'){
    const link=document.createElement('a');link.href='/login?demo=1&signup=1';link.className='btn';link.textContent='Create a free account';el.append(document.createElement('br'),link);
  }
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
    if (!res.ok) {const error=new Error(d.error || 'Could not read that site');error.limited=res.status===429;throw error;}

    if(demo.site?.domain !== d.domain){
      demo.results.clear(); $('demoResult').hidden = true;
      const saved=window.CitedDemoHandoff?.read();
      if(saved?.site?.domain===d.domain)for(const r of saved.results||[]){
        if(typeof r.question==='string'&&Number.isInteger(r.runs)&&r.runs>0&&Number.isInteger(r.mentions)&&r.mentions>=0&&r.mentions<=r.runs)demo.results.set(r.question,r);
      }
    }
    demo.site = d;
    window.CitedDemoHandoff?.save(d,demo.results.values());
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
    note(err.message, err.limited?'limit':'warn');
  } finally {
    $('demoScan').disabled = false;
    $('demoScan').textContent = 'Read my site';
  }
}

/* ---------- step two ---------- */

async function run(index) {
  if(demo.running) return;
  const q = demo.site.questions[index];
  demo.running = true;
  $('demoStep2').hidden = true;
  $('demoStep3').hidden = false;
  $('demoWorking').textContent = 'Checking this question. Answers can take a moment.';

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
    if (!res.ok) {const error=new Error(d.error || 'That did not work');error.limited=res.status===429;throw error;}
    showResult(d);
  } catch (err) {
    $('demoStep3').hidden = true;
    $('demoStep2').hidden = false;
    note(err.message, err.limited?'limit':'warn');
    $('demoStep1').hidden = false;
  } finally {
    demo.running = false;
  }
}

/* ---------- step three ---------- */

function verdict(d) {
  if(d.status==='inconclusive')return {head:'Result inconclusive',body:esc(d.qualityWarning||'The answer sample needs review. No visibility score is shown.')};
  if(!Number.isInteger(d.runs)||d.runs<1||!Number.isInteger(d.mentions)||d.mentions<0||d.mentions>d.runs)
    return {head:'Result unavailable',body:'No usable naming result is available. This is not zero visibility.'};
  return {
    head: `Named in ${d.mentions} of ${d.runs} answers`,
    body: d.mentions === 0
      ? `${esc(d.brandName)} was not named in this sample. Check whether the answer recommends any providers. Advice-only answers may name none, so absence alone is not a competitive loss.`
      : d.mentions === d.runs
        ? `${esc(d.brandName)} appeared in every answer in this sample. Test another buying question to see where that presence holds.`
        : `${esc(d.brandName)} appeared in some answers in this sample. Review the evidence before deciding what to change.`
  };
}

function comparisonHtml(collectionProfile) {
  const rows=[...demo.results.values()].filter(r=>collectionProfile&&r.collectionProfile===collectionProfile&&r.status!=='inconclusive'&&Number.isInteger(r.mentions)&&r.runs>0);
  if(rows.length<2)return '';
  const varied=new Set(rows.map(r=>r.mentions/r.runs)).size>1;
  return `<section class="demo-comparison"><h3>${varied?'Your presence varies by question':'Your tested questions'}</h3><p>Latest saved result per question using the same collection settings. These are separate samples, not a trend or an overall visibility score.</p>${rows.map(r=>`<div class="demo-read-line"><span class="k">${esc(r.question)}</span><span class="v">${r.mentions} / ${r.runs} answers · ${esc(r.engine||'Engine not recorded')}${r.cached?' · cached':''}</span></div>`).join('')}</section>`;
}

function answerEvidenceHtml(d) {
  const answers=Array.isArray(d.answerEvidence)?d.answerEvidence:[];
  if(!answers.length)return `<p class="demo-label">One saved answer excerpt</p><div class="demo-excerpt">${highlight(d.excerpt||'',d.brandName)}</div><p class="demo-hint">This older result retained only an excerpt. The full set of answers cannot be reviewed here.</p>`;
  return `<section aria-label="Answers behind this result"><p class="demo-label">Review the ${answers.length} saved answers</p><p class="demo-hint">Text received by Cited, before shortening for display. A short or incomplete answer may not support a conclusion about competitors.</p>${answers.map((a,i)=>`<details><summary>Answer ${i+1} · ${a.qualityReview?'Needs review':a.mentioned===true?'Brand named':a.mentioned===false?'Brand not named':'Naming unavailable'}</summary><div class="demo-excerpt" style="white-space:pre-wrap;overflow-wrap:anywhere">${highlight(a.text||'',d.brandName)}</div></details>`).join('')}</section>`;
}

function showResult(d) {
  const v = verdict(d);
  const known=Number.isInteger(d.runs)&&d.runs>0&&Number.isInteger(d.mentions)&&d.mentions>=0&&d.mentions<=d.runs;
  const pct = known ? Math.round(d.mentions/d.runs*100) : null;
  if(known||d.status==='inconclusive')demo.results.set(d.question,{...d});
  const retained=window.CitedDemoHandoff?.save(demo.site||d,demo.results.values());
  const strip = (d.strip||[]).map((hit) => `<span class="tick ${hit ? 'hit' : ''}"></span>`).join('');

  $('demoResult').innerHTML = `
    <p class="demo-label">Question tested · ${esc(d.engine||'Engine not recorded')}</p>
    <h3>${esc(d.question)}</h3>
    <p class="demo-hint">${d.cached?'Previously collected result, reused without a new check.':'New answer sample.'} ${d.collectedAt?`Collected ${esc(d.collectedAt)}.`:''} ${d.failed>0?`${d.failed} failed attempts excluded from the naming denominator.`:''}</p>
    <div class="demo-verdict ${pct === 0 ? 'bad' : pct === 100 ? 'good' : 'mixed'}">
      <div class="demo-score">
        <div class="demo-pct" style="font-size:1.6rem">${known?`${d.mentions} / ${d.runs}`:'—'}</div><small>${known?`${pct}% named in this sample`:d.status==='inconclusive'?'Score withheld':'Not measured'}</small>
        <div class="ticks">${strip}</div>
      </div>
      <div class="demo-verdict-text">
        <h3>${v.head}</h3>
        <p>${v.body}</p>
      </div>
    </div>

    <p class="demo-hint">API-generated answer sample${d.requestedModel?` · ${esc(d.requestedModel)}`:''}. These answers can contain errors. Citations identify sources the engine referenced, not independently verified claims.</p>
    <p class="demo-hint">One question on one engine. Naming is not the same as citing your website. This sample does not measure overall market visibility.</p>
    ${comparisonHtml(d.collectionProfile)}
    ${answerEvidenceHtml(d)}

    ${d.sources.length ? `<p class="demo-label">Selected sources cited in the sampled answers</p>
      <div class="chips">${d.sources.map((s) => `<span class="chip ${s.domain === d.domain ? 'own' : ''}">${esc(s.domain)}${s.domain === d.domain ? ' (you)' : ''}</span>`).join('')}</div>` : ''}

    ${d.fanOut.length ? `<p class="demo-label">Reported search queries</p>
      <div class="chips">${d.fanOut.map((q) => `<span class="chip dashed">${esc(q)}</span>`).join('')}</div>
      <p class="demo-hint">These reported queries are context, not proof of how the engine chose its answer.</p>` : ''}

    <div class="demo-cta">
      <p><b>Build a clearer picture across your buyer questions.</b> Create an account to set up a project, inspect supporting evidence and review next steps. Available checks and engines depend on your plan.</p>
      <p class="demo-hint">${retained?'Your demo notes are kept in this browser for 24 hours so you can refer to them during setup. They are separate from project measurements.':'This browser could not retain your demo. You can still create an account.'}</p><div class="demo-cta-row">
        <a class="btn" href="/login?demo=1&signup=1">${retained?'Continue with my demo':'Create a free account'}</a>
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
    $('demoStep2').hidden = false;
    $('demoStep2').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});
