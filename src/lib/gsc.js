import 'dotenv/config';
import { one, many, query } from '../db/index.js';
import { decrypt } from './tokens.js';
import { complete, parseJsonArray } from './anthropic.js';

/**
 * Search Console as the source of truth for what people actually ask.
 *
 * Until now the tracked questions were written by a model from a description
 * of the business, and their estimated volume was a guess. GSC replaces the
 * guess with measured demand: real queries, real impressions, real positions.
 *
 * Two kinds of query are useful, and they need different handling:
 *
 *   Already conversational ("how much does seo cost in dubai") can be tracked
 *   more or less as they are.
 *
 *   Head terms ("seo agency dubai") carry the demand but not the phrasing, so
 *   they are turned into the question a buyer would type into an assistant.
 */

const API = 'https://www.googleapis.com/webmasters/v3';

/** Actually phrased as a question, which is what an assistant receives. */
const ASKED = /^(who|what|which|when|where|why|how|is|are|can|should|does|do)\b/i;
/** Carries buying intent but written as a keyword. */
const INTENT = /\b(vs|versus|compared to|alternative|best|top|cheapest|near me|cost|price|worth it|reviews?)\b/i;

/** Question-shaped, in the sense that matters for an answer engine. */
const QUESTION_MARKERS = new RegExp(`${ASKED.source}|${INTENT.source}`, 'i');

/**
 * How close a query already is to something a person would type into a chat
 * window. A fully phrased question beats a keyword with buying intent, which
 * beats a bare head term, regardless of which has more impressions.
 */
function conversational(q) {
  if (ASKED.test(q)) return 2;
  if (INTENT.test(q)) return 1;
  return 0;
}

/**
 * Search Console's own credential, falling back to the shared one.
 *
 * Analytics and Search Console are routinely owned by different people in an
 * agency, and a single token meant connecting one replaced the other. Sites
 * connected before this keep working: with no Search Console token of its
 * own, a project uses the Analytics one exactly as it did.
 */
export async function accessTokenFor(project) {
  const own = project?.gsc_refresh_token ? decrypt(project.gsc_refresh_token) : null;
  const shared = project?.ga4_refresh_token ? decrypt(project.ga4_refresh_token) : null;
  const refresh = own || shared || process.env.GOOGLE_REFRESH_TOKEN;
  if (!refresh) throw new Error('Google is not connected for this site');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token'
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || 'Could not refresh the Google authorisation');
  return json.access_token;
}

/**
 * Properties the connected account can read.
 *
 * A 403 here has three quite different causes and they need different fixes,
 * so read what Google actually said rather than assuming the common one.
 */
export async function listSites(project) {
  const token = await accessTokenFor(project);
  const res = await fetch(`${API}/sites`, { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || '';
    } catch {
      // no JSON body, fall back to the status alone
    }

    if (/has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(detail)) {
      const m = detail.match(/project\s+(\d{6,})/);
      throw Object.assign(
        new Error(
          'The Search Console API is not enabled in your Google Cloud project. Enable it, wait a minute, then try again. ' +
            'Reconnecting will not help until it is on.'
        ),
        {
          fix: 'enable-api',
          link: m
            ? `https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=${m[1]}`
            : 'https://console.cloud.google.com/apis/library/searchconsole.googleapis.com',
          detail
        }
      );
    }

    if (res.status === 403 || /insufficient|scope|permission/i.test(detail)) {
      throw Object.assign(
        new Error(
          'This Google connection does not include Search Console. Add the webmasters.readonly scope on your OAuth consent screen first, then reconnect.'
        ),
        { fix: 'reconnect', detail }
      );
    }

    if (res.status === 401) {
      throw Object.assign(new Error('That Google authorisation has expired. Reconnect the account.'), { fix: 'reconnect' });
    }

    throw new Error(detail || `Could not list Search Console properties: ${res.status}`);
  }

  const json = await res.json();
  return (json.siteEntry || [])
    .filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
    .map((s) => ({ url: s.siteUrl, permission: s.permissionLevel }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

/** Raw query rows for the period. */
export async function fetchQueries(project, { days = 90, limit = 2000 } = {}) {
  const site = project.gsc_site_url;
  if (!site) throw new Error('No Search Console property chosen for this site');

  const token = await accessTokenFor(project);
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const res = await fetch(`${API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDate: iso(start),
      endDate: iso(end),
      dimensions: ['query'],
      rowLimit: limit,
      dataState: 'final'
    })
  });
  if (!res.ok) throw new Error(`Search Console query failed: ${res.status}`);

  const json = await res.json();
  return (json.rows || []).map((r) => ({
    query: r.keys[0],
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    position: r.position
  }));
}

/**
 * Group queries that are really the same intent, so twenty variations of one
 * question do not become twenty tracked questions.
 */
const STOP = new Set(['the','a','an','in','for','to','of','and','or','with','my','your','is','are','do','does','best','top','near','me','uae','dubai']);

function fingerprint(q) {
  return [...new Set(
    q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
  )].sort().join(' ');
}

export function cluster(rows, { minImpressions = 5, brand = '' } = {}) {
  const groups = new Map();
  // Branded searches are people who already know you. Tracking them measures
  // nothing, since the questions deliberately exclude the brand name.
  const brandWords = String(brand).toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const isBranded = (q) => brandWords.length > 0 && brandWords.every((w) => q.toLowerCase().includes(w));

  for (const row of rows) {
    if (row.impressions < minImpressions) continue;
    if (isBranded(row.query)) continue;
    const words = fingerprint(row.query).split(' ').filter(Boolean);
    if (!words.length) continue;

    // Match against an existing cluster on shared distinctive terms.
    let target = null;
    for (const [key, g] of groups) {
      const keyWords = key.split(' ');
      const shared = words.filter((w) => keyWords.includes(w)).length;
      if (shared >= Math.min(2, Math.min(words.length, keyWords.length))) {
        target = g;
        break;
      }
    }

    if (!target) {
      target = { key: words.join(' '), queries: [], impressions: 0, clicks: 0, positionSum: 0 };
      groups.set(words.join(' '), target);
    }
    target.queries.push(row);
    target.impressions += row.impressions;
    target.clicks += row.clicks;
    target.positionSum += row.position * row.impressions;
  }

  return [...groups.values()]
    .map((g) => {
      const queries = [...g.queries].sort((a, b) => b.impressions - a.impressions);

      // Prefer the most conversational variant with meaningful demand, even
      // when a bare keyword has more impressions. "how much do aligners cost
      // in dubai" is a better prompt than "clear aligners dubai cost", and
      // sorting on impressions alone buried it.
      const viable = queries.filter((q) => q.impressions >= g.impressions * 0.15);
      const head = [...(viable.length ? viable : queries)].sort(
        (a, b) => conversational(b.query) - conversational(a.query) || b.impressions - a.impressions
      )[0];

      return {
        queries,
        head: head.query,
        headImpressions: head.impressions,
        impressions: g.impressions,
        clicks: g.clicks,
        avgPosition: g.impressions ? g.positionSum / g.impressions : null,
        isQuestion: QUESTION_MARKERS.test(head.query),
        conversational: conversational(head.query),
        variants: queries.length
      };
    })
    .sort((a, b) => b.impressions - a.impressions);
}

const SYSTEM = `You turn Google Search Console queries into the questions a buyer would type into an AI assistant.

For each cluster you are given the highest-impression query, some variants, and how many impressions it gets.

Rules:
- Write the question exactly as a person would type it into ChatGPT: a full sentence, 8 to 20 words.
- Never include the brand's own name. We are measuring unprompted recall.
- Keep the intent of the original query. A query about price becomes a price question, not a generic "best" question.
- Keep location and sector qualifiers that appear in the queries.
- If a cluster is navigational, branded, or too vague to make a sensible buyer question, omit it entirely.

Return ONLY a JSON array: [{"index": number, "text": string}]
The index refers to the cluster number you were given. Omit clusters you are skipping.`;

/**
 * Turn clusters into tracked questions. Real impressions become the volume
 * figure, which is what the priority scoring keys off.
 */
export async function proposeFromClusters(clusters, { brand, market } = {}) {
  const top = clusters.slice(0, 30);

  const listing = top
    .map(
      (c, i) =>
        `${i}. "${c.head}" (${c.impressions} impressions, ${c.clicks} clicks, avg position ${c.avgPosition?.toFixed(1)})` +
        (c.variants > 1 ? ` also: ${c.queries.slice(1, 4).map((q) => q.query).join(', ')}` : '')
    )
    .join('\n');

  const raw = await complete(
    `Brand: ${brand}\nMarket: ${market}\n\nClusters:\n${listing}`,
    { system: SYSTEM, maxTokens: 2000 }
  );
  const parsed = parseJsonArray(raw);

  const out = [];
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    const written = parsed?.find((p) => Number(p.index) === i)?.text;

    // Without a model, keep queries that already read as questions and skip
    // the head terms, rather than tracking a keyword as though it were one.
    const text = written || (c.isQuestion ? sentenceCase(c.head) : null);
    if (!text || text.length < 12) continue;

    out.push({
      text: String(text).trim().slice(0, 300),
      cluster: c.head,
      impressions: c.impressions,
      clicks: c.clicks,
      avgPosition: c.avgPosition,
      variants: c.variants,
      examples: c.queries.slice(0, 5).map((q) => q.query),
      source: written ? 'gsc+model' : 'gsc'
    });
  }
  return out;
}

function sentenceCase(s) {
  const t = String(s).trim();
  const q = t.charAt(0).toUpperCase() + t.slice(1);
  return /[?]$/.test(q) ? q : `${q}?`;
}

/** Everything the import screen needs, in one call. */
export async function candidates(projectId, { days = 90 } = {}) {
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  const rows = await fetchQueries(project, { days });
  if (!rows.length) return { rows: 0, candidates: [] };

  const clusters = cluster(rows, { brand: project.brand_name });
  const proposed = await proposeFromClusters(clusters, {
    brand: project.brand_name,
    market: project.market
  });

  // Flag anything already tracked so the screen does not offer duplicates.
  const existing = await many('SELECT lower(text) AS text FROM prompts WHERE project_id = $1', [projectId]);
  const seen = new Set(existing.map((e) => e.text));

  return {
    rows: rows.length,
    totalImpressions: rows.reduce((n, r) => n + r.impressions, 0),
    clusters: clusters.length,
    candidates: proposed.map((p) => ({ ...p, alreadyTracked: seen.has(p.text.toLowerCase()) }))
  };
}

/** Add chosen questions, with impressions as the volume figure. */
export async function importQuestions(projectId, chosen) {
  let added = 0;
  for (const c of chosen) {
    const row = await one(
      `INSERT INTO prompts (project_id, text, cluster, intent, ai_search_volume, source)
       VALUES ($1,$2,$3,$4,$5,'gsc')
       ON CONFLICT (project_id, text) DO NOTHING RETURNING id`,
      [
        projectId,
        String(c.text).slice(0, 300),
        String(c.cluster || 'search console').slice(0, 80),
        'commercial',
        Math.max(0, Math.round(Number(c.impressions) || 0))
      ]
    );
    if (row) added++;
  }
  return added;
}
