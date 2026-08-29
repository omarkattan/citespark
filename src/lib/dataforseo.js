import 'dotenv/config';

/**
 * DataForSEO AI Optimization API client.
 *
 * IMPORTANT: the exact JSON shape of LLM Responses payloads changes as
 * DataForSEO ships updates. Rather than hard-coding a path like
 * tasks[0].result[0].items[0].sections[0].text, this module walks the
 * response tree and collects anything that looks like answer text or a
 * source URL. Log a raw payload once against your account and tighten
 * the parser if you want stricter extraction.
 */

const BASE = 'https://api.dataforseo.com/v3';

/**
 * Every surface DataForSEO can reach, in the order most people should add them.
 *
 *   kind 'llm'  -> ai_optimization/{path}/llm_responses/live
 *   kind 'serp' -> the SERP API, for Google's own AI surfaces
 *
 * Copilot, Grok, DeepSeek and Meta AI are not available through DataForSEO,
 * so they are deliberately absent rather than stubbed.
 */
export const ENGINES = {
  chatgpt: {
    label: 'ChatGPT',
    kind: 'llm',
    path: 'chat_gpt',
    model: process.env.MODEL_CHATGPT || null,
    supportsCountry: true,
    note: 'The largest surface by usage. Start here.'
  },
  ai_overview: {
    label: 'Google AI Overview',
    kind: 'serp',
    mode: 'overview',
    note: 'The summary above Google results. Only appears for some queries, and an absence is itself a finding.'
  },
  ai_mode: {
    label: 'Google AI Mode',
    kind: 'serp',
    mode: 'ai_mode',
    note: 'Google\'s conversational search. Growing fast and largely unmeasured by other tools.'
  },
  perplexity: {
    label: 'Perplexity',
    kind: 'llm',
    path: 'perplexity',
    model: process.env.MODEL_PERPLEXITY || null,
    supportsCountry: true,
    note: 'Leans hardest on freshly crawled pages, so it moves first when you publish.'
  },
  gemini: {
    label: 'Gemini',
    kind: 'llm',
    path: 'gemini',
    // Observed: DataForSEO rejects several plausible Gemini model strings with
    // "Invalid Field: 'model_name'". Omitting it lets them pick a valid default,
    // which is more durable than chasing their supported list.
    model: process.env.MODEL_GEMINI || null,
    // Observed: Gemini rejects web_search_country_iso_code the same way Claude
    // does, failing 100% of calls with "Invalid Field". That is a rejection of
    // our request, not a provider outage, and it was being reported to
    // customers as Gemini being unreliable.
    supportsCountry: false,
    note: 'Favours Google surfaces, so your Business Profile and entity consistency matter here.'
  },
  claude: {
    label: 'Claude',
    kind: 'llm',
    path: 'claude',
    model: process.env.MODEL_CLAUDE || null,
    // Observed: Claude's endpoint rejects web_search_country_iso_code outright.
    supportsCountry: false,
    note: 'Smaller reach, but heavily used in B2B and professional services.'
  }
};

export const ENGINE_IDS = Object.keys(ENGINES);

/** SERP calls want a location name, not an ISO code. */
export const LOCATIONS = {
  AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', KW: 'Kuwait',
  BH: 'Bahrain', OM: 'Oman', EG: 'Egypt', GB: 'United Kingdom', US: 'United States',
  IN: 'India', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy',
  NL: 'Netherlands', CA: 'Canada', AU: 'Australia', IE: 'Ireland',
  ZA: 'South Africa', SG: 'Singapore', PK: 'Pakistan', TR: 'Turkey',
  MY: 'Malaysia', ID: 'Indonesia', PH: 'Philippines', NG: 'Nigeria', KE: 'Kenya'
};

export const MOCK = String(process.env.MOCK_MODE || '').toLowerCase() === 'true';

/**
 * The cities Google will actually accept, per country.
 *
 * A hand-written list would be a guess, and a location string Google does not
 * recognise is rejected outright rather than rounded to the nearest place, so
 * the guess would surface as a whole engine returning nothing. This endpoint
 * is free, so ask instead. Cached for a day because the list barely moves.
 *
 * Returns the full location_name verbatim ("Dubai,Dubai,United Arab
 * Emirates") because that exact string is what gets sent back to the SERP
 * call. Never reassemble it from parts.
 */
const LOCATION_CACHE_MS = Number(process.env.LOCATION_CACHE_MS || 24 * 60 * 60 * 1000);
const locationCache = new Map(); // ISO -> { at, cities }

export async function googleLocations(iso) {
  const key = String(iso || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(key)) return [];

  const hit = locationCache.get(key);
  if (hit && Date.now() - hit.at < LOCATION_CACHE_MS) return hit.cities;

  const res = await fetch(`${BASE}/serp/google/locations/${key}`, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const task = json?.tasks?.[0];
  if (!task || task.status_code >= 40000) throw new Error(task?.status_message || 'Locations lookup failed');

  /**
   * Which types count as "a place you could be asked from".
   *
   * Measured, not guessed: the UAE list returns Neighborhood, District, City,
   * Province, Municipality, Airport and Country. An earlier filter here named
   * only city, municipality, town, borough and neighborhood, which silently
   * dropped all 47 UAE districts and all 7 emirates. Airports are excluded
   * because nobody's buyers are in one, and Country is already the default
   * option above the list.
   */
  const PLACES = /^(city|district|province|state|region|municipality|town|borough|neighborhood|county)$/i;

  const cities = (task.result || [])
    .filter((r) => r.country_iso_code === key && PLACES.test(String(r.location_type || '').trim()))
    .map((r) => ({
      name: r.location_name,
      // The trailing country is noise in a dropdown that already sits under a
      // country picker, and the middle part is the region, which is worth
      // keeping because plenty of countries repeat a city name.
      label: String(r.location_name).replace(/,[^,]*$/, ''),
      type: r.location_type
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  locationCache.set(key, { at: Date.now(), cities });
  return cities;
}

/** Transient upstream failures get this many extra attempts. */
const RETRIES = Number(process.env.ENGINE_RETRIES || 2);

/**
 * model_name is REQUIRED on every LLM Responses call, and DataForSEO reports
 * a missing required field as "Invalid Field", which is easy to misread as
 * "this field is not allowed". Omitting it breaks every engine at once.
 *
 * Rather than hard-coding names that go stale, ask DataForSEO which models
 * exist. That endpoint is free (cost: 0) and returns web_search_supported
 * per model, which matters because a model without web search returns no
 * citations, and citations are the product.
 */
const MODEL_CACHE_MS = Number(process.env.MODEL_CACHE_MS || 6 * 60 * 60 * 1000);
const modelCache = new Map(); // engine -> { model, list, at }

/** Last-resort names if the models endpoint is unreachable. */
const FALLBACK_MODEL = {
  chatgpt: 'gpt-4.1-mini',
  perplexity: 'sonar',
  claude: 'claude-sonnet-4-0',
  gemini: 'gemini-2.5-flash'
};

/**
 * Prefer a model that can search the web, is not a reasoning model (those
 * cost more and answer no better for this), and carries a stable alias
 * rather than a dated snapshot that will be retired.
 */
function scoreModel(m) {
  let score = 0;
  if (m.web_search_supported) score += 100;
  if (!m.reasoning) score += 20;
  if (!/\d{4}-\d{2}-\d{2}|\d{8}/.test(m.model_name)) score += 10;
  if (/mini|flash|haiku|small|sonar$/.test(m.model_name)) score += 8;
  return score;
}

export async function listModels(engine) {
  const cfg = ENGINES[engine];
  if (!cfg || cfg.kind !== 'llm') return [];
  const res = await fetch(`${BASE}/ai_optimization/${cfg.path}/llm_responses/models`, {
    headers: { Authorization: authHeader() }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const list = json?.tasks?.[0]?.result || [];
  if (!Array.isArray(list) || !list.length) throw new Error('No models returned');
  return list;
}

async function resolveModel(engine, cfg) {
  if (cfg.model) return cfg.model; // explicit env override always wins

  const cached = modelCache.get(engine);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.model;

  try {
    const list = await listModels(engine);
    const best = [...list].sort((a, b) => scoreModel(b) - scoreModel(a))[0];
    const model = best?.model_name || FALLBACK_MODEL[engine];
    modelCache.set(engine, { model, list, at: Date.now() });
    console.log(`Resolved ${engine} model: ${model} (from ${list.length} available)`);
    return model;
  } catch (err) {
    const model = FALLBACK_MODEL[engine];
    // Cache the fallback briefly so a broken endpoint is not hit on every call.
    modelCache.set(engine, { model, list: [], at: Date.now() - MODEL_CACHE_MS + 60000 });
    console.warn(`Could not list ${engine} models (${err.message}), falling back to ${model}`);
    return model;
  }
}

function authHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  const token = Buffer.from(`${login}:${password}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Structured parse of a task result.
 *
 * Verified against a live ChatGPT llm_responses payload (August 2026):
 *   task.result[0].items[]           type: "message"
 *     .sections[]                    type: "text", holds .text and .annotations[]
 *       .annotations[]               { title, url, start_index, end_index, text }
 *   task.result[0].fan_out_queries[] the searches the engine actually ran
 *
 * Citations come from annotations in character order, which is the order they
 * appear in the answer. The tree walk below is kept as a fallback for engines
 * whose shape differs or changes.
 */
function parseStructured(result) {
  if (!Array.isArray(result) || !result.length) return null;
  const texts = [];
  const annotations = [];
  const fanOut = [];

  for (const res of result) {
    for (const q of res.fan_out_queries || []) {
      if (typeof q === 'string' && q.trim()) fanOut.push(q.trim());
    }
    for (const item of res.items || []) {
      for (const section of item.sections || []) {
        if (typeof section.text === 'string' && section.text.trim()) {
          texts.push(section.text.trim());
        }
        for (const a of section.annotations || []) {
          if (a?.url) annotations.push({ url: a.url, title: a.title, at: a.start_index ?? 0 });
        }
      }
    }
  }

  if (!texts.length) return null;
  annotations.sort((a, b) => a.at - b.at);
  return { text: texts.join('\n\n'), annotations, fanOut };
}

/** Fallback: recursively collect plausible answer text from an arbitrary tree. */
function collectText(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const k = key.toLowerCase();
      if (typeof value === 'string' && value.trim().length > 0) {
        if (k === 'text' || k === 'content' || k === 'message' || k === 'answer') {
          out.push(value.trim());
        }
      } else {
        collectText(value, out);
      }
    }
  }
  return out;
}

/** Recursively collect URLs from url-ish keys, then fall back to a text scan. */
function collectUrls(node, out = []) {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectUrls(item, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const k = key.toLowerCase();
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
        if (k.includes('url') || k.includes('link') || k.includes('source') || k.includes('cit')) {
          out.push(value);
        }
      } else {
        collectUrls(value, out);
      }
    }
  }
  return out;
}

/**
 * Things that are never a source.
 *
 * The collector walks the whole response for keys containing "url", which
 * sweeps up the API's own envelope, image CDNs and asset hosts alongside the
 * actual citations. api.dataforseo.com appeared 873 times as a "source",
 * which is our plumbing showing through into a customer's findings.
 */
const NOT_A_SOURCE = [
  // our own infrastructure and the provider's
  'api.dataforseo.com',
  'dataforseo.com',
  'cited.ae',
  // image and asset CDNs
  'lh3.googleusercontent.com',
  'lh4.googleusercontent.com',
  'lh5.googleusercontent.com',
  'lh6.googleusercontent.com',
  'googleusercontent.com',
  'gstatic.com',
  'ggpht.com',
  'ytimg.com',
  'fbcdn.net',
  'cdninstagram.com',
  'licdn.com',
  'twimg.com',
  'w3.org',
  'schema.org'
];

/** Search and account pages are navigation, not a publisher's answer. */
const NOT_A_PAGE = [
  /^https?:\/\/(www\.)?google\.[a-z.]+\/search(\?|\/|$)/i,
  // Google's own answer viewer, which is the surface rather than a publisher.
  // Matched explicitly rather than relying on it starting with "search".
  /^https?:\/\/(www\.)?google\.[a-z.]+\/searchviewer/i,
  /^https?:\/\/(www\.)?google\.[a-z.]+\/maps/i,
  /^https?:\/\/(www\.)?google\.[a-z.]+\/?$/i,
  /^https?:\/\/(www\.)?bing\.com\/search/i,
  /\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|mp4|pdf)(\?|$)/i
];

/**
 * A Maps reference is not a publisher, but it is not noise either.
 *
 * When an answer points at a Maps listing for a competitor, the question is
 * being answered from business profiles rather than from articles. Nobody can
 * pitch a Maps listing, so it does not belong in the sources table, but it is
 * worth knowing about and is counted separately.
 */
export function isLocalListing(url) {
  return /^https?:\/\/(www\.)?google\.[a-z.]+\/(maps|searchviewer)/i.test(url);
}

export function isSourceUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (NOT_A_SOURCE.some((d) => host === d || host.endsWith(`.${d}`))) return false;
    if (NOT_A_PAGE.some((re) => re.test(url))) return false;
    return true;
  } catch {
    return false;
  }
}

function urlsFromText(text) {
  const matches = text.match(/https?:\/\/[^\s)\]<>"']+/gi) || [];
  return matches.map((u) => u.replace(/[.,;:]+$/, ''));
}

export function domainOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Engines append tracking params (?utm_source=openai). Strip them so the
 *  same page cited twice does not look like two different sources. */
function cleanUrl(url) {
  try {
    const u = new URL(url);
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'source']) {
      u.searchParams.delete(p);
    }
    u.hash = '';
    return u.toString().replace(/\?$/, '');
  } catch {
    return url.split('#')[0];
  }
}

function dedupeCitations(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const url = cleanUrl(typeof item === 'string' ? item : item.url);
    const domain = domainOf(url);
    if (!domain) continue;
    // Our plumbing, image CDNs and search pages are not sources.
    if (!isSourceUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, domain, position: out.length + 1, title: item.title || null });
  }
  return out;
}

/**
 * Ask one engine one prompt.
 * Returns { ok, text, citations: [{url, domain, position}], costUsd, model, error }
 */
/**
 * Errors worth trying again. Upstream search failures and rate limits are
 * transient; a rejected field or bad credentials will fail identically
 * however many times we ask, so those are not retried.
 */
function isTransient(result) {
  const e = String(result?.error || '');
  if (!e) return false;
  if (/Invalid Field|not authorized|40100|Unknown engine/i.test(e)) return false;
  /**
   * A rate limit is the most recoverable failure there is, and it was the one
   * we did not retry. Gemini returned rate_limit_exceeded on 260 consecutive
   * calls, every one recorded as a hard failure at full speed, and the
   * product then advised switching the engine off. Slowing down was the fix.
   */
  return /Internal SE Server Error|Task In Queue|HTTP 5\d\d|HTTP 429|rate.?limit|Service Unavailable|timeout|ECONNRESET|fetch failed/i.test(
    e
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 700 tokens was too few.
 *
 * A category question often returns a long list or a table, and the brand
 * being measured is frequently near the bottom of it. A truncated answer
 * produces a confident "not named" from a fragment, which is a measurement
 * error reported as a finding. Tokens are cheap next to the cost of a wrong
 * answer, so the ceiling is now high enough that truncation is rare.
 */
/**
 * How long to wait before trying again.
 *
 * Linear backoff is too shallow for a rate limit: the second attempt lands
 * while the window is still closed and burns another failure. This doubles,
 * and adds jitter so a batch of parallel calls does not retry in lockstep and
 * recreate the spike that caused the limit.
 */
function backoffFor(engine, attempt) {
  const base = 1200 * 2 ** attempt;
  return Math.min(base, 15000) + Math.random() * 400;
}

/**
 * An engine that just rate limited us should not be hit again immediately by
 * the next question in the cycle. Held per engine, so one struggling provider
 * does not slow the others down.
 */
const coolUntil = new Map();

export async function askEngine({ engine, prompt, market = 'AE', locationName = null, maxTokens = 2000, attempt = 0 }) {
  const cool = coolUntil.get(engine) || 0;
  if (cool > Date.now()) await sleep(cool - Date.now());
  const cfg = ENGINES[engine];
  if (!cfg) return { ok: false, text: '', citations: [], fanOut: [], costUsd: 0, error: `Unknown engine ${engine}` };

  if (MOCK) {
    // A real cycle takes minutes; mock returns instantly, which makes the
    // progress UI impossible to see or test. MOCK_DELAY_MS puts the wait back.
    const delay = Number(process.env.MOCK_DELAY_MS || 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return mockAnswer({ engine, prompt, model: cfg.model || cfg.label });
  }

  if (cfg.kind === 'serp') {
    const first = await askGoogle({ cfg, prompt, market, locationName });
    if (!isTransient(first) || attempt >= RETRIES) return first;
    // Google-side failures clear more slowly than an LLM hiccup, so back off
    // further rather than hammering the same second.
    await sleep(backoffFor(engine, attempt));
    return askEngine({ engine, prompt, market, locationName, maxTokens, attempt: attempt + 1 });
  }

  // Only send fields this endpoint accepts. Anything extra is rejected
  // outright rather than ignored, which is how a whole engine silently
  // produced zero answers for a full cycle.
  const modelName = await resolveModel(engine, cfg);

  const payload = {
    user_prompt: prompt.slice(0, 500), // API caps prompt length at 500 chars
    model_name: modelName,             // required, not optional
    max_output_tokens: maxTokens,
    temperature: 0.3,
    web_search: true
  };
  if (cfg.supportsCountry !== false) payload.web_search_country_iso_code = market;

  const body = [payload];
  const retry = async () => {
    await sleep(backoffFor(engine, attempt));
    return askEngine({ engine, prompt, market, locationName, maxTokens, attempt: attempt + 1 });
  };

  try {
    const res = await fetch(`${BASE}/ai_optimization/${cfg.path}/llm_responses/live`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const httpFail = { ok: false, text: '', citations: [], fanOut: [], costUsd: 0, model: cfg.label, error: `HTTP ${res.status}` };
      return isTransient(httpFail) && attempt < RETRIES ? retry() : httpFail;
    }

    const json = await res.json();
    const taskData = json?.tasks?.[0];
    if (!taskData || taskData.status_code >= 40000) {
      const taskFail = {
        ok: false,
        text: '',
        citations: [],
        fanOut: [],
        costUsd: Number(json?.cost || 0),
        model: cfg.label,
        error: taskData?.status_message || 'Task failed'
      };
      // A rate limit is about pace, not this particular question, so the
      // whole engine waits rather than only this call.
      if (/rate.?limit/i.test(taskFail.error || '')) {
        coolUntil.set(engine, Date.now() + Math.min(3000 * 2 ** attempt, 20000));
      }
      return isTransient(taskFail) && attempt < RETRIES ? retry() : taskFail;
    }

    const structured = parseStructured(taskData.result);
    let text;
    let citationSource;
    let fanOut = [];

    if (structured) {
      text = structured.text;
      fanOut = structured.fanOut;
      // Annotations are authoritative. Fall back to a text scan only if there are none.
      citationSource = structured.annotations.length ? structured.annotations : urlsFromText(text);
    } else {
      text = collectText(taskData.result).join('\n\n').trim();
      citationSource = [...collectUrls(taskData.result), ...urlsFromText(text)];
    }

    return {
      ok: text.length > 0,
      text,
      citations: dedupeCitations(citationSource),
      fanOut,
      costUsd: Number(json?.cost ?? taskData?.cost ?? 0),
      model: taskData?.result?.[0]?.model_name || modelName,
      error: text.length ? null : 'Empty response'
    };
  } catch (err) {
    const failure = { ok: false, text: '', citations: [], fanOut: [], costUsd: 0, model: cfg.label, error: String(err.message || err) };
    return isTransient(failure) && attempt < RETRIES ? retry() : failure;
  }
}

/**
 * Google's own AI surfaces come through the SERP API rather than the LLM
 * endpoints, so they need their own request and parse.
 *
 * An AI Overview that does not appear is a legitimate result, not a failure:
 * Google only shows one for some queries. We return ok with a flag so the
 * cycle records the absence rather than logging an error.
 */
async function askGoogle({ cfg, prompt, market, locationName = null }) {
  const isMode = cfg.mode === 'ai_mode';
  const url = isMode
    ? `${BASE}/serp/google/ai_mode/live/advanced`
    : `${BASE}/serp/google/organic/live/advanced`;

  /**
   * load_async_ai_overview asks DataForSEO to fetch the overview in a second
   * request. Turning it off stopped "Internal SE Server Error", but it also
   * stopped the overview arriving at all: a study run returned 0 usable
   * AI Overview answers from 31 prompts, which read as absence when it was
   * really a gap in the measurement.
   *
   * So it is on by default now, and the errors it brings are visible in the
   * failure report rather than hidden as silent zeros. Set
   * AI_OVERVIEW_ASYNC=false to go back to the quiet-but-empty behaviour.
   */
  const wantAsync = String(process.env.AI_OVERVIEW_ASYNC ?? 'true').toLowerCase() !== 'false';

  const body = [
    {
      keyword: prompt.slice(0, 700),
      /**
       * A city when the project set one, the country otherwise. Only the
       * Google surfaces can be placed this precisely: the LLM Responses
       * endpoints take a country code at most, and two of them reject even
       * that, which is why the setup screen says so rather than implying
       * the city applies everywhere.
       */
      location_name: locationName || LOCATIONS[market] || 'United Arab Emirates',
      language_code: 'en',
      device: 'desktop',
      ...(isMode ? {} : { depth: 10, ...(wantAsync ? { load_async_ai_overview: true } : {}) })
    }
  ];

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      return { ok: false, text: '', citations: [], fanOut: [], costUsd: 0, model: cfg.label, error: `HTTP ${res.status}` };
    }

    const json = await res.json();
    const task = json?.tasks?.[0];
    if (!task || task.status_code >= 40000) {
      return {
        ok: false, text: '', citations: [], fanOut: [],
        costUsd: Number(json?.cost || 0), model: cfg.label,
        error: task?.status_message || 'Task failed'
      };
    }

    const items = task.result?.[0]?.items || [];
    // AI Mode returns its answer as the result; organic search nests the
    // overview inside an ai_overview item alongside the blue links.
    const block = isMode
      ? { items }
      : items.find((i) => i.type === 'ai_overview') || null;

    if (!isMode && !block) {
      // A real finding: Google shows no AI Overview for this query. Distinct
      // from a request that failed, and it must not be scored as a developer
      // being absent from an answer that never existed.
      return {
        ok: true, absent: true, noOverview: true, text: '', citations: [], fanOut: [],
        costUsd: Number(json?.cost || 0), model: cfg.label,
        error: null
      };
    }

    const text = collectText(block).join('\n\n').trim();
    const urls = [...collectUrls(block), ...urlsFromText(text)];

    return {
      ok: text.length > 0,
      absent: text.length === 0,
      text,
      citations: dedupeCitations(urls),
      fanOut: [],
      costUsd: Number(json?.cost ?? task?.cost ?? 0),
      model: cfg.label,
      error: text.length ? null : 'No AI answer returned for this query'
    };
  } catch (err) {
    return { ok: false, text: '', citations: [], fanOut: [], costUsd: 0, model: cfg.label, error: String(err.message || err) };
  }
}

/* ------------------------------------------------------------------ */
/* Mock mode: run the whole product end to end without spending money. */
/* ------------------------------------------------------------------ */

const MOCK_BRANDS = [
  'Sandstorm Digital',
  'Impression',
  'Rise at Seven',
  'Builtvisible',
  'Aira',
  'Blue Array'
];

const MOCK_SOURCES = [
  'https://clutch.co/uk/agencies/digital-marketing',
  'https://www.reddit.com/r/bigseo/comments/best-uk-agencies',
  'https://www.designrush.com/agency/digital-marketing/uk',
  'https://searchengineland.com/agency-selection-guide',
  'https://uk.trustpilot.com/categories/marketing_agency',
  'https://www.sortlist.co.uk/digital-marketing'
];

function seededRandom(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Crude stand-in for the searches an engine would run. Live data is far better. */
function mockFanOut(prompt) {
  const words = prompt
    .toLowerCase()
    .replace(/[?.,!]/g, '')
    .split(' ')
    .filter((w) => w.length > 3 && !['what', 'which', 'best', 'should', 'would', 'there', 'about'].includes(w));
  return `best ${words.slice(0, 4).join(' ')} 2026`;
}

function mockAnswer({ engine, prompt, model }) {
  const rand = seededRandom(`${engine}:${prompt}:${Date.now() % 100000}`);
  const picked = MOCK_BRANDS.filter(() => rand() > 0.45).slice(0, 4);
  if (picked.length === 0) picked.push(MOCK_BRANDS[1]);

  const lines = picked.map(
    (b, i) => `${i + 1}. ${b} is often recommended here. They focus on measurable organic growth and publish case studies covering this exact area.`
  );
  const text = `Here are some options worth considering.\n\n${lines.join('\n')}\n\nIt is worth comparing scope and reporting before committing.`;

  const sourceCount = 2 + Math.floor(rand() * 3);
  const urls = MOCK_SOURCES.slice(0, sourceCount);
  if (picked.includes('Sandstorm Digital') && rand() > 0.6) {
    urls.push('https://example.com/services');
  }

  return {
    ok: true,
    text,
    citations: dedupeCitations(urls),
    fanOut: [mockFanOut(prompt)],
    costUsd: 0,
    model: `${model} (mock)`,
    error: null
  };
}

/**
 * Real AI search volume, instead of a model's guess at it.
 *
 * Question volume has been estimated by asking a language model for a number
 * between 0 and 5000, and that estimate drives the priority ordering of every
 * recommendation. DataForSEO measures the actual figure. Replacing a guess
 * that ranks the work with a measurement is the single cheapest accuracy
 * improvement available to this product.
 *
 * Live method only, and priced per keyword, so callers should batch.
 */
export async function aiKeywordVolume(keywords, { market = 'AE', language = 'en' } = {}) {
  const list = [...new Set(keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, 1000);
  if (!list.length) return new Map();

  if (MOCK) {
    // Deterministic in mock mode, so tests and demos do not drift.
    return new Map(list.map((k) => [k, { volume: 100 + (k.length * 37) % 900, source: 'mock' }]));
  }

  const body = [
    {
      keywords: list,
      location_name: LOCATIONS[market] || LOCATIONS.AE,
      language_code: language
    }
  ];

  const res = await fetch(`${BASE}/ai_optimization/ai_keyword_data/keywords_search_volume/live`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`AI keyword data failed: ${res.status}`);

  const json = await res.json();
  const task = json.tasks?.[0];
  if (task?.status_code !== 20000) {
    throw new Error(task?.status_message || 'AI keyword data returned no result');
  }

  const out = new Map();
  for (const item of task.result?.[0]?.items || []) {
    const key = String(item.keyword || '').toLowerCase();
    if (!key) continue;
    out.set(key, {
      // Named for what it is. An absent figure is not zero demand, it is a
      // keyword the corpus has not seen enough of to report.
      volume: Number.isFinite(item.ai_search_volume) ? item.ai_search_volume : null,
      source: 'dataforseo'
    });
  }

  return out;
}
