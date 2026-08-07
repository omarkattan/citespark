/* MENA AI Visibility Index: each company measured in its home market. */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

let INDEX = null;

const KIND_LABEL = {
  candidate: 'Possible companies, not on our list',
  portal: 'Portals and marketplaces',
  news: 'News and media',
  platform: 'Platforms',
  government: 'Government and official',
  reference: 'Reference'
};
const KIND_ORDER = ['candidate', 'portal', 'news', 'platform', 'government', 'reference'];

function label(b) {
  if (b.measurable === false || b.status === 'unmeasurable')
    return '<span class="val muted" title="This market is not in the dataset, so the company could not be measured">not measurable</span>';
  if (b.noData) return '<span class="val muted" title="No data returned for this market">no data</span>';
  if (b.status === 'named-and-cited') return '<span class="val good">named &middot; cited</span>';
  if (b.status === 'named-not-cited') return '<span class="val warn" title="Recommended in the answer, but the citation went elsewhere">named, not cited</span>';
  if (b.status === 'cited-not-named') return '<span class="val">cited only</span>';
  return '<span class="val bad">neither</span>';
}

function sectorCard(s) {
  const missing = new Set(INDEX.coverage?.missingCodes || []);
  const all = (s.brands || []).map((b) => ({ ...b, noData: missing.has(b.country) }));
  const max = Math.max(...all.map((b) => b.named), 1);
  const absent = all.filter((b) => b.status === 'absent' && !b.noData);
  const notCited = all.filter((b) => b.status === 'named-not-cited');

  const bars = all.length
    ? all
        .map(
          (b, i) => `<div class="brand-row ${b.named ? '' : 'silent'}">
            <span class="rank">${b.named ? i + 1 : '&mdash;'}</span>
            <span class="brand">${esc(b.name)}<i class="cc" title="Measured in ${esc(b.countryName)}">${esc(b.countryName)}</i></span>
            <span class="track"><span class="fill" style="width:${b.named ? Math.max(3, (b.named / max) * 100) : 0}%"></span></span>
            ${label(b)}
          </div>`
        )
        .join('')
    : '<p class="index-empty">No data returned for this category yet.</p>';

  const grouped = new Map();
  for (const o of s.others || []) {
    if (!grouped.has(o.kind)) grouped.set(o.kind, []);
    grouped.get(o.kind).push(o);
  }
  const sources = KIND_ORDER.filter((k) => grouped.has(k))
    .map(
      (k) => `<div class="others-group ${k === 'candidate' ? 'is-candidate' : ''}">
        <span class="k">${esc(KIND_LABEL[k])}</span>
        ${grouped.get(k).map((o) => `<span class="chip" title="${o.mentions.toLocaleString()} mentions in ${esc(o.countryName)}">${esc(o.domain)}</span>`).join('')}
      </div>`
    )
    .join('');

  const haystack = `${s.name} ${s.blurb} ${all.map((b) => `${b.name} ${b.countryName}`).join(' ')} ${(s.others || []).map((o) => o.domain).join(' ')}`.toLowerCase();

  return `<article class="sector" data-filter-text="${esc(haystack)}" id="${esc(s.slug)}">
    <div class="sector-head">
      <h3>${esc(s.name)}</h3>
      <span class="spacer"></span>
      <span class="tag">${all.filter((b) => b.named).length} of ${all.filter((b) => b.measurable !== false && !b.noData).length} measured</span>
    </div>
    <p class="sector-blurb">${esc(s.blurb)}</p>
    ${bars}
    ${absent.length ? `<p class="sector-note">${absent.length} ${absent.length === 1 ? 'is' : 'are'} neither named nor cited in ${absent.length === 1 ? 'its' : 'their'} own market.</p>` : ''}
    ${all.some((b) => b.measurable === false || b.noData)
      ? `<p class="sector-note muted">${all.filter((b) => b.measurable === false || b.noData).length} could not be measured: ${[...new Set(all.filter((b) => b.measurable === false || b.noData).map((b) => b.countryName))].join(', ')} ${[...new Set(all.filter((b) => b.measurable === false || b.noData).map((b) => b.countryName))].length === 1 ? 'is' : 'are'} not in the dataset.</p>`
      : ''}
    ${notCited.length ? `<p class="sector-note amber">${notCited.length} ${notCited.length === 1 ? 'is' : 'are'} recommended in the answer but not cited, so another site takes the click.</p>` : ''}

    <div class="sector-cta">
      <span>Is your company here, or should it be?</span>
      <a class="btn ghost" href="/#try?from=mena&amp;sector=${esc(s.slug)}">Check your own domain free</a>
    </div>

    ${sources ? `<details class="others">
      <summary>What else AI cited here <span>${(s.others || []).length}</span></summary>
      <p class="others-intro">Not companies competing in this sector, but the sites AI read to answer. Each is from the market shown.</p>
      ${sources}
    </details>` : ''}

    <div class="sector-foot"><span class="q">"${esc(s.keyword)}", asked in ${(s.countries || []).length} market${(s.countries || []).length === 1 ? '' : 's'}</span></div>
  </article>`;
}

function schema(index) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'MENA AI Visibility Index',
    description:
      'How often leading Arab companies are named in Google AI Overview answers about their sector, each measured in its home market.',
    url: 'https://cited.ae/mena',
    dateModified: index.updatedAt,
    spatialCoverage: index.countries.map((c) => ({ '@type': 'Place', name: c.name })),
    creator: { '@type': 'Organization', name: 'Sandstorm Digital', url: 'https://sandstormdigital.com' },
    hasPart: index.sectors.map((s) => ({
      '@type': 'ItemList',
      name: `${s.name} in MENA, by AI visibility`,
      numberOfItems: (s.brands || []).filter((b) => b.named).length,
      itemListElement: (s.brands || [])
        .filter((b) => b.named)
        .slice(0, 10)
        .map((b, i) => ({ '@type': 'ListItem', position: i + 1, name: b.name }))
    }))
  };
}

function render() {
  if (!INDEX) return;
  const t = INDEX.totals;

  $('indexMeta').innerHTML = `
    <span class="tag">${t.sectors} sectors</span>
    <span class="tag">${t.companies} companies</span>
    <span class="tag">${INDEX.countries.length} markets</span>
    ${t.absent ? `<span class="tag">${t.absent} named by nobody</span>` : ''}
    ${INDEX.coverage?.missing?.length ? `<span class="tag warn">${INDEX.coverage.missing.length} markets unavailable</span>` : ''}
    <span class="tag">Google AI Overview</span>
    ${INDEX.updatedAt ? `<span class="tag">updated ${new Date(INDEX.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</span>` : ''}`;

  $('sectors').innerHTML = INDEX.sectors.length
    ? INDEX.sectors.map(sectorCard).join('') + '<p class="index-empty" data-filter-empty hidden>Nothing matches that.</p>'
    : '<p class="index-empty">The index has not been built yet.</p>';

  const max = Math.max(...INDEX.countries.filter((c) => !c.noData).map((c) => c.rate), 1);
  $('countryTable').innerHTML =
    INDEX.countries
      .map(
        (c) => `<div class="cross-row ${c.noData ? 'nodata' : ''}">
        <span class="domain">${esc(c.name)}</span>
        <span class="track"><span class="fill" style="width:${c.noData ? 0 : (c.rate / max) * 100}%"></span></span>
        <span class="val">${c.notInCorpus ? 'not in dataset' : c.noData ? 'no data' : `${c.rate}% of ${c.total}`}</span>
      </div>`
      )
      .join('') +
    (INDEX.coverage?.missing?.length
      ? `<p class="note" style="margin-top:18px">
          ${INDEX.coverage.missing.map(esc).join(', ')} ${INDEX.coverage.missing.length === 1 ? 'is' : 'are'} not in the dataset this index reads,
          so their companies could not be measured. That is a gap in the data, not a finding about those companies,
          and reporting it as a zero would be wrong. We will add them if and when coverage arrives.
        </p>`
      : '');

  $('indexSchema').textContent = JSON.stringify(schema(INDEX));
}

$('sectorFilter').addEventListener('input', (e) => {
  const needle = e.target.value.trim().toLowerCase();
  let shown = 0;
  for (const card of document.querySelectorAll('.sector')) {
    const hit = !needle || card.dataset.filterText.includes(needle);
    card.hidden = !hit;
    if (hit) shown++;
  }
  const empty = document.querySelector('[data-filter-empty]');
  if (empty) empty.hidden = shown > 0;
  $('sectorCount').textContent = needle ? `${shown} of ${INDEX.sectors.length}` : '';
});

$('year').textContent = new Date().getFullYear();

fetch(`/api/public/mena?v=${Date.now()}`)
  .then((r) => r.json())
  .then((d) => {
    INDEX = d;
    render();
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' });
  })
  .catch(() => {
    $('sectors').innerHTML = '<p class="index-empty">The index could not be loaded. Try again shortly.</p>';
  });
