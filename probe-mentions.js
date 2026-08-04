import 'dotenv/config';

/**
 * Find the request shape that actually returns rows.
 *
 *   npm run probe
 *   npm run probe -- "banks uae"
 *
 * The LLM Mentions endpoints have been renamed once already and the docs do
 * not pin down every parameter, so rather than guessing again this tries a
 * handful of plausible variations against one keyword and reports which
 * combinations come back with data. Each call costs a fraction of a cent.
 *
 * Add --raw to dump the full response for the first successful variation,
 * which is what you want if the rows come back but the parser misses them.
 */

const BASE = 'https://api.dataforseo.com/v3/ai_optimization/llm_mentions';
const args = process.argv.slice(2);
const RAW = args.includes('--raw');
const keyword = args.filter((a) => !a.startsWith('--'))[0] || 'banks uae';

const login = process.env.DATAFORSEO_LOGIN;
const password = process.env.DATAFORSEO_PASSWORD;
if (!login || !password) {
  console.error('Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD first.');
  process.exit(1);
}
const auth = `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;

/** Count rows however they happen to be nested. */
function countRows(result) {
  if (!Array.isArray(result)) return 0;
  const first = result[0];
  if (!first) return 0;
  for (const key of ['items', 'brands', 'domains', 'pages', 'mentions', 'targets', 'result']) {
    if (Array.isArray(first[key])) return first[key].length;
  }
  // Some endpoints return the rows as the result array itself.
  return result.length && typeof first === 'object' && !first.items ? result.length : 0;
}

function describe(result) {
  const first = Array.isArray(result) ? result[0] : null;
  if (!first) return 'empty result';
  const keys = Object.keys(first).slice(0, 8).join(', ');
  const arrayKeys = Object.entries(first)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => `${k}[${v.length}]`)
    .join(' ');
  return `keys: ${keys}${arrayKeys ? ` | arrays: ${arrayKeys}` : ''}`;
}

async function attempt(path, payload) {
  const res = await fetch(`${BASE}/${path}/live`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify([payload])
  });
  const json = await res.json().catch(() => null);
  const task = json?.tasks?.[0];

  return {
    ok: res.ok && task && task.status_code < 40000,
    status: task?.status_code ?? res.status,
    message: task?.status_message || json?.status_message || `HTTP ${res.status}`,
    cost: Number(json?.cost || 0),
    rows: countRows(task?.result),
    shape: describe(task?.result),
    raw: json
  };
}

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const monthAgo = new Date(Date.now() - 30 * 86400000);

/** Variations worth trying, cheapest and most likely first. */
const VARIATIONS = [
  { name: 'target + location_name', payload: { target: [keyword], platform: 'google', location_name: 'United Arab Emirates', language_code: 'en' } },
  { name: 'target + location_code 2784', payload: { target: [keyword], platform: 'google', location_code: 2784, language_code: 'en' } },
  { name: 'no location at all', payload: { target: [keyword], platform: 'google', language_code: 'en' } },
  { name: 'United States instead', payload: { target: [keyword], platform: 'google', location_name: 'United States', language_code: 'en' } },
  { name: 'language_name not code', payload: { target: [keyword], platform: 'google', location_name: 'United Arab Emirates', language_name: 'English' } },
  { name: 'with a date range', payload: { target: [keyword], platform: 'google', location_name: 'United Arab Emirates', language_code: 'en', date_from: iso(monthAgo), date_to: iso(today) } },
  { name: 'keyword field instead of target', payload: { keyword, platform: 'google', location_name: 'United Arab Emirates', language_code: 'en' } },
  { name: 'no platform', payload: { target: [keyword], location_name: 'United Arab Emirates', language_code: 'en' } },
  { name: 'chat_gpt + United States', payload: { target: [keyword], platform: 'chat_gpt', location_name: 'United States', language_code: 'en' } }
];

const ENDPOINTS = ['top_mentioned_brands', 'top_mentioned_domains', 'search_mentions', 'target_metrics'];

console.log(`Probing LLM Mentions with keyword "${keyword}"\n`);

let firstHit = null;
let spend = 0;

for (const endpoint of ENDPOINTS) {
  console.log(`${endpoint}`);
  for (const v of VARIATIONS) {
    try {
      const r = await attempt(endpoint, v.payload);
      spend += r.cost;
      const verdict = !r.ok ? `REJECTED  ${r.message}` : r.rows ? `${String(r.rows).padStart(3)} rows  ${r.shape}` : `  0 rows  ${r.shape}`;
      console.log(`  ${v.name.padEnd(32)} ${verdict}`);
      if (r.ok && r.rows && !firstHit) firstHit = { endpoint, variation: v, response: r.raw };
    } catch (err) {
      console.log(`  ${v.name.padEnd(32)} ERROR     ${err.message}`);
    }
  }
  console.log('');
}

console.log(`Spent $${spend.toFixed(4)}`);

if (firstHit) {
  console.log(`\nWorking combination: ${firstHit.endpoint} with "${firstHit.variation.name}"`);
  console.log(`Payload: ${JSON.stringify(firstHit.variation.payload)}`);
  if (RAW) {
    console.log('\nFull response:\n');
    console.log(JSON.stringify(firstHit.response, null, 2).slice(0, 6000));
  } else {
    console.log('\nRun again with --raw to see the full response and the exact field names.');
  }
} else {
  console.log('\nNothing returned rows. Either this keyword has no coverage, or the account');
  console.log('does not have LLM Mentions data for this market. Try: npm run probe -- "best bank"');
}

process.exit(0);
