import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool, one } from '../src/db/index.js';

/**
 * Render a shareable poster from a sector's real numbers.
 *
 *   npm run poster -- aviation-and-aerospace
 *   npm run poster -- banking --market MENA
 *   npm run poster -- aviation-and-aerospace --title "Which airline does AI pick?"
 *
 * Built as a generator rather than a design file because the numbers change
 * every refresh, and a poster that disagrees with the page it links to is
 * worse than no poster. Everything here comes out of the stored snapshot.
 */
const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--')) || 'aviation-and-aerospace';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const market = flag('market', 'AE');

/**
 * Brand colours, used as a bar tint rather than a logo.
 *
 * A logo is a registered trademark and putting one in a commercial piece that
 * ranks its owner invites a letter. A colour is not protectable in this use
 * and gets most of the recognition.
 */
const BRAND = {
  'emirates.com': '#D71921',
  'etihad.com': '#BD8B13',
  'flydubai.com': '#FF6B00',
  'airarabia.com': '#E4002B',
  'qatarairways.com': '#5C0632',
  'saudia.com': '#00954B',
  'emiratesnbd.com': '#005EB8',
  'bankfab.com': '#0033A0',
  'adcb.com': '#E4002B',
  'dib.ae': '#00A65D',
  'mashreq.com': '#FF5000',
  'emaar.com': '#0B3B5C',
  'damacproperties.com': '#A08344',
  'aldar.com': '#00A9A5',
  'nakheel.com': '#0090D4',
  'arada.com': '#E8443A',
  'noon.com': '#FEEE00',
  'careem.com': '#4BB543',
  'talabat.com': '#FF5A00'
};

const snapshot = await one(
  `SELECT data, captured_at FROM index_snapshots
   WHERE slug = $1 AND market = $2
   ORDER BY (jsonb_array_length(COALESCE(data->'brands','[]'::jsonb)) > 0) DESC, captured_at DESC
   LIMIT 1`,
  [slug, market]
);

if (!snapshot) {
  console.error(`No stored data for "${slug}" in ${market}.`);
  console.error('Run the index first:  npm run index -- ' + slug);
  await pool.end();
  process.exit(1);
}

const d = snapshot.data;
const ranked = (d.brands || [])
  .filter((b) => b.named || b.citations)
  .sort((a, b) => b.named - a.named || b.citations - a.citations);

if (ranked.length < 3) {
  console.error(`Only ${ranked.length} companies have any measurement. A poster needs at least three.`);
  console.error('Refresh the sector and try again.');
  await pool.end();
  process.exit(1);
}

const totalNamed = ranked.reduce((n, b) => n + b.named, 0) || 1;
const rows = ranked.map((b) => ({
  name: b.name,
  domain: b.domain,
  share: (b.named / totalNamed) * 100,
  cited: b.cited,
  colour: BRAND[b.domain] || '#35e08a'
}));

const title = flag('title', `Which ${d.name.toLowerCase()} brand does AI name?`);
const captured = new Date(snapshot.captured_at).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const max = Math.max(...rows.map((r) => r.share), 1);

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1080px;height:1350px;background:#08120d;color:#e9e3d5;font-family:'IBM Plex Sans',sans-serif;position:relative;overflow:hidden}
  .grid{position:absolute;inset:0;background-image:linear-gradient(#12211a 1px,transparent 1px),linear-gradient(90deg,#12211a 1px,transparent 1px);background-size:54px 54px;opacity:.5}
  .glow{position:absolute;width:760px;height:760px;right:-260px;top:-280px;border-radius:50%;background:radial-gradient(circle,rgba(53,224,138,.13) 0%,transparent 70%)}
  .in{position:relative;padding:68px 72px;height:100%;display:flex;flex-direction:column}
  .top{display:flex;align-items:center;gap:13px;margin-bottom:52px}
  .mark{font-family:'Instrument Serif',serif;font-size:38px}
  .mark em{font-style:normal;color:#35e08a}
  h1{font-family:'Instrument Serif',serif;font-weight:400;font-size:66px;line-height:1.06;letter-spacing:-.02em;max-width:17ch}
  h1 span{color:#35e08a}
  .dek{font-size:20px;line-height:1.55;color:#b9c4bb;margin-top:22px;max-width:50ch}
  .rows{margin-top:48px;flex:1;display:flex;flex-direction:column;justify-content:center;gap:4px}
  .row{display:grid;grid-template-columns:38px 1fr 104px;gap:22px;align-items:center;padding:18px 0;border-bottom:1px solid #17281f}
  .row:last-child{border-bottom:none}
  .rank{font-family:'IBM Plex Mono',monospace;font-size:19px;color:#5d7268}
  .row.top .rank{color:#35e08a}
  .who{display:flex;flex-direction:column;gap:9px}
  .nm{font-size:24px;font-weight:500;display:flex;align-items:center;gap:12px}
  .dot{width:11px;height:11px;border-radius:2px;flex:none}
  .no-cite{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#a8601b;border:1px solid #a8601b;border-radius:2px;padding:2px 6px}
  .track{display:block;height:12px;background:#12211a;border-radius:2px;overflow:hidden}
  /* An inline span ignores width and height, so the bars drew as empty lines. */
  .fill{display:block;height:100%;border-radius:2px}
  .pc{font-family:'Instrument Serif',serif;font-size:38px;text-align:right;line-height:1}
  .row.top .pc{color:#35e08a}
  .foot{border-top:1px solid #1b2f24;padding-top:26px;display:flex;justify-content:space-between;align-items:flex-end;gap:30px}
  .note{font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.75;letter-spacing:.03em;color:#5d7268;max-width:62ch}
  .note b{color:#b9c4bb;font-weight:400}
  .url{font-family:'IBM Plex Mono',monospace;font-size:15px;letter-spacing:.07em;color:#35e08a;white-space:nowrap}
</style></head><body>
<div class="grid"></div><div class="glow"></div>
<div class="in">
  <div class="top">
    <svg width="40" height="40" viewBox="0 0 40 40">
      <path d="M15 8H9v24h6M25 8h6v24h-6" stroke="#e9e3d5" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M20 11l2.6 6.4L29 20l-6.4 2.6L20 29l-2.6-6.4L11 20l6.4-2.6z" fill="#35e08a"/>
    </svg>
    <span class="mark">Cit<em>ed</em></span>
  </div>

  <h1>${esc(title)}</h1>
  <p class="dek">Share of AI answers naming each brand when people ask about ${esc(d.name.toLowerCase())} in the ${market === 'MENA' ? 'Arab world' : 'UAE'}. Measured, not surveyed.</p>

  <div class="rows">
    ${rows
      .map(
        (r, i) => `<div class="row ${i === 0 ? 'top' : ''}">
      <span class="rank">${i + 1}</span>
      <div class="who">
        <span class="nm"><span class="dot" style="background:${r.colour}"></span>${esc(r.name)}${
          r.cited ? '' : '<span class="no-cite">named, not cited</span>'
        }</span>
        <span class="track"><span class="fill" style="width:${Math.max(2, (r.share / max) * 100)}%;background:${r.colour}"></span></span>
      </div>
      <span class="pc">${r.share.toFixed(1)}%</span>
    </div>`
      )
      .join('')}
  </div>

  <div class="foot">
    <p class="note">
      <b>Method.</b> Google AI Overview answers for ${esc((d.keywords || [d.keyword]).filter(Boolean).map((k) => `"${k}"`).join(' and '))},
      ${captured}. Share is each brand's mentions as a proportion of all mentions of the listed brands.
      Brands marked <b>named, not cited</b> appear in the answer while the citation goes elsewhere.
      Not a measure of market share, revenue or quality.
    </p>
    <span class="url">cited.ae</span>
  </div>
</div>
</body></html>`;

mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
const htmlPath = new URL(`../out/poster-${slug}.html`, import.meta.url);
writeFileSync(htmlPath, html);

console.log(`\n${d.name}, ${market}\n`);
for (const [i, r] of rows.entries()) {
  console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(32)} ${r.share.toFixed(1).padStart(5)}%${r.cited ? '' : '   named, not cited'}`);
}
console.log(`\nWritten to out/poster-${slug}.html`);
console.log('Render it to PNG with:  npx playwright screenshot --viewport-size=1080,1350 \\');
console.log(`    "file://${htmlPath.pathname}" out/poster-${slug}.png\n`);
await pool.end();
