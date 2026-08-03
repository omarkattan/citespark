import { complete, parseJsonArray } from './anthropic.js';

/**
 * Read a homepage and work out what to put in the setup fields.
 *
 * Two stages. First a plain HTML read for the things that are stated
 * outright: title, meta description, og tags, JSON-LD Organization.
 * Then, if a key is present, Claude turns that into the fields we
 * actually need, most importantly the customer description, which is
 * never written down anywhere but is what makes the questions good.
 */

/**
 * Identify honestly by default. Many sites block anything that looks like a
 * bot, though, so if the polite attempt is refused we escalate rather than
 * pretending to be a browser from the start.
 */
const UA = 'Mozilla/5.0 (compatible; CitedBot/1.0; +https://cited.ae/bot)';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'no-cache'
};

export function normaliseDomain(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9.-]/g, '');
}

async function tryFetch(url, headers, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!res.ok) return { blocked: res.status === 403 || res.status === 429 || res.status >= 500, status: res.status };
    const html = await res.text();
    if (html.length < 200) return { blocked: false, status: res.status };
    return { html, finalUrl: res.url, status: res.status };
  } catch (err) {
    return { blocked: /abort|timeout/i.test(String(err.message)), error: String(err.message) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stage two: DataForSEO's OnPage API. It renders JavaScript and comes from
 * addresses sites do not block, and we are already paying for it, so this is
 * cheaper and simpler than adding a separate rendering vendor.
 */
async function fetchViaDataForSeo(target, { fullUrl = false } = {}) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return null;
  const url = fullUrl ? target : `https://${target}`;

  try {
    const res = await fetch('https://api.dataforseo.com/v3/on_page/instant_pages', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([
        {
          url,
          enable_javascript: true,
          enable_browser_rendering: true,
          load_resources: false,
          custom_user_agent: BROWSER_UA
        }
      ])
    });
    if (!res.ok) return null;
    const json = await res.json();
    const item = json?.tasks?.[0]?.result?.[0]?.items?.[0];
    if (!item) return null;

    // Structured metadata is enough on its own, and is more reliable than
    // trying to reconstruct HTML we were never given.
    const meta = item.meta || {};
    const checks = item.checks || {};
    return {
      structured: {
        title: meta.title || null,
        description: meta.description || null,
        h1: (meta.htags?.h1 || [])[0] || null,
        h2s: (meta.htags?.h2 || []).slice(0, 20),
        h3s: (meta.htags?.h3 || []).slice(0, 20),
        // The renderer does not hand back raw HTML, but it does report
        // whether structured data is present and how big the page is.
        hasMicromarkup: Boolean(checks.has_micromarkup),
        wordCount: meta.content?.plain_text_word_count || null,
        body: [meta.title, meta.description, ...(meta.htags?.h1 || []), ...(meta.htags?.h2 || []),
               ...(meta.htags?.h3 || [])].filter(Boolean).join('. ').slice(0, 3000)
      },
      finalUrl: item.url || url
    };
  } catch {
    return null;
  }
}

/** Stage three: an optional headless browser, if one is configured. */
async function fetchViaBrowserless(domain) {
  const endpoint = process.env.BROWSERLESS_URL;
  const token = process.env.BROWSERLESS_TOKEN;
  if (!endpoint) return null;

  try {
    const url = token ? `${endpoint}/content?token=${token}` : `${endpoint}/content`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `https://${domain}`,
        gotoOptions: { waitUntil: 'domcontentloaded', timeout: 20000 }
      })
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html.length > 200 ? { html, finalUrl: `https://${domain}` } : null;
  } catch {
    return null;
  }
}

/**
 * Read a homepage, escalating only as far as needed:
 *   1. a polite identified request
 *   2. the same request looking like a normal browser
 *   3. DataForSEO's renderer, which handles JavaScript and bot blocking
 *   4. a headless browser, if BROWSERLESS_URL is set
 */
/**
 * Fetch any URL with the same escalating strategy, for callers that need a
 * specific page rather than a homepage.
 */
export async function fetchPage(url) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return null;

  const polite = await tryFetch(clean, { 'User-Agent': UA, Accept: 'text/html' }, 12000);
  if (polite.html) return { ...polite, via: 'direct' };

  const browser = await tryFetch(clean, BROWSER_HEADERS, 15000);
  if (browser.html) return { ...browser, via: 'browser-headers' };

  // The renderer is the fallback that actually works on blocked pages, and
  // leaving it out of this path was why most teardowns failed to read.
  const dfs = await fetchViaDataForSeo(clean, { fullUrl: true });
  if (dfs) return { ...dfs, via: 'dataforseo' };

  const bl = await fetchViaBrowserless(clean.replace(/^https?:\/\//, ''));
  if (bl) return { ...bl, via: 'browserless' };

  return null;
}

async function fetchHtml(domain) {
  const forms = [`https://${domain}`, `https://www.${domain}`, `http://${domain}`];

  for (const url of forms) {
    const r = await tryFetch(url, { 'User-Agent': UA, Accept: 'text/html' }, 12000);
    if (r.html) return { ...r, via: 'direct' };
  }

  for (const url of forms.slice(0, 2)) {
    const r = await tryFetch(url, BROWSER_HEADERS, 15000);
    if (r.html) return { ...r, via: 'browser-headers' };
  }

  const dfs = await fetchViaDataForSeo(domain);
  if (dfs) return { ...dfs, via: 'dataforseo' };

  const bl = await fetchViaBrowserless(domain);
  if (bl) return { ...bl, via: 'browserless' };

  return null;
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&ndash;': '-', '&mdash;': '-', '&hellip;': '...', '&pound;': '\u00a3',
  '&euro;': '\u20ac', '&trade;': '\u2122', '&reg;': '\u00ae', '&copy;': '\u00a9'
};

function decode(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ');
}

function tag(html, re) {
  const m = re.exec(html);
  return m ? decode(m[1]).trim().replace(/\s+/g, ' ') : null;
}

function jsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  const out = [];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // malformed JSON-LD is extremely common, skip it
    }
  }
  return out;
}

function visibleText(html) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decode(stripped).replace(/\s+/g, ' ').trim();
}

function emptySignals() {
  return {
    title: null, description: null, ogSiteName: null, ogDescription: null,
    h1: null, h2s: [], schemaName: null, schemaType: null, schemaDescription: null,
    schemaArea: null, address: null, sameAs: [], body: ''
  };
}

/** Everything the page states about itself, before any inference. */
export function readSignals(html) {
  const ld = jsonLd(html);
  const org = ld.find((n) => /Organization|LocalBusiness|Corporation|ProfessionalService/i.test(n?.['@type'] || ''));

  return {
    title: tag(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description: tag(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i),
    ogSiteName: tag(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i),
    ogDescription: tag(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i),
    h1: tag(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)?.replace(/<[^>]+>/g, ''),
    h2s: [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)]
      .map((m) => decode(m[1].replace(/<[^>]+>/g, '')).trim())
      .filter(Boolean)
      .slice(0, 8),
    schemaName: org?.name || null,
    schemaType: org?.['@type'] || null,
    schemaDescription: org?.description || null,
    schemaArea: org?.areaServed?.name || org?.areaServed || null,
    address: org?.address?.addressLocality || org?.address?.addressRegion || null,
    sameAs: Array.isArray(org?.sameAs) ? org.sameAs.slice(0, 8) : [],
    body: visibleText(html).slice(0, 3000)
  };
}

/** Brand name without the tagline, from whatever the page offers. */
function guessBrand(signals, domain) {
  if (signals.schemaName) return signals.schemaName;
  if (signals.ogSiteName) return signals.ogSiteName;
  if (signals.title) {
    const parts = signals.title.split(/[|\u2013\u2014-]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      // The brand is usually the shortest segment, not the keyword-stuffed one.
      return parts.reduce((a, b) => (b.length < a.length ? b : a));
    }
    return signals.title;
  }
  const base = domain.split('.')[0].replace(/[-_]/g, ' ');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const SYSTEM = `You read a company's homepage and fill in a short setup form. Return ONLY a JSON array with exactly one object, no prose, no markdown fences.

{
  "brandName": string,        // what customers call them, no tagline, no legal suffix unless they always use it
  "aliases": string[],        // other names people use, including shortenings and the legal name. Empty array if none.
  "category": string,         // what the business does, 2 to 6 words, lowercase, e.g. "seo and digital marketing agency"
  "qualifier": string,        // who the customer is, specific, e.g. "uk ecommerce brands turning over 1m to 20m"
  "market": string,           // ISO 3166-1 alpha-2 country code of their main market
  "competitors": [{"name": string, "domain": string}]  // up to 5 genuine direct competitors you are confident exist. Empty array if unsure.
}

Rules:
- qualifier is the most important field. Be specific about sector, size and location. Never write "small business" if the page gives you anything better.
- Only list competitors you actually know exist with the correct domain. An empty array is far better than an invented one.
- Infer market from addresses, currency, phone format or spelling.`;

export async function discoverSite(domainInput) {
  const domain = normaliseDomain(domainInput);
  if (!domain.includes('.')) return { ok: false, error: 'Enter a domain, for example yourcompany.com' };

  const fetched = await fetchHtml(domain);
  if (!fetched) {
    return {
      ok: false,
      domain,
      manual: true,
      error:
        'We could not read that site. It may be blocking automated requests, or behind a login. ' +
        'Fill the fields in by hand and everything else works the same.'
    };
  }

  const signals = fetched.html
    ? readSignals(fetched.html)
    : { ...emptySignals(), ...fetched.structured, sameAs: [] };

  const fallback = {
    brandName: guessBrand(signals, domain),
    aliases: [],
    category: 'business',
    qualifier: 'small business',
    market: 'GB',
    competitors: []
  };

  const brief = [
    `Domain: ${domain}`,
    signals.title && `Title: ${signals.title}`,
    signals.description && `Meta description: ${signals.description}`,
    signals.schemaName && `Schema name: ${signals.schemaName} (${signals.schemaType})`,
    signals.schemaDescription && `Schema description: ${signals.schemaDescription}`,
    signals.address && `Address locality: ${signals.address}`,
    signals.h1 && `H1: ${signals.h1}`,
    signals.h2s.length && `H2s: ${signals.h2s.join(' | ')}`,
    signals.body && `Page text: ${signals.body}`
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await complete(brief, { system: SYSTEM, maxTokens: 900 });
  const parsed = parseJsonArray(raw)?.[0];

  if (!parsed || typeof parsed.brandName !== 'string') {
    return { ok: true, domain, via: fetched.via, source: 'page', confident: false, ...fallback, signals: summarise(signals) };
  }

  return {
    ok: true,
    domain,
    via: fetched.via,
    source: 'page+model',
    confident: true,
    brandName: parsed.brandName.trim() || fallback.brandName,
    aliases: Array.isArray(parsed.aliases) ? parsed.aliases.map(String).filter(Boolean).slice(0, 6) : [],
    category: String(parsed.category || fallback.category).trim(),
    qualifier: String(parsed.qualifier || fallback.qualifier).trim(),
    market: /^[A-Za-z]{2}$/.test(parsed.market || '') ? parsed.market.toUpperCase() : 'GB',
    competitors: Array.isArray(parsed.competitors)
      ? parsed.competitors
          .filter((c) => c?.name)
          .map((c) => ({ name: String(c.name).trim(), domain: normaliseDomain(c.domain) }))
          .slice(0, 5)
      : [],
    signals: summarise(signals)
  };
}

function summarise(s) {
  return {
    title: s.title,
    description: s.description,
    schemaName: s.schemaName,
    schemaType: s.schemaType,
    hasOrganizationSchema: Boolean(s.schemaName),
    sameAsCount: s.sameAs.length
  };
}
