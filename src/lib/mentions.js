import 'dotenv/config';

/**
 * LLM Mentions: DataForSEO's harvested database of what AI answers already say.
 *
 * This is the opposite of a cycle. A cycle asks your questions live and pays
 * per answer. Mentions reads a pre-built corpus, so a whole category costs
 * pennies. Different economics, different cadence, so it lives on its own
 * screen and runs on demand rather than on a schedule.
 *
 * Coverage caveat worth repeating in the interface: Google AI Overview is
 * covered for all locations, ChatGPT for the United States only. For a
 * non-US market, Google is the meaningful platform here.
 */

const BASE = 'https://api.dataforseo.com/v3/ai_optimization/llm_mentions';

export const PLATFORMS = {
  google: { label: 'Google AI Overview', allLocations: true },
  chat_gpt: { label: 'ChatGPT', allLocations: false, note: 'United States only in this dataset' }
};

export const mentionsConfigured = Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);

function auth() {
  return `Basic ${Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64')}`;
}

const LOCATIONS = {
  AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', KW: 'Kuwait', BH: 'Bahrain',
  OM: 'Oman', EG: 'Egypt', GB: 'United Kingdom', US: 'United States', IN: 'India',
  DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', NL: 'Netherlands',
  CA: 'Canada', AU: 'Australia', IE: 'Ireland', ZA: 'South Africa', SG: 'Singapore'
};

async function call(path, payload) {
  const res = await fetch(`${BASE}/${path}/live`, {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify([payload])
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.status_message || `HTTP ${res.status}`);

  const task = json?.tasks?.[0];
  if (!task || task.status_code >= 40000) {
    throw new Error(task?.status_message || 'The request was rejected');
  }
  return { result: task.result || [], cost: Number(json?.cost || task?.cost || 0) };
}

/**
 * Field names differ between endpoints and have already been renamed once,
 * so read whichever of several plausible keys is present rather than binding
 * to one shape.
 */
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

function rowsOf(result) {
  // Endpoints nest their rows differently: sometimes result[0].items,
  // sometimes the result array is the rows.
  const first = result?.[0];
  if (Array.isArray(first?.items)) return first.items;
  if (Array.isArray(first?.brands)) return first.brands;
  if (Array.isArray(first?.domains)) return first.domains;
  if (Array.isArray(first?.pages)) return first.pages;
  return Array.isArray(result) ? result : [];
}

const baseParams = ({ market, platform }) => ({
  platform: PLATFORMS[platform] ? platform : 'google',
  location_name: LOCATIONS[market] || 'United States',
  language_code: 'en'
});

/**
 * Every endpoint takes `target`, and it must be an array. It accepts keywords
 * or domains, so a category phrase and a domain are both valid entries.
 */
const asTarget = (v) => (Array.isArray(v) ? v : [v]).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 20);

/**
 * A description of a business is not a keyword. "full-service digital
 * marketing agency businesses in gulf, uae, saudi..." returns nothing,
 * so reduce it to the few words someone would actually search.
 */
export function toKeyword(text, { words = 4 } = {}) {
  // These fields often repeat themselves around a separator, so take the
  // first segment and drop duplicate words rather than emitting
  // "digital marketing agency digital".
  const first = String(text || '').split(/[|\u2013\u2014;]/)[0];

  const cleaned = first
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\b(full service|full-service|leading|award winning|award-winning|specialist|specialising|specializing|businesses|companies|services|solutions|provider|providers|seeking|looking for|based in|that|which|and|the|for|with|in|of|to)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const seen = new Set();
  const unique = cleaned.split(' ').filter((w) => {
    if (!w || seen.has(w)) return false;
    seen.add(w);
    return true;
  });
  return unique.slice(0, words).join(' ');
}

/** Which brands own the conversation for a topic. */
export async function topBrands({ keywords, market, platform, limit = 25 }) {
  const { result, cost } = await call('top_mentioned_brands', {
    ...baseParams({ market, platform }),
    target: asTarget(keywords),
    limit
  });

  return {
    cost,
    rows: rowsOf(result).map((r) => ({
      name: pick(r, 'brand', 'brand_name', 'name', 'title'),
      mentions: Number(pick(r, 'mentions_count', 'mentions', 'count') || 0),
      impressions: Number(pick(r, 'impressions', 'impressions_count') || 0),
      share: Number(pick(r, 'share_of_voice', 'share', 'percentage') || 0)
    })).filter((r) => r.name)
  };
}

/** Which domains the models read when answering about this topic. */
export async function topDomains({ keywords, market, platform, limit = 25 }) {
  const { result, cost } = await call('top_mentioned_domains', {
    ...baseParams({ market, platform }),
    target: asTarget(keywords),
    limit
  });

  return {
    cost,
    rows: rowsOf(result).map((r) => ({
      domain: pick(r, 'domain', 'target', 'name'),
      mentions: Number(pick(r, 'mentions_count', 'mentions', 'count') || 0),
      citations: Number(pick(r, 'citations_count', 'citations') || 0),
      impressions: Number(pick(r, 'impressions', 'impressions_count') || 0)
    })).filter((r) => r.domain)
  };
}

/** The exact pages being cited, which are the outreach and benchmarking targets. */
export async function topPages({ keywords, market, platform, limit = 25 }) {
  const { result, cost } = await call('top_mentioned_pages', {
    ...baseParams({ market, platform }),
    target: asTarget(keywords),
    limit
  });

  return {
    cost,
    rows: rowsOf(result).map((r) => ({
      url: pick(r, 'url', 'page', 'link'),
      domain: pick(r, 'domain') || safeDomain(pick(r, 'url', 'page', 'link')),
      mentions: Number(pick(r, 'mentions_count', 'mentions', 'count') || 0),
      citations: Number(pick(r, 'citations_count', 'citations') || 0)
    })).filter((r) => r.url)
  };
}

/** You against named competitors, side by side, in one request. */
export async function compareTargets({ targets, market, platform }) {
  const { result, cost } = await call('multi_target_metrics', {
    ...baseParams({ market, platform }),
    target: asTarget(targets)
  });

  return {
    cost,
    rows: rowsOf(result).map((r) => ({
      target: pick(r, 'target', 'keyword', 'domain', 'name'),
      mentions: Number(pick(r, 'mentions_count', 'mentions', 'count') || 0),
      impressions: Number(pick(r, 'impressions', 'impressions_count') || 0),
      citations: Number(pick(r, 'citations_count', 'citations') || 0),
      share: Number(pick(r, 'share_of_voice', 'share') || 0)
    })).filter((r) => r.target)
  };
}

function safeDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * One screen's worth of data. Each part is fetched independently so a single
 * unsupported endpoint degrades that panel rather than the whole page.
 */
export async function landscape({ keywords, targets, market = 'AE', platform = 'google' }) {
  // Guard against a caller passing a sentence rather than a search term.
  keywords = asTarget(keywords).map((k) => (k.split(' ').length > 6 ? toKeyword(k) : k)).filter(Boolean);
  if (!keywords.length) throw new Error('No usable category keyword. Fill in what the business does on the Setup tab.');

  const settled = await Promise.allSettled([
    topBrands({ keywords, market, platform }),
    topDomains({ keywords, market, platform }),
    topPages({ keywords, market, platform }),
    targets?.length ? compareTargets({ targets, market, platform }) : Promise.resolve({ rows: [], cost: 0 })
  ]);

  const [brands, domains, pages, comparison] = settled.map((s) =>
    s.status === 'fulfilled' ? s.value : { rows: [], cost: 0, error: String(s.reason?.message || s.reason) }
  );

  return {
    keywordsUsed: keywords,
    platform,
    platformLabel: PLATFORMS[platform]?.label || platform,
    market,
    coverageWarning:
      platform === 'chat_gpt' && market !== 'US'
        ? 'This dataset covers ChatGPT in the United States only, so these figures do not describe your market. Use Google AI Overview instead.'
        : null,
    brands,
    domains,
    pages,
    comparison,
    cost:
      Math.round((brands.cost + domains.cost + pages.cost + comparison.cost) * 10000) / 10000
  };
}
