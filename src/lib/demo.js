import crypto from 'node:crypto';
import 'dotenv/config';
import { one, many, query } from '../db/index.js';
import { discoverSite } from './discover.js';
import { complete, parseJsonArray } from './anthropic.js';
import { askEngine, MOCK } from './dataforseo.js';
import { analyseRun } from './analyze.js';

/**
 * The public try-it-first demo.
 *
 * Three things make this safe to expose without an account:
 *
 *  1. The visitor never supplies the prompt. They give a domain, we read the
 *     site and generate the questions, and only a question we signed can be
 *     run. Without that, this is a free ChatGPT proxy within a day.
 *  2. Per-IP limits and a global daily spend cap, because every run costs
 *     real money and nobody is paying for it.
 *  3. Identical requests inside the cache window are served from the previous
 *     result, so a link doing the rounds costs one run rather than a thousand.
 */

const DEMO_ENGINE = process.env.DEMO_ENGINE || 'chatgpt';
const DEMO_RUNS = Number(process.env.DEMO_RUNS || 3);
const DEMO_PER_IP_DAY = Number(process.env.DEMO_PER_IP_DAY || 3);
const DEMO_PER_IP_HOUR = Number(process.env.DEMO_PER_IP_HOUR || 2);
const DEMO_DAILY_BUDGET = Number(process.env.DEMO_DAILY_BUDGET || 15);
const CACHE_HOURS = Number(process.env.DEMO_CACHE_HOURS || 24);

const SECRET = process.env.SESSION_SECRET || 'demo-secret';

/** Store a hash, never the address itself. */
export function hashIp(ip) {
  return crypto.createHmac('sha256', SECRET).update(String(ip || 'unknown')).digest('hex').slice(0, 32);
}

/**
 * Sign a question so only ones we generated can be run. Without this the
 * run endpoint accepts arbitrary text and becomes an open LLM endpoint.
 */
export function signQuestion(domain, question) {
  return crypto.createHmac('sha256', SECRET).update(`${domain}|${question}`).digest('hex').slice(0, 24);
}

export function verifyQuestion(domain, question, token) {
  const expected = signQuestion(domain, question);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- limits ---------------- */

export async function checkLimits(ipHash) {
  const spent = await one(
    "SELECT COALESCE(SUM(cost_usd),0)::float AS total FROM demo_runs WHERE created_at > now() - interval '1 day'"
  );
  if (spent.total >= DEMO_DAILY_BUDGET) {
    return { ok: false, reason: 'The live demo has hit its daily limit. Try again tomorrow, or create a free account to run it now.' };
  }

  const day = await one(
    "SELECT COUNT(*)::int AS n FROM demo_runs WHERE ip_hash = $1 AND created_at > now() - interval '1 day'",
    [ipHash]
  );
  if (day.n >= DEMO_PER_IP_DAY) {
    return { ok: false, reason: `That is ${DEMO_PER_IP_DAY} checks today, which is the limit for the free demo. A free account gets you more.` };
  }

  const hour = await one(
    "SELECT COUNT(*)::int AS n FROM demo_runs WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'",
    [ipHash]
  );
  if (hour.n >= DEMO_PER_IP_HOUR) {
    return { ok: false, reason: 'Give it an hour before the next one, or create a free account to keep going.' };
  }

  return { ok: true, remaining: DEMO_PER_IP_DAY - day.n };
}

/* ---------------- step one: read the site, propose questions ---------------- */

const QUESTION_SYSTEM = `You write the questions a buyer would type into ChatGPT when looking for a business like this one.

Return ONLY a JSON array of exactly 3 objects: {"text": string, "why": string}
- text: the question, 8 to 20 words, exactly as a real buyer would type it. Never include the brand's own name.
- why: 6 to 12 words on why this question matters commercially to them.
- Cover different intents: one "best X for Y", one comparison or selection question, one problem-led.
- Include location or sector qualifiers where the business is local or specialised.`;

export async function proposeQuestions(domainInput) {
  const site = await discoverSite(domainInput);
  if (!site.ok) return site;

  const raw = await complete(
    `Business: ${site.brandName} (${site.domain})\nWhat they do: ${site.category}\nWho buys: ${site.qualifier}\nMarket: ${site.market}\n\nWrite 3 questions.`,
    { system: QUESTION_SYSTEM, maxTokens: 600 }
  );
  const parsed = parseJsonArray(raw);

  const fallback = [
    { text: `What is the best ${site.category} for ${site.qualifier}?`, why: 'The core commercial question' },
    { text: `Which ${site.category} companies are worth considering?`, why: 'Pure discovery, no brand named' },
    { text: `How do I choose a ${site.category} without getting it wrong?`, why: 'Problem-led, high intent' }
  ];

  const questions = (parsed?.length ? parsed : fallback)
    .filter((q) => q?.text)
    .slice(0, 3)
    .map((q) => ({
      text: String(q.text).trim().slice(0, 300),
      why: String(q.why || '').trim().slice(0, 120),
      token: signQuestion(site.domain, String(q.text).trim().slice(0, 300))
    }));

  return {
    ok: true,
    domain: site.domain,
    brandName: site.brandName,
    category: site.category,
    qualifier: site.qualifier,
    market: site.market,
    confident: site.confident,
    questions
  };
}

/* ---------------- step two: run it ---------------- */

export async function runDemo({ domain, brandName, question, token, market, ipHash }) {
  if (!verifyQuestion(domain, question, token)) {
    return { ok: false, error: 'That question was not one of ours. Scan the site again to get a fresh set.' };
  }

  // Serve an identical recent request from cache rather than paying twice.
  const cached = await one(
    `SELECT result FROM demo_runs
     WHERE domain = $1 AND question = $2 AND result IS NOT NULL
       AND created_at > now() - ($3 || ' hours')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [domain, question, String(CACHE_HOURS)]
  );
  if (cached?.result) {
    await query('INSERT INTO demo_runs (ip_hash, domain, question, cost_usd) VALUES ($1,$2,$3,0)', [ipHash, domain, question]);
    return { ok: true, cached: true, ...cached.result };
  }

  const entity = { id: 1, name: brandName, domain, kind: 'owned', aliases: [] };
  const answers = [];
  let spend = 0;

  for (let i = 0; i < DEMO_RUNS; i++) {
    const a = await askEngine({ engine: DEMO_ENGINE, prompt: question, market: market || 'AE', maxTokens: 600 });
    spend += a.costUsd || 0;
    if (!a.ok) continue;
    const [mine] = await analyseRun({ text: a.text, entities: [entity] });
    answers.push({
      mentioned: mine.mentioned,
      ordinal: mine.ordinal,
      snippet: mine.snippet,
      text: a.text,
      citations: a.citations.slice(0, 6),
      fanOut: a.fanOut || []
    });
  }

  if (!answers.length) {
    await query('INSERT INTO demo_runs (ip_hash, domain, question, cost_usd) VALUES ($1,$2,$3,$4)', [ipHash, domain, question, spend]);
    return { ok: false, error: 'The engine did not answer that one. Try another question.' };
  }

  const hits = answers.filter((a) => a.mentioned);
  const ordinals = hits.map((a) => a.ordinal).filter(Boolean);

  // Who did get named, taken from the longest answer we have.
  const longest = answers.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  const others = extractNames(longest.text, brandName);

  const domains = {};
  for (const a of answers) for (const c of a.citations) domains[c.domain] = (domains[c.domain] || 0) + 1;

  const result = {
    domain,
    brandName,
    question,
    engine: DEMO_ENGINE,
    runs: answers.length,
    mentions: hits.length,
    rate: hits.length / answers.length,
    avgOrdinal: ordinals.length ? ordinals.reduce((a, b) => a + b, 0) / ordinals.length : null,
    strip: answers.map((a) => Boolean(a.mentioned)),
    snippet: hits[0]?.snippet || longest.text.slice(0, 320),
    excerpt: longest.text.slice(0, 900),
    others: others.slice(0, 5),
    sources: Object.entries(domains).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d, n]) => ({ domain: d, n })),
    fanOut: [...new Set(answers.flatMap((a) => a.fanOut))].slice(0, 2)
  };

  await query('INSERT INTO demo_runs (ip_hash, domain, question, result, cost_usd) VALUES ($1,$2,$3,$4,$5)',
    [ipHash, domain, question, JSON.stringify(result), spend]);

  return { ok: true, ...result };
}

/**
 * Pull the other businesses out of a recommendation list. Crude on purpose:
 * this is a teaser, and the real product tracks named competitors properly.
 */
function extractNames(text, ownBrand) {
  const names = new Set();
  const own = ownBrand.toLowerCase();

  for (const line of text.split('\n')) {
    const m =
      line.match(/^\s*\d+\.\s*\*{0,2}\[?([^*\]\n(]{3,45}?)\]?\*{0,2}\s*[-—:(]/) ||
      line.match(/^\s*\*\*\[?([^*\]\n]{3,45}?)\]?\*\*/) ||
      line.match(/^\s*[-*]\s*\*{0,2}([^*\n:]{3,45}?)\*{0,2}\s*[-—:]/);
    if (!m) continue;
    const name = m[1].replace(/\[|\]|\(.*$/g, '').trim();
    if (name.length < 3 || name.length > 45) continue;
    if (name.toLowerCase().includes(own) || own.includes(name.toLowerCase())) continue;
    if (/^(here|these|some|the following|options|note|overall)/i.test(name)) continue;
    names.add(name);
  }
  return [...names];
}

export const DEMO_CONFIG = { engine: DEMO_ENGINE, runs: DEMO_RUNS, perDay: DEMO_PER_IP_DAY, mock: MOCK };
