import 'dotenv/config';

/**
 * How fine can we set the asking location, and does it change the answer?
 *
 *   npm run geo                     what locations exist, per engine (free)
 *   npm run geo -- dubai            filter that list
 *   npm run geo -- --test           ask one question from three zoom levels (paid)
 *   npm run geo -- --test "your question here"
 *
 * Two different questions, and only the second one matters:
 *
 *   1. What granularity will the API accept? Documented, free to check.
 *   2. Does a finer location actually change what comes back? Only an
 *      experiment answers that, and if the answer is no, a location picker
 *      in the product would be a control that does nothing.
 *
 * Shipping the picker before running --test would put a number on screen we
 * cannot stand behind, which is the one thing this product does not do.
 */
const args = process.argv.slice(2);
const TEST = args.includes('--test');
const filter = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();

const login = process.env.DATAFORSEO_LOGIN;
const password = process.env.DATAFORSEO_PASSWORD;
if (!login || !password) {
  console.error('Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD first.');
  process.exit(1);
}
const auth = `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
const BASE = 'https://api.dataforseo.com/v3';

async function call(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const json = await res.json().catch(() => null);
  const task = json?.tasks?.[0];
  if (!res.ok || !task || task.status_code >= 40000) {
    throw new Error(task?.status_message || `HTTP ${res.status}`);
  }
  return { result: task.result || [], cost: Number(json?.cost || 0) };
}

/* ---------------- 1. what the APIs will accept ---------------- */

/**
 * Google's list is the deep one: it carries towns and districts, not just
 * countries. The scraper's list is separate and usually much shorter, so it
 * is asked for separately rather than assumed to match.
 */
async function listLocations() {
  const sources = [
    { label: 'Google AI Mode and AI Overview', path: '/serp/google/locations/AE' },
    { label: 'ChatGPT LLM Scraper', path: '/ai_optimization/chat_gpt/llm_scraper/locations' }
  ];

  for (const s of sources) {
    process.stdout.write(`\n${s.label}\n`);
    let rows;
    try {
      ({ result: rows } = await call(s.path));
    } catch (err) {
      console.log(`  could not read the list: ${err.message}`);
      continue;
    }

    const ae = rows.filter((r) => {
      const name = String(r.location_name || '');
      const inScope = r.country_iso_code === 'AE' || /united arab emirates/i.test(name);
      return inScope && (!filter || name.toLowerCase().includes(filter));
    });

    if (!ae.length) {
      console.log(`  no UAE entries${filter ? ` matching "${filter}"` : ''}.`);
      continue;
    }

    // Grouping by type is the answer to "how deep does this go".
    const byType = new Map();
    for (const r of ae) {
      const t = r.location_type || 'unknown';
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(r);
    }

    console.log(`  ${ae.length} UAE entries, by type:`);
    for (const [type, rows2] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
      const sample = rows2.slice(0, 6).map((r) => r.location_name.replace(/,United Arab Emirates$/, ''));
      console.log(`    ${String(type).padEnd(14)} ${String(rows2.length).padStart(4)}  e.g. ${sample.join(', ')}`);
    }

    // The specific thing we want to know.
    const difc = ae.find((r) => /difc|international financial cent/i.test(r.location_name));
    console.log(difc
      ? `  DIFC is a named location: ${difc.location_name} (code ${difc.location_code})`
      : '  DIFC is NOT a named location. Coordinates are the only route to it.');
  }
}

/* ---------------- 2. does finer actually differ ---------------- */

/**
 * Three asks of one question: country, city, and a point inside DIFC at the
 * tightest zoom the API allows. If all three come back the same, location is
 * a dimension we can advertise but not one worth charging for.
 */
const DEFAULT_Q = 'Which firms provide family wealth management services in Dubai?';

const PLACES = [
  { label: 'UAE (country)', body: { location_name: 'United Arab Emirates' } },
  { label: 'Dubai (city)', body: { location_name: 'Dubai,Dubai,United Arab Emirates' } },
  // DIFC, approximately. Edit if you want a different point; 18z is the
  // tightest the endpoint accepts.
  { label: 'DIFC (25.2119,55.2793 at 18z)', body: { location_coordinate: '25.2119,55.2793,18z' } }
];

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function runTest(question) {
  console.log(`\nAsking: ${question}\n`);
  const seen = [];
  let spent = 0;

  for (const place of PLACES) {
    process.stdout.write(`  ${place.label.padEnd(32)}`);
    try {
      const { result, cost } = await call('/serp/google/ai_mode/live/advanced', [
        { keyword: question.slice(0, 700), language_code: 'en', device: 'desktop', ...place.body }
      ]);
      spent += cost;

      const overview = result?.[0]?.items?.find((i) => i.type === 'ai_overview');
      const text = norm(overview?.markdown || overview?.items?.map((i) => i.text).join(' '));
      const domains = [...new Set((overview?.references || []).map((r) => r.domain).filter(Boolean))];

      if (!text) {
        // No answer is not the same as an identical answer, and lumping them
        // together would make a broken location look like a working one.
        console.log('no answer returned (not the same as "identical")');
        seen.push({ place: place.label, text: null, domains });
        continue;
      }
      console.log(`${String(text.length).padStart(5)} chars, ${domains.length} sources cited`);
      seen.push({ place: place.label, text, domains });
    } catch (err) {
      console.log(`failed: ${err.message}`);
      seen.push({ place: place.label, text: null, domains: [], error: err.message });
    }
  }

  console.log(`\n  spent $${spent.toFixed(4)}\n`);

  const answered = seen.filter((s) => s.text);
  if (answered.length < 2) {
    console.log('  Not enough answers came back to compare. Try again before concluding anything.');
    return;
  }

  const allSame = answered.every((s) => s.text === answered[0].text);
  console.log(allSame
    ? '  VERDICT: identical text at every zoom. On this question, a finer\n' +
      '  location changes nothing, and a district picker would be a control\n' +
      '  that does not control anything. Try a question with local intent\n' +
      '  before ruling it out entirely.'
    : '  VERDICT: the text differs by location. Worth building.');

  for (const s of answered) {
    const others = answered.filter((o) => o !== s).flatMap((o) => o.domains);
    const only = s.domains.filter((d) => !others.includes(d));
    if (only.length) console.log(`  cited only at ${s.place}: ${only.join(', ')}`);
  }
}

/* ---------------- run ---------------- */

console.log('\nWhat locations each engine accepts, and whether finer changes the answer.');
console.log('Note: the LLM Responses endpoints (ChatGPT, Claude, Gemini, Perplexity)');
console.log('take a country code at most, and our own config records that Claude and');
console.log('Gemini reject even that. No district-level asking exists there at all.\n');

try {
  await listLocations();
  if (TEST) {
    const q = args.find((a) => !a.startsWith('--') && a.includes(' ')) || DEFAULT_Q;
    await runTest(q);
  } else {
    console.log('\nAdd --test to ask one question from all three zoom levels (costs a few cents).');
  }
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
}
