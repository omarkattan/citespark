import 'dotenv/config';

/**
 * The supported locations and languages for LLM Mentions, from DataForSEO's
 * own endpoint. Free to call.
 *
 *   npm run locations              every Arab market, with its languages
 *   npm run locations -- saudi     filter
 *   npm run locations -- all       the whole list
 *   npm run locations -- --map     emit a ready-to-paste MARKET_LANGUAGE map
 *
 * Guessing at this cost two rebuilds and about $6 in probes. Ask instead.
 */
const args = process.argv.slice(2);
const MAP = args.includes('--map');
const filter = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();

const login = process.env.DATAFORSEO_LOGIN;
const password = process.env.DATAFORSEO_PASSWORD;
if (!login || !password) {
  console.error('Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD first.');
  process.exit(1);
}
const auth = `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;

const res = await fetch('https://api.dataforseo.com/v3/ai_optimization/llm_mentions/locations_and_languages', {
  headers: { Authorization: auth }
});
const json = await res.json().catch(() => null);
const task = json?.tasks?.[0];

if (!res.ok || !task || task.status_code >= 40000) {
  console.error(`Failed: ${task?.status_message || `HTTP ${res.status}`}`);
  process.exit(1);
}

const rows = task.result || [];
console.log(`${rows.length} locations supported\n`);

/** The markets this project cares about, in the order they matter. */
const WANTED = [
  'united arab emirates', 'saudi arabia', 'qatar', 'kuwait', 'bahrain', 'oman',
  'egypt', 'jordan', 'lebanon', 'iraq', 'morocco', 'algeria', 'tunisia', 'libya'
];

const CODES = {
  'united arab emirates': 'AE', 'saudi arabia': 'SA', qatar: 'QA', kuwait: 'KW',
  bahrain: 'BH', oman: 'OM', egypt: 'EG', jordan: 'JO', lebanon: 'LB',
  iraq: 'IQ', morocco: 'MA', algeria: 'DZ', tunisia: 'TN', libya: 'LY'
};

const langsOf = (r) => {
  const l = r.available_languages || r.languages || [];
  return (Array.isArray(l) ? l : []).map((x) => x.language_code || x.language_name || x);
};

const byName = new Map(rows.map((r) => [String(r.location_name || '').toLowerCase(), r]));

if (MAP) {
  console.log('export const MARKET_LANGUAGE = {');
  for (const name of WANTED) {
    const r = byName.get(name);
    if (!r) continue;
    const langs = langsOf(r);
    const pick = langs.includes('en') ? 'en' : langs.includes('ar') ? 'ar' : langs[0];
    if (pick) console.log(`  ${CODES[name]}: '${pick}',   // ${r.location_name}: ${langs.join(', ')}`);
  }
  console.log('};\n');
  console.log('Not supported at all:');
  for (const name of WANTED) if (!byName.has(name)) console.log(`  ${CODES[name]}  ${name}`);
  process.exit(0);
}

const show = filter === 'all' ? rows : filter ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(filter)) : WANTED.map((n) => byName.get(n)).filter(Boolean);

console.log('location                            code       languages');
for (const r of show.slice(0, 80)) {
  console.log(`  ${String(r.location_name).padEnd(34)} ${String(r.location_code ?? '').padEnd(10)} ${langsOf(r).join(', ')}`);
}
if (show.length > 80) console.log(`  ...and ${show.length - 80} more`);

if (!filter) {
  const missing = WANTED.filter((n) => !byName.has(n));
  if (missing.length) {
    console.log(`\nNot in the corpus: ${missing.map((n) => CODES[n]).join(', ')}`);
    console.log('Those markets cannot be measured and should be reported as no data, not as zero.');
  }
  console.log('\nRun with --map to get a MARKET_LANGUAGE block for src/lib/mentions.js');
}
process.exit(0);
