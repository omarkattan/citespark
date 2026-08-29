import 'dotenv/config';
import { pool, many, one } from '../src/db/index.js';
import { askEngine, LOCATIONS } from '../src/lib/dataforseo.js';

/**
 * Is the ChatGPT number we report the number a customer would see?
 *
 *   npm run surface -- 7                 5 questions, 5 runs each surface
 *   npm run surface -- 7 --questions 3 --runs 4
 *   npm run surface -- 7 --cap 2.00      stop before spending more than this
 *
 * We answer ChatGPT through DataForSEO's LLM Responses endpoint, which is
 * OpenAI's API. A customer uses chatgpt.com. Those are different products
 * that happen to share a model, and we currently show the API number beside
 * scraped Google AI Mode as though both were the consumer surface.
 *
 * THE TRAP THIS SCRIPT EXISTS TO AVOID
 *
 * Ask each surface once, see different answers, and conclude the surfaces
 * differ. That conclusion would be wrong. These engines disagree with
 * themselves between identical asks, so a single pair cannot tell a surface
 * difference from ordinary noise.
 *
 * So each question is asked N times on BOTH surfaces, and we compare:
 *
 *   within-surface spread   how much one surface disagrees with itself
 *   between-surface gap     how far the two surfaces sit apart
 *
 * Only a gap clearly larger than the spread is evidence of anything. If the
 * gap sits inside the noise, the honest finding is "not shown to differ at
 * this sample size", which is a real result and must not be written up as
 * "the surfaces agree".
 */

const args = process.argv.slice(2);
const projectId = Number(args.find((a) => /^\d+$/.test(a)));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const QUESTIONS = flag('questions', 5);
const RUNS = flag('runs', 5);
const CAP = flag('cap', 3);

if (!projectId) {
  const rows = await many('SELECT id, name FROM projects ORDER BY id');
  console.log('Give a project id:\n' + rows.map((r) => `  ${r.id}  ${r.name}`).join('\n'));
  await pool.end();
  process.exit(0);
}

const BASE = 'https://api.dataforseo.com/v3';
const authHeader = () =>
  `Basic ${Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64')}`;

/* ---------------- the consumer surface ---------------- */

/**
 * LLM Scraper drives chatgpt.com through a proxy, so unlike LLM Responses it
 * has an IP and a real retrieval stack. force_web_search is on because the
 * comparison is only fair against our API calls, which set web_search true.
 *
 * Its location list carries exactly one UAE entry, the country itself, so a
 * city is not an option here and passing one would be rejected outright,
 * failing every consumer call and leaving the test with nothing to compare.
 * The country NAME is what it wants; the ISO code is also rejected.
 *
 * The docs put execution at up to 120 seconds, which is the number to watch:
 * if it holds, a 260-question cycle cannot run this surface synchronously and
 * would need the task-based endpoints instead.
 */
async function askScraper({ prompt, countryName }) {
  const started = Date.now();
  const body = [{
    keyword: prompt.slice(0, 2000),
    language_code: 'en',
    force_web_search: true,
    location_name: countryName
  }];

  try {
    const res = await fetch(`${BASE}/ai_optimization/chat_gpt/llm_scraper/live/advanced`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => null);
    const task = json?.tasks?.[0];
    if (!res.ok || !task || task.status_code >= 40000) {
      return { ok: false, error: task?.status_message || `HTTP ${res.status}`, costUsd: Number(json?.cost || 0), secs: (Date.now() - started) / 1000 };
    }
    const r = task.result?.[0] || {};
    const text = r.markdown || (r.items || []).map((i) => i.markdown || i.text || '').join('\n\n');

    // "sources" is what the model actually leaned on; "search_results" is
    // everything it looked at. Only the first is comparable to what we store
    // as a citation today, so they are kept apart rather than merged.
    const sources = [...new Set((r.sources || []).map((s) => s.domain).filter(Boolean))];
    const looked = [...new Set((r.search_results || []).map((s) => s.domain).filter(Boolean))];

    return {
      ok: Boolean(text?.trim()),
      text: String(text || '').trim(),
      sources,
      looked,
      brands: (r.brand_entities || []).map((b) => b.title).filter(Boolean),
      model: r.model || null,
      costUsd: Number(json?.cost ?? task?.cost ?? 0),
      secs: (Date.now() - started) / 1000,
      error: text?.trim() ? null : 'Empty response'
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err), costUsd: 0, secs: (Date.now() - started) / 1000 };
  }
}

/* ---------------- detection, matched to the product ---------------- */

/**
 * The same literal match analyseRun uses, deliberately. A different rule here
 * would make the two surfaces look different for a reason that had nothing to
 * do with the surfaces.
 */
const named = (text, names) => {
  const hay = String(text || '').toLowerCase();
  return names.some((n) => n && hay.includes(String(n).toLowerCase()));
};

/* ---------------- run ---------------- */

const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
if (!project) { console.error(`No project ${projectId}.`); await pool.end(); process.exit(1); }

const owned = await one("SELECT name, aliases FROM entities WHERE project_id = $1 AND kind = 'owned' ORDER BY id LIMIT 1", [projectId]);
const names = [owned?.name, ...(owned?.aliases || [])].filter(Boolean);
if (!names.length) { console.error('No owned brand on that project.'); await pool.end(); process.exit(1); }

/**
 * Real questions from the live set, busiest first. A made-up question would
 * test the endpoint but not the client, and the result should be usable in
 * the next report without re-running anything.
 */
const prompts = await many(
  `SELECT text FROM prompts WHERE project_id = $1 AND active
   ORDER BY ai_search_volume DESC, id LIMIT $2`,
  [projectId, QUESTIONS]
);

/**
 * Both surfaces are asked from the same country, at country level, even if
 * the project has a city set. The consumer surface cannot take a city, and
 * comparing a Dubai API answer against a UAE consumer answer would measure
 * the location difference and report it as a surface difference.
 */
const countryName = LOCATIONS[project.market];
if (!countryName) {
  console.error(`No country name for market ${project.market}. Add it to LOCATIONS first.`);
  await pool.end();
  process.exit(1);
}

console.log(`\n${project.name}: ChatGPT API against ChatGPT consumer`);
console.log(`Brand: ${names[0]}${names.length > 1 ? ` (+${names.length - 1} aliases)` : ''}`);
console.log(`Asked from: ${countryName}, country level on both surfaces${project.location_name ? ` (the project's city, ${project.location_name.split(',')[0]}, is set aside so the surfaces stay comparable)` : ''}`);
console.log(`${prompts.length} questions x ${RUNS} runs x 2 surfaces = ${prompts.length * RUNS * 2} calls, cap $${CAP.toFixed(2)}\n`);

const rows = [];
let spent = 0;
let stopped = false;

for (const p of prompts) {
  if (stopped) break;
  console.log(`\n"${p.text.slice(0, 78)}${p.text.length > 78 ? '...' : ''}"`);

  for (const surface of ['api', 'consumer']) {
    const hits = [];
    let fails = 0;
    let secs = 0;
    const domains = new Set();

    for (let i = 0; i < RUNS; i++) {
      if (spent >= CAP) { stopped = true; break; }

      const a = surface === 'api'
        ? await askEngine({ engine: 'chatgpt', prompt: p.text, market: project.market, maxTokens: 2000 })
        : await askScraper({ prompt: p.text, countryName });

      spent += a.costUsd || 0;
      secs += a.secs || 0;

      // A failed call is not a miss. Counting it as one would inflate exactly
      // the difference we are trying to measure.
      if (!a.ok) { fails++; continue; }

      hits.push(named(a.text, names) ? 1 : 0);
      for (const d of (surface === 'api' ? (a.citations || []).map((c) => c.domain || c) : a.sources)) {
        if (d) domains.add(d);
      }
    }

    const n = hits.length;
    const rate = n ? hits.reduce((s, x) => s + x, 0) / n : null;
    rows.push({ question: p.text, surface, n, fails, rate, domains: [...domains], secs });

    console.log(
      `  ${surface.padEnd(9)} ` +
      (n ? `named in ${hits.reduce((s, x) => s + x, 0)}/${n}` : 'no usable answers') +
      `${fails ? `, ${fails} failed` : ''}` +
      `, ${domains.size} domains, ${(secs / Math.max(1, n + fails)).toFixed(1)}s avg`
    );
  }
}

/* ---------------- read it out ---------------- */

const bySurface = (s) => rows.filter((r) => r.surface === s && r.rate !== null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const api = bySurface('api');
const ui = bySurface('consumer');

console.log(`\n${'-'.repeat(64)}\nSpent $${spent.toFixed(4)}${stopped ? ' (stopped at the cap)' : ''}`);

if (!api.length || !ui.length) {
  console.log('Not enough usable answers on both surfaces to compare. Nothing can be concluded from this run.');
  await pool.end();
  process.exit(0);
}

const apiRate = mean(api.map((r) => r.rate));
const uiRate = mean(ui.map((r) => r.rate));
const gap = (uiRate - apiRate) * 100;

/**
 * The noise floor: how far a single question's rate sits from its own
 * surface's average. If the between-surface gap does not clear this, the two
 * surfaces have not been shown to differ.
 */
const spread = mean([
  ...api.map((r) => Math.abs(r.rate - apiRate)),
  ...ui.map((r) => Math.abs(r.rate - uiRate))
]) * 100;

console.log(`\nNamed on the API surface:      ${(apiRate * 100).toFixed(0)}%  (${api.length} questions x ${RUNS} runs)`);
console.log(`Named on the consumer surface: ${(uiRate * 100).toFixed(0)}%`);
console.log(`Gap: ${gap >= 0 ? '+' : ''}${gap.toFixed(0)} points`);
console.log(`Run-to-run spread within a surface: ${spread.toFixed(0)} points`);

console.log(
  Math.abs(gap) > spread * 1.5
    ? `\nVERDICT: the gap is larger than the noise. The ChatGPT number we publish\n` +
      `is not the number a customer sees, and the surface has to be labelled.`
    : `\nVERDICT: the gap sits inside the run-to-run noise at this sample size.\n` +
      `That is NOT "the surfaces agree" - it is "not shown to differ from ${prompts.length}\n` +
      `questions x ${RUNS} runs". Raise --runs before concluding either way.`
);

const apiDomains = new Set(api.flatMap((r) => r.domains));
const uiDomains = new Set(ui.flatMap((r) => r.domains));
const onlyUi = [...uiDomains].filter((d) => !apiDomains.has(d));
const onlyApi = [...apiDomains].filter((d) => !uiDomains.has(d));

console.log(`\nSources cited: ${apiDomains.size} domains on the API, ${uiDomains.size} on the consumer surface.`);
if (onlyUi.length) console.log(`  Only the consumer surface cited: ${onlyUi.slice(0, 12).join(', ')}`);
if (onlyApi.length) console.log(`  Only the API cited: ${onlyApi.slice(0, 12).join(', ')}`);
console.log('  A citation list that differs matters as much as the verdict: our action');
console.log('  lists are built from these domains, so the wrong surface means the wrong work.');

const apiSecs = mean(api.map((r) => r.secs / Math.max(1, r.n)));
const uiSecs = mean(ui.map((r) => r.secs / Math.max(1, r.n)));
console.log(`\nSpeed: ${apiSecs.toFixed(1)}s per API call, ${uiSecs.toFixed(1)}s per consumer call.`);
console.log(`  At ${uiSecs.toFixed(0)}s a call, a 260-question cycle on this surface takes`);
console.log(`  about ${Math.round((260 * uiSecs) / 60)} minutes per run. If that is too slow, the task-based`);
console.log('  endpoints exist and the live one is the wrong shape for a full cycle.');

const failed = rows.reduce((s, r) => s + r.fails, 0);
if (failed) console.log(`\n${failed} calls failed and were excluded rather than counted as misses.`);

await pool.end();
