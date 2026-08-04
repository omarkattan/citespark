/* UAE AI Visibility Index: renders from a stored snapshot, no live calls. */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

let INDEX = null;

function sectorCard(s) {
  const max = Math.max(...(s.brands || []).map((b) => b.mentions), 1);
  const rows = (s.brands || []).slice(0, 8);

  const bars = rows.length
    ? rows
        .map(
          (b, i) => `<div class="brand-row">
            <span class="rank">${i + 1}</span>
            <span class="brand">${esc(b.name)}</span>
            <span class="track"><span class="fill" style="width:${Math.max(3, (b.mentions / max) * 100)}%"></span></span>
            <span class="val">${b.mentions.toLocaleString()}</span>
          </div>`
        )
        .join('')
    : `<p class="index-empty">No brands returned for this category yet.</p>`;

  const sources = (s.domains || []).slice(0, 4);
  const haystack = `${s.name} ${s.blurb} ${(s.brands || []).map((b) => b.name).join(' ')} ${(s.domains || []).map((d) => d.domain).join(' ')}`.toLowerCase();

  return `<article class="sector" data-filter-text="${esc(haystack)}" id="${esc(s.slug)}">
    <div class="sector-head">
      <h3>${esc(s.name)}</h3>
      <span class="spacer"></span>
      <span class="tag">${(s.brands || []).length} brands</span>
    </div>
    <p class="sector-blurb">${esc(s.blurb)}</p>
    ${bars}
    ${sources.length ? `<div class="sector-sources">
      <span class="k">Most cited sources</span>
      ${sources.map((d) => `<span class="chip">${esc(d.domain)}</span>`).join('')}
    </div>` : ''}
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
      itemListElement: (s.brands || []).slice(0, 10).map((b, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: b.name
      }))
    }))
  };
}

function render() {
  if (!INDEX) return;

  $('indexMeta').innerHTML = `
    <span class="tag">${INDEX.totals.sectors} sectors</span>
    <span class="tag">${INDEX.totals.brands} brands ranked</span>
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
