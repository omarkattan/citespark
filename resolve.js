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
async function fromRedirect(url, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
      const next = res.headers.get('location');
      if (!next) {
        // Some wrappers bounce with a meta refresh or a script instead of a
        // header, so the body is worth a look before giving up.
        const body = await res.text().catch(() => '');
        const meta = body.match(/url=['"]?(https?:\/\/[^'"\s>]+)/i);
        return meta?.[1] || null;
      }
      const abs = new URL(next, url).toString();
      if (!isWrapper(abs)) return abs;
      url = abs;
    }
    return null;
  } catch {
    return null;
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
export async function resolveUrl(url) {
  if (!url || !isWrapper(url)) return { url, resolved: false };

  const cached = await one('SELECT target FROM url_resolutions WHERE source = $1', [url]).catch(() => null);
  if (cached) return { url: cached.target || url, resolved: Boolean(cached.target), cached: true };

  const target = fromQuery(url) || (await fromRedirect(url));

  await query(
    `INSERT INTO url_resolutions (source, target) VALUES ($1, $2)
     ON CONFLICT (source) DO UPDATE SET target = EXCLUDED.target, resolved_at = now()`,
    [url, target]
  ).catch(() => {});

  return { url: target || url, resolved: Boolean(target) };
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
