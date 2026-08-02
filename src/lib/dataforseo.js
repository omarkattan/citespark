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

export const ENGINES = {
  chatgpt: { path: 'chat_gpt', model: process.env.MODEL_CHATGPT || 'gpt-4.1-mini' },
  gemini: { path: 'gemini', model: process.env.MODEL_GEMINI || 'gemini-2.0-flash' },
  claude: { path: 'claude', model: process.env.MODEL_CLAUDE || 'claude-sonnet-4-5' },
  perplexity: { path: 'perplexity', model: process.env.MODEL_PERPLEXITY || 'sonar' }
};

export const MOCK = String(process.env.MOCK_MODE || '').toLowerCase() === 'true';

function authHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  const token = Buffer.from(`${login}:${password}`).toString('base64');
  return `Basic ${token}`;
}

/** Recursively collect plausible answer text from an arbitrary JSON tree. */
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

function dedupeCitations(urls) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    const domain = domainOf(url);
    if (!domain) continue;
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, domain, position: out.length + 1 });
  }
  return out;
}

/**
 * Ask one engine one prompt.
 * Returns { ok, text, citations: [{url, domain, position}], costUsd, model, error }
 */
export async function askEngine({ engine, prompt, market = 'GB', maxTokens = 700 }) {
  const cfg = ENGINES[engine];
  if (!cfg) return { ok: false, text: '', citations: [], costUsd: 0, error: `Unknown engine ${engine}` };

  if (MOCK) return mockAnswer({ engine, prompt, model: cfg.model });

  const body = [
    {
      user_prompt: prompt.slice(0, 500), // API caps prompt length at 500 chars
      model_name: cfg.model,
      max_output_tokens: maxTokens,
      temperature: 0.3,
      web_search: true,
      web_search_country_iso_code: market
    }
  ];

  try {
    const res = await fetch(`${BASE}/ai_optimization/${cfg.path}/llm_responses/live`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      return { ok: false, text: '', citations: [], costUsd: 0, model: cfg.model, error: `HTTP ${res.status}` };
    }

    const json = await res.json();
    const task = json?.tasks?.[0];
    if (!task || task.status_code >= 40000) {
      return {
        ok: false,
        text: '',
        citations: [],
        costUsd: Number(json?.cost || 0),
        model: cfg.model,
        error: task?.status_message || 'Task failed'
      };
    }

    const textParts = collectText(task.result);
    const text = textParts.join('\n\n').trim();
    const urls = [...collectUrls(task.result), ...urlsFromText(text)];

    return {
      ok: text.length > 0,
      text,
      citations: dedupeCitations(urls),
      costUsd: Number(json?.cost || task?.cost || 0),
      model: cfg.model,
      error: text.length ? null : 'Empty response'
    };
  } catch (err) {
    return { ok: false, text: '', citations: [], costUsd: 0, model: cfg.model, error: String(err.message || err) };
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
    urls.push('https://sandstormdigital.com/services/seo');
  }

  return {
    ok: true,
    text,
    citations: dedupeCitations(urls),
    costUsd: 0,
    model: `${model} (mock)`,
    error: null
  };
}
