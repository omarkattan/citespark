import 'dotenv/config';
import { complete, parseJsonArray } from './anthropic.js';

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

/**
 * Measured, not estimated: $0.20 per call. Two orders of magnitude more than
 * the LLM Mentions row pricing suggested, so every call here is deliberate
 * and results are cached hard.
 */
export const CALL_COST = Number(process.env.MENTIONS_CALL_COST || 0.2);

/**
 * Platforms and reference sites that appear in every category and tell you
 * nothing about who leads it. Kept narrow on purpose: a directory like
 * clutch.co is noise in a brand ranking but a real finding as a source.
 */
const NOT_A_BRAND = /^(www\.)?(youtube|google|facebook|instagram|linkedin|twitter|x|tiktok|reddit|quora|wikipedia|wikiwand|medium|pinterest|amazon|apple|play\.google|m\.youtube|en\.wikipedia|ar\.wikipedia)\./i;

const strip = (d) => String(d || '').replace(/^www\./, '').toLowerCase();

/**
 * Turn a domain into something readable. Imperfect by nature, so the domain
 * is always kept alongside for anyone who wants to check.
 */
export function brandFromDomain(domain) {
  const base = strip(domain).split('.')[0];
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
}

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
 * Every endpoint takes `target`, an array of objects. A plain string is
 * rejected with "Each 'target' item must be an object", and a missing array
 * with "Field 'target' is missing or has an invalid type".
 *
 * Anything that looks like a hostname is sent as a domain, everything else as
 * a keyword. TARGET_KEY exists because the exact property name is not pinned
 * down in the docs; run `npm run probe` to confirm it against your account.
 */
const KEYWORD_KEY = process.env.MENTIONS_KEYWORD_KEY || 'keyword';
const DOMAIN_KEY = process.env.MENTIONS_DOMAIN_KEY || 'domain';

const looksLikeDomain = (s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) && !s.includes(' ');

const asTarget = (v) =>
  (Array.isArray(v) ? v : [v])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((t) => (looksLikeDomain(t) ? { [DOMAIN_KEY]: t } : { [KEYWORD_KEY]: t }));

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

/**
 * Domains make ugly brand names: "Emiratesnbd", "Bankfab", "Adcb". One cheap
 * model call per category turns them into what people actually call these
 * companies, falling back to the naive form when unavailable.
 */
export async function nameBrands(rows) {
  if (!rows.length) return rows;

  const raw = await complete(
    `Give the real, commonly used name of the company behind each domain. Keep the order.\n\n` +
      rows.map((r, i) => `${i}. ${r.domain}`).join('\n'),
    {
      system:
        'You map domains to the brand names people actually use. Return ONLY a JSON array of {"index": number, "name": string}. ' +
        'Use the name a customer would say out loud, correctly capitalised, including well-known abbreviations such as ADCB or HSBC. ' +
        'If you do not recognise a domain, omit it rather than guessing.',
      maxTokens: 1200
    }
  );

  const parsed = parseJsonArray(raw);
  if (!parsed) return rows;

  const named = new Map(parsed.filter((p) => p?.name).map((p) => [Number(p.index), String(p.name).trim()]));
  return rows.map((r, i) => ({ ...r, name: named.get(i) || r.name }));
}

/**
 * The response shape, confirmed against a live call:
 *
 *   result[0].total_count                       how many domains matched
 *   result[0].aggregated_metrics.sources_domain top cited domains overall
 *   result[0].items[].domain                    one row per mentioned domain
 *   result[0].items[].total.mentions            and its volume
 *
 * brand_entities_title comes back empty, so there is no separate brand list
 * to read. The domains are the brands, which is what the aggregate shows.
 */
function readDomainsResponse(result) {
  const first = result?.[0] || {};
  const agg = first.aggregated_metrics || {};

  const sources = (agg.sources_domain || []).map((r) => ({
    domain: strip(r.key),
    mentions: Number(r.mentions || 0),
    aiSearchVolume: Number(r.ai_search_volume || 0)
  }));

  const items = (first.items || []).map((r) => ({
    domain: strip(r.domain),
    mentions: Number(r.total?.mentions || 0),
    aiSearchVolume: Number(r.total?.ai_search_volume || 0)
  }));

  return {
    totalCount: Number(first.total_count || 0),
    totalMentions: Number(agg.total?.mentions || 0),
    totalVolume: Number(agg.total?.ai_search_volume || 0),
    sources,
    items
  };
}

/**
 * One call answers both questions the landscape asks. The aggregate names the
 * sources shaping the category; the items, once platforms are filtered out,
 * name the brands. At twenty cents a call that matters.
 */
export async function categoryPicture({ keyword, market, platform = 'google', limit = 100 }) {
  const { result, cost } = await call('top_mentioned_domains', {
    ...baseParams({ market, platform }),
    target: asTarget(keyword),
    limit
  });

  const parsed = readDomainsResponse(result);

  // Merge the aggregate and the per-domain rows: the aggregate is ranked by
  // how often a domain is cited, the items by how often it is mentioned.
  const merged = new Map();
  for (const r of [...parsed.sources, ...parsed.items]) {
    if (!r.domain) continue;
    const prev = merged.get(r.domain) || { domain: r.domain, mentions: 0, aiSearchVolume: 0 };
    prev.mentions = Math.max(prev.mentions, r.mentions);
    prev.aiSearchVolume = Math.max(prev.aiSearchVolume, r.aiSearchVolume);
    merged.set(r.domain, prev);
  }

  const all = [...merged.values()].sort((a, b) => b.mentions - a.mentions);
  const brands = all
    .filter((r) => !NOT_A_BRAND.test(r.domain))
    .map((r) => ({ name: brandFromDomain(r.domain), domain: r.domain, mentions: r.mentions, aiSearchVolume: r.aiSearchVolume }));

  const totalBrandMentions = brands.reduce((n, b) => n + b.mentions, 0) || 1;
  const named = await nameBrands(brands.slice(0, 25));

  return {
    cost,
    keyword,
    totalCount: parsed.totalCount,
    totalMentions: parsed.totalMentions,
    totalVolume: parsed.totalVolume,
    brands: named.map((b) => ({ ...b, share: Math.round((b.mentions / totalBrandMentions) * 1000) / 10 })),
    domains: all,
    excluded: all.filter((r) => NOT_A_BRAND.test(r.domain)).map((r) => r.domain)
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
export async function landscape({ keywords, market = 'AE', platform = 'google' }) {
  const list = (Array.isArray(keywords) ? keywords : [keywords])
    .map((k) => String(k || '').trim())
    .map((k) => (k.split(' ').length > 6 ? toKeyword(k) : k))
    .filter((k) => k.length > 2);

  if (!list.length) throw new Error('No usable category keyword. Fill in what the business does on the Setup tab.');

  // One call per keyword, and each costs real money, so cap it.
  const picked = list.slice(0, 2);
  const results = await Promise.allSettled(
    picked.map((k) => categoryPicture({ keyword: k, market, platform }))
  );

  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const errors = results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
  if (!ok.length) throw new Error(errors[0] || 'No data returned for this category');

  // Combine keywords by taking the highest reading per domain.
  const brands = new Map();
  const domains = new Map();
  for (const r of ok) {
    for (const b of r.brands) {
      const prev = brands.get(b.domain);
      if (!prev || b.mentions > prev.mentions) brands.set(b.domain, b);
    }
    for (const d of r.domains) {
      const prev = domains.get(d.domain);
      if (!prev || d.mentions > prev.mentions) domains.set(d.domain, d);
    }
  }

  return {
    keywordsUsed: picked,
    platform,
    platformLabel: PLATFORMS[platform]?.label || platform,
    market,
    coverageWarning:
      platform === 'chat_gpt' && market !== 'US'
        ? 'This dataset covers ChatGPT in the United States only, so these figures do not describe your market. Use Google AI Overview instead.'
        : null,
    brands: [...brands.values()].sort((a, b) => b.mentions - a.mentions),
    domains: [...domains.values()].sort((a, b) => b.mentions - a.mentions),
    totalMentions: Math.max(...ok.map((r) => r.totalMentions), 0),
    totalCount: Math.max(...ok.map((r) => r.totalCount), 0),
    errors,
    cost: Math.round(ok.reduce((n, r) => n + (r.cost || 0), 0) * 10000) / 10000
  };
}

