import { one, query } from '../db/index.js';

/**
 * Follow a citation back to whoever actually published it.
 *
 * Google's AI surfaces do not cite publishers directly. They cite
 * vertexaisearch.cloud.google.com/grounding-api-redirect/..., which bounces to
 * the real page. Stored as-is, every Google citation is attributed to Google:
 * one invented source with an enormous count, and every genuine publisher
 * missing. "vertexaisearch.cloud.google.com shapes 53 of your questions" is
 * not a finding, it is a bug wearing one.
 */

/** Wrappers that stand between the answer and the page it came from. */
const WRAPPERS = [
  'vertexaisearch.cloud.google.com',
  'www.google.com/url',
  'google.com/url',
  'r.search.yahoo.com',
  'duckduckgo.com/l',
  'www.bing.com/ck',
  'bing.com/ck',
  'l.facebook.com',
  't.co',
  'lnkd.in'
];

export function isWrapper(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const hostPath = `${host}${u.pathname}`;
    return WRAPPERS.some((w) => host === w || hostPath.startsWith(w));
  } catch {
    return false;
  }
}

/**
 * Some wrappers carry the destination in a query parameter, which costs
 * nothing to read. Worth trying before any network call.
 */
function fromQuery(url) {
  try {
    const u = new URL(url);
    for (const key of ['url', 'q', 'u', 'target', 'uddg']) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
  } catch {
    /* not a URL we can read */
  }
  return null;
}

/**
 * Ask the wrapper where it goes, without downloading the page.
 *
 * Deliberately does not follow the chain automatically: we want the first
 * real destination, and an unbounded chain is somebody else's redirect loop.
 */
/**
 * Google serves these differently depending on who is asking. Without a
 * browser user agent the redirector answers 403 and no Location header, which
 * looks identical to a dead link.
 */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9'
};

/** Pull a destination out of a page that redirects with markup or script. */
function fromBody(body) {
  const patterns = [
    /<meta[^>]+http-equiv=['"]?refresh['"]?[^>]+url=['"]?(https?:\/\/[^'"\s>]+)/i,
    /window\.location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/i,
    /location\.replace\(\s*['"](https?:\/\/[^'"]+)['"]/i,
    /<link[^>]+rel=['"]?canonical['"]?[^>]+href=['"](https?:\/\/[^'"]+)['"]/i
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m?.[1] && !isWrapper(m[1])) return m[1];
  }
  return null;
}

async function fromRedirect(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let lastStatus = null;

  try {
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: BROWSER_HEADERS,
        signal: controller.signal
      });
      lastStatus = res.status;

      const next = res.headers.get('location');
      if (next) {
        const abs = new URL(next, url).toString();
        if (!isWrapper(abs)) return { target: abs };
        url = abs;
        continue;
      }

      // Some wrappers bounce with markup or script rather than a header.
      const body = await res.text().catch(() => '');
      const found = fromBody(body);
      if (found) return { target: found };

      return { target: null, reason: `HTTP ${res.status}, no redirect in the response` };
    }
    return { target: null, reason: 'too many hops' };
  } catch (err) {
    return { target: null, reason: err.name === 'AbortError' ? 'timed out' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve one URL, remembering the answer.
 *
 * The same grounding link appears across many answers, and asking Google
 * where it goes fifty times for one page is rude and slow.
 */
export async function resolveUrl(url, { retryFailures = true } = {}) {
  if (!url || !isWrapper(url)) return { url, resolved: false };

  /**
   * A success is remembered forever; a failure only briefly.
   *
   * Caching failures permanently meant one bad afternoon, or one missing
   * header, froze a link as unresolvable for good. Nothing would ever try
   * again, and the wrapper would sit in the data looking like a real source.
   */
  const cached = await one(
    `SELECT target, resolved_at FROM url_resolutions WHERE source = $1`,
    [url]
  ).catch(() => null);

  if (cached?.target) return { url: cached.target, resolved: true, cached: true };

  if (cached && !retryFailures) return { url, resolved: false, cached: true, reason: cached.reason };

  if (cached && Date.now() - new Date(cached.resolved_at).getTime() < 6 * 3600_000) {
    return { url, resolved: false, cached: true };
  }

  const direct = fromQuery(url);
  const { target, reason } = direct ? { target: direct } : await fromRedirect(url);

  await query(
    `INSERT INTO url_resolutions (source, target, reason) VALUES ($1, $2, $3)
     ON CONFLICT (source) DO UPDATE SET target = EXCLUDED.target, reason = EXCLUDED.reason, resolved_at = now()`,
    [url, target, reason || null]
  ).catch(() => {});

  return { url: target || url, resolved: Boolean(target), reason };
}

/** Resolve a batch, in small groups so we are not hammering anyone. */
export async function resolveAll(urls, { concurrency = 4 } = {}) {
  const out = new Map();
  const queue = [...new Set(urls.filter(isWrapper))];

  async function worker() {
    while (queue.length) {
      const u = queue.shift();
      const r = await resolveUrl(u);
      out.set(u, r);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}
