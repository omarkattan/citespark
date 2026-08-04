/* UAE AI Visibility Index: renders from a stored snapshot, no live calls. */

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

function sectorCard(s) {
  const all = s.brands || [];
  const max = Math.max(...all.map((b) => b.named), 1);
  const absent = all.filter((b) => b.status === 'absent');
  const namedNotCited = all.filter((b) => b.status === 'named-not-cited');
  const others = s.others || [];

  // The ranking contains only this sector's companies, so the card answers
  // the question its heading asks.
  // Two measurements, kept distinct: named in the answer, and cited as a
  // source. A brand can be recommended in prose while the citation, and the
  // click, goes to a portal instead.
  const label = (b) => {
    if (b.status === 'named-and-cited') return `<span class="val good">named &middot; cited</span>`;
    if (b.status === 'named-not-cited') return `<span class="val warn" title="Recommended in the answer, but the citation went elsewhere">named, not cited</span>`;
    if (b.status === 'cited-not-named') return `<span class="val">cited only</span>`;
    return `<span class="val bad">neither</span>`;
  };

  const bars = all.length
    ? all
        .map(
          (b, i) => `<div class="brand-row ${b.named ? '' : 'silent'}">
            <span class="rank">${b.named ? i + 1 : '&mdash;'}</span>
            <span class="brand">${esc(b.name)}</span>
            <span class="track"><span class="fill" style="width:${b.named ? Math.max(3, (b.named / max) * 100) : 0}%"></span></span>
            ${label(b)}
          </div>`
        )
        .join('')
    : `<p class="index-empty">No data returned for this category yet.</p>`;

  // Everything else the data surfaced, grouped by what it actually is.
  const grouped = new Map();
  for (const o of others) {
    if (!grouped.has(o.kind)) grouped.set(o.kind, []);
    grouped.get(o.kind).push(o);
  }
  const sourceBlocks = KIND_ORDER.filter((k) => grouped.has(k))
    .map(
      (k) => `<div class="others-group ${k === 'candidate' ? 'is-candidate' : ''}">
        <span class="k">${esc(KIND_LABEL[k])}</span>
        ${grouped.get(k).map((o) => `<span class="chip" title="${o.mentions.toLocaleString()} mentions">${esc(o.domain)}</span>`).join('')}
      </div>`
    )
    .join('');

  const haystack = `${s.name} ${s.blurb} ${all.map((b) => b.name).join(' ')} ${others.map((o) => o.domain).join(' ')}`.toLowerCase();

  return `<article class="sector" data-filter-text="${esc(haystack)}" id="${esc(s.slug)}">
    <div class="sector-head">
      <h3>${esc(s.name)}</h3>
      <span class="spacer"></span>
      <span class="tag">${all.filter((b) => b.named).length} of ${all.length} named</span>
    </div>
    <p class="sector-blurb">${esc(s.blurb)}</p>
    ${bars}
    ${absent.length ? `<p class="sector-note">${absent.length} of ${all.length} major companies here ${absent.length === 1 ? 'is' : 'are'} neither named in the answers nor cited as a source.</p>` : ''}
    ${namedNotCited.length ? `<p class="sector-note amber">${namedNotCited.length} ${namedNotCited.length === 1 ? 'is' : 'are'} recommended in the answer but not cited, so another site takes the click.</p>` : ''}

    <div class="sector-cta">
      <span>Is your company here, or should it be?</span>
      <a class="btn ghost" href="/#try?from=uae&amp;sector=${esc(s.slug)}">Check your own domain free</a>
    </div>

    ${sourceBlocks ? `<details class="others">
      <summary>What else AI cited here <span>${others.length}</span></summary>
      <p class="others-intro">These are not companies competing in this sector. They are the sites AI read to answer, which is a different and equally useful thing.</p>
      ${sourceBlocks}
    </details>` : ''}

    <div class="sector-foot">
      <span class="q">${(s.keywords || []).map((k) => `"${esc(k)}"`).join(', ')}</span>
    </div>
  </article>`;
}

function schema(index) {
  // The page is about being cited, so it should be legible to the things
  // doing the citing.
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'UAE AI Visibility Index',
    description:
      'How often brands are named in Google AI Overview answers across sixteen sectors in the United Arab Emirates.',
    url: 'https://cited.ae/uae',
    dateModified: index.updatedAt,
    spatialCoverage: { '@type': 'Place', name: 'United Arab Emirates' },
    creator: { '@type': 'Organization', name: 'Sandstorm Digital', url: 'https://sandstormdigital.com' },
    hasPart: index.sectors.map((s) => ({
      '@type': 'ItemList',
      name: `${s.name} in the UAE, by AI visibility`,
      numberOfItems: (s.brands || []).length,
      itemListElement: (s.brands || [])
        .filter((b) => b.named)
        .slice(0, 10)
        .map((b, i) => ({ '@type': 'ListItem', position: i + 1, name: b.name }))
    }))
  };
}

function render() {
  if (!INDEX) return;

  $('indexMeta').innerHTML = `
    <span class="tag">${INDEX.totals.sectors} sectors</span>
    <span class="tag">${INDEX.totals.brands} brands ranked</span>
    ${INDEX.totals.absent ? `<span class="tag">${INDEX.totals.absent} major companies absent entirely</span>` : ''}
    ${INDEX.totals.namedNotCited ? `<span class="tag">${INDEX.totals.namedNotCited} named but not cited</span>` : ''}
    ${INDEX.totals.candidates ? `<span class="tag">${INDEX.totals.candidates} possible companies we did not list</span>` : ''}
    <span class="tag">Google AI Overview</span>
    <span class="tag">United Arab Emirates</span>
    ${INDEX.updatedAt ? `<span class="tag">updated ${new Date(INDEX.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</span>` : ''}`;

  $('sectors').innerHTML = INDEX.sectors.length
    ? INDEX.sectors.map(sectorCard).join('') + '<p class="index-empty" data-filter-empty hidden>Nothing matches that.</p>'
    : '<p class="index-empty">The index has not been built yet.</p>';

  const max = Math.max(...INDEX.crossSector.map((d) => d.sectors), 1);
  $('crossSector').innerHTML = INDEX.crossSector
    .map(
      (d) => `<div class="cross-row">
        <span class="domain">${esc(d.domain)}</span>
        <span class="track"><span class="fill" style="width:${(d.sectors / max) * 100}%"></span></span>
        <span class="val">${d.sectors} sector${d.sectors === 1 ? '' : 's'}</span>
      </div>`
    )
    .join('');

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

fetch(`/api/public/index?v=${Date.now()}`)
  .then((r) => r.json())
  .then((d) => {
    INDEX = d;
    render();
    // Deep link straight to a sector, so each one is shareable.
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' });
  })
  .catch(() => {
    $('sectors').innerHTML = '<p class="index-empty">The index could not be loaded. Try again shortly.</p>';
  });
