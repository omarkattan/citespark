/* Property developers deep-dive. Renders from a stored study, no live calls. */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const pct = (n) => `${Math.round((n || 0) * 100)}%`;

let D = null;

/* ---------------- cohort tables ---------------- */

function cohortTable(c) {
  if (!c.companies.length) return '';
  const max = Math.max(...c.companies.map((x) => x.composite), 0.01);

  const rows = c.companies
    .map((x, i) => {
      const s = x.spread.mention_rate;
      // A single run has no spread to report, and a wide one is the finding.
      const wide = x.runs > 1 && s.max - s.min >= 0.25;
      const spread =
        x.runs > 1
          ? `<span class="spread ${wide ? 'wide' : ''}" title="${x.runs} runs">${pct(s.min)}&ndash;${pct(s.max)}</span>`
          : '<span class="spread none">one run</span>';

      return `<tr>
        <td class="rank">${i + 1}</td>
        <td class="dev">
          ${esc(x.name)}
          ${x.project_mentions ? `<i title="Mentions of a project name, excluded from the corporate score">+${x.project_mentions} project</i>` : ''}
        </td>
        <td class="comp">
          <span class="bar"><span style="width:${Math.max(2, (x.composite / max) * 100)}%"></span></span>
          <b>${x.composite.toFixed(3)}</b>
        </td>
        <td>${pct(x.mention_rate)}</td>
        <td>${spread}</td>
        <td>${pct(x.top_three_rate)}</td>
        <td>${pct(x.recommendation_rate)}</td>
        <td class="${x.citation_rate < 0.1 ? 'low' : ''}">${pct(x.citation_rate)}</td>
      </tr>`;
    })
    .join('');

  return `<div class="cohort" id="${esc(c.id)}">
    <div class="cohort-head">
      <h3>${esc(c.label)}</h3>
      <span class="tag">${c.companies.length} developers</span>
    </div>
    ${c.description ? `<p class="cohort-note">${esc(c.description)}</p>` : ''}
    <div class="table-scroll">
      <table class="score-table">
        <thead>
          <tr>
            <th></th><th>Developer</th><th>Composite</th>
            <th>Named</th><th title="Lowest and highest across runs">Range</th>
            <th title="Named in the first three developers listed">Top three</th>
            <th title="The answer recommends them, not merely lists them">Recommended</th>
            <th title="Their own website used as a source">Cited</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

/* ---------------- headline ---------------- */

function headline() {
  const all = D.cohorts.flatMap((c) => c.companies);
  if (!all.length) return '';

  const named = all.reduce((a, x) => a + x.mention_rate, 0) / all.length;
  const cited = all.reduce((a, x) => a + x.citation_rate, 0) / all.length;
  const portals = D.sources.filter((s) => !s.isDeveloper).slice(0, 3);
  const topDev = D.sources.find((s) => s.isDeveloper);

  return `<div class="figures">
    <div class="figure">
      <div class="label">Named, on average</div>
      <div class="value">${pct(named)}</div>
      <div class="sub">of answers mention a given developer</div>
    </div>
    <div class="figure">
      <div class="label">Cited, on average</div>
      <div class="value ${cited < 0.15 ? 'down' : ''}">${pct(cited)}</div>
      <div class="sub">of answers use their own site as a source</div>
    </div>
    <div class="figure">
      <div class="label">Most cited source</div>
      <div class="value" style="font-size:24px">${portals[0] ? esc(portals[0].domain) : '-'}</div>
      <div class="sub">${portals[0] ? `in ${pct(portals[0].share)} of answers` : ''}</div>
    </div>
    <div class="figure">
      <div class="label">Best-cited developer</div>
      <div class="value" style="font-size:24px">${topDev ? esc(topDev.domain) : '-'}</div>
      <div class="sub">${topDev ? `in ${pct(topDev.share)} of answers` : 'none cited'}</div>
    </div>
  </div>`;
}

/* ---------------- render ---------------- */

function render() {
  const engines = D.engines
    .map((e) => `<span class="tag${e.thin ? ' warn' : ''}">${esc(e.engine)} ${pct(e.answer_rate)}</span>`)
    .join('');

  $('meta').innerHTML = `
    <span class="tag">${D.developers.length} developers</span>
    <span class="tag">${D.cohorts.filter((c) => c.companies.length).length} cohorts</span>
    ${engines}
    <span class="tag">updated ${new Date(D.cycle).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</span>`;

  $('headline').innerHTML = headline();
  $('cohorts').innerHTML = D.cohorts.map(cohortTable).join('') || '<p class="index-empty">No cohort has data yet.</p>';

  const max = Math.max(...D.sources.map((s) => s.share), 0.01);
  $('sourcesTable').innerHTML = D.sources
    .slice(0, 20)
    .map(
      (s) => `<div class="cross-row ${s.isDeveloper ? 'own' : ''}">
        <span class="domain">${esc(s.domain)}${s.isDeveloper ? '<i>developer</i>' : ''}</span>
        <span class="track"><span class="fill" style="width:${(s.share / max) * 100}%"></span></span>
        <span class="val">${pct(s.share)} of answers</span>
      </div>`
    )
    .join('');

  $('devTable').innerHTML = `<div class="table-scroll"><table class="score-table dev-table">
    <thead><tr>
      <th>Developer</th><th>Cohorts</th><th>Mentions</th><th>Recommended</th>
      <th>Cited</th><th title="Average position among developers named">Avg position</th>
    </tr></thead>
    <tbody>${D.developers
      .map(
        (d) => `<tr data-filter-text="${esc(`${d.name} ${d.domain} ${d.cohorts.join(' ')}`.toLowerCase())}">
          <td class="dev">${esc(d.name)}<span class="dom">${esc(d.domain || '')}</span></td>
          <td class="cohorts">${d.cohorts.map((c) => `<span class="chip">${esc(c.replace(/_/g, ' '))}</span>`).join('')}</td>
          <td>${d.mentions}</td>
          <td>${d.recommendations}</td>
          <td class="${d.citations === 0 ? 'low' : ''}">${d.citations}</td>
          <td>${d.avg_position ?? '-'}</td>
        </tr>`
      )
      .join('')}
      <tr data-filter-empty hidden><td colspan="6" class="index-empty">Nothing matches that.</td></tr>
    </tbody></table></div>`;

  if (D.clients?.length) {
    $('clientNames').textContent = D.clients.join(', ');
  }

  $('studySchema').textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'UAE Property Developers AI Visibility Index',
    description:
      'How often twenty-two UAE property developers are named, recommended and cited in answers from Google AI Mode, Google AI Overview and ChatGPT.',
    url: 'https://cited.ae/uae/property-developers',
    dateModified: D.cycle,
    isPartOf: { '@type': 'Dataset', name: 'UAE AI Visibility Index', url: 'https://cited.ae/uae' },
    spatialCoverage: { '@type': 'Place', name: 'United Arab Emirates' },
    creator: { '@type': 'Organization', name: 'Sandstorm Digital', url: 'https://sandstormdigital.com' },
    variableMeasured: [
      { '@type': 'PropertyValue', name: 'mention rate', description: 'Share of answers naming the developer' },
      { '@type': 'PropertyValue', name: 'citation rate', description: "Share of answers citing the developer's own site" }
    ],
    hasPart: D.cohorts
      .filter((c) => c.companies.length)
      .map((c) => ({
        '@type': 'ItemList',
        name: `${c.label}, by AI visibility`,
        numberOfItems: c.companies.length,
        itemListElement: c.companies.slice(0, 10).map((x, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: x.name
        }))
      }))
  });
}

$('devFilter').addEventListener('input', (e) => {
  const needle = e.target.value.trim().toLowerCase();
  let shown = 0;
  for (const row of document.querySelectorAll('.dev-table tbody tr[data-filter-text]')) {
    const hit = !needle || row.dataset.filterText.includes(needle);
    row.hidden = !hit;
    if (hit) shown++;
  }
  const empty = document.querySelector('[data-filter-empty]');
  if (empty) empty.hidden = shown > 0;
  $('devCount').textContent = needle ? `${shown} of ${D.developers.length}` : '';
});

$('year').textContent = new Date().getFullYear();

fetch(`/api/public/study/property-developers?v=${Date.now()}`)
  .then((r) => r.json())
  .then((d) => {
    if (d.error) throw new Error(d.error);
    D = d;
    render();
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' });
  })
  .catch(() => {
    $('cohorts').innerHTML = '<p class="index-empty">The index could not be loaded. Try again shortly.</p>';
  });
