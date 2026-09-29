import 'dotenv/config';
import { one, many, query, pool } from '../db/index.js';
import { decrypt } from './tokens.js';
import { matchSearchSnapshot, sealCandidate, openCandidate } from './search-evidence.js';
import { queryKey, containsSearchBrand, queryLanguage, preservesQueryBasics, existingGscQuestion, isBuyerQuestion } from './gsc-query-integrity.js';
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
const ASKED = /^(?:(?:who|what|which|when|where|why|how|is|are|can|should|does|do)\b|(?:كيف|هل|ما|ماذا|أين|اين|متى|لماذا|كم|أي|اي|من)\s)/i;
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
export async function fetchQuerySnapshot(project, { days = 90, limit = 2000 } = {}) {
  days = Math.max(1, Math.min(180, Number(days) || 90));
  limit = Math.max(1, Math.min(2000, Number(limit) || 2000));
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
      type: 'web',
      rowLimit: limit,
      dataState: 'final'
    })
  });
  if (!res.ok) throw new Error(`Search Console query failed: ${res.status}`);

  const json = await res.json();
  const rows = (json.rows || []).map((r) => ({
    query: r.keys[0],
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    position: r.position
  }));
  return { rows, evidence: { property: site, startDate: iso(start), endDate: iso(end), fetchedAt: new Date().toISOString(), searchType: 'web', dataState: 'final', country: 'all', device: 'all', rowLimit: limit, returnedRows: rows.length } };
}

export async function fetchQueries(project, options) {
  return (await fetchQuerySnapshot(project, options)).rows;
}

/**
 * Group queries that are really the same intent, so twenty variations of one
 * question do not become twenty tracked questions.
 */
export function cluster(rows, { minImpressions = 5, brand = '', aliases = [], domain = '' } = {}) {
  const groups = new Map();
  const names = [brand, ...aliases, domain, domain.replace(/^www\./i,'')];
  for (const row of rows) {
    if (row.impressions < minImpressions || containsSearchBrand(row.query, names)) continue;
    const key = queryKey(row.query);
    if (!key) continue;
    // Shared words do not prove shared intent. Preserve qualifiers, numbers,
    // word order and scripts. Only case, whitespace and trailing question marks merge.
    let target = groups.get(key);
    if (!target) {
      target = { key, queries: [], impressions: 0, clicks: 0, positionSum: 0 };
      groups.set(key, target);
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
- Write the question exactly as a person would type it into ChatGPT: a concise, natural question. Do not pad Arabic to meet an English word count.
- Return an actual question, not a copied keyword or a keyword with a question mark. Use a natural question opening such as how/which/what or كيف/هل/ما/أي.
- Examples: "loan calculator" → "How do I calculate my loan repayments?"; "حاسبة القروض" → "كيف أحسب أقساط القرض؟". Do not add "personal" or a country to either example.
- "بطاقة ائتمان" or "credit card" alone does not tell you whether the user wants a definition, eligibility, fees or a comparison. Omit such unclear product-only queries instead of choosing an intent for them.
- Write Arabic directly in clear, natural Arabic appropriate to the market. Avoid literal English sentence structures, awkward phrasing and unnecessary qualifiers. Preserve dialect if present in the source rather than inventing it.
- Never reinterpret a named app or service as a banking product because the client is a bank. For example, "تفعيل تطبيق سند" does not establish a banking-app intent. Omit unclear or unrelated named-service queries.
- Preserve the source language. Arabic queries must stay Arabic, English queries must stay English.
- Preserve all amounts, product types, eligibility restrictions and location qualifiers. Do not add a best/lowest claim, location or application intent that the source does not express.
- Only suggest questions relevant to the supplied business scope and customer brief.
- Never include the brand's own name. We are measuring unprompted recall.
- Keep the intent of the original query. A query about price becomes a price question, not a generic "best" question.
- Keep location and sector qualifiers that appear in the queries.
- Business scope and market are relevance filters, never permission to add product types or locations. "loan calculator" must not become "personal loan calculator". "راتب" is too vague and must be omitted.
- If a cluster is navigational, branded, or too vague to make a sensible buyer question, omit it entirely.

Return ONLY a JSON array: [{"index": number, "text": string}]
The index refers to the cluster number you were given. Omit clusters you are skipping.`;

/**
 * Suggest questions from source queries. Search figures remain source evidence,
 * never an estimate of how often the question is asked in AI engines.
 */
export async function proposeFromClusters(clusters, { brand, aliases = [], domain = '', market, category = '', qualifier = '' } = {}) {
  const top = clusters.filter(c => queryKey(c.head).split(' ').length >= 2).slice(0, 30);
  if (!top.length) return [];

  const listing = top
    .map(
      (c, i) =>
        `${i}. "${c.head}" (${c.impressions} impressions, ${c.clicks} clicks, avg position ${c.avgPosition?.toFixed(1)})` +
        (c.variants > 1 ? ` also: ${c.queries.slice(1, 4).map((q) => q.query).join(', ')}` : '')
    )
    .join('\n');

  const raw = await complete(
    `Brand: ${brand}\nOther brand names: ${aliases.join(', ')}\nMarket: ${market}\nBusiness scope: ${category}\nCustomer brief: ${qualifier}\n\nClusters:\n${listing}`,
    { system: SYSTEM, maxTokens: 2000 }
  );
  const parsed = parseJsonArray(raw);

  const out = [];
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    const draft = parsed?.find((p) => Number(p.index) === i)?.text;
    const names = [brand, ...aliases, domain];
    const written = isBuyerQuestion(draft) && preservesQueryBasics(c.head, draft) && !containsSearchBrand(draft, names) ? draft : null;

    // Without a model, keep queries that already read as questions and skip
    // the head terms, rather than tracking a keyword as though it were one.
    const text = written || (!parsed && isBuyerQuestion(c.head) ? sentenceCase(c.head) : null);
    if (!isBuyerQuestion(text) || containsSearchBrand(text, names)) continue;

    out.push({
      text: text.trim(),
      cluster: c.head,
      language: queryLanguage(c.head),
      groupingMethod: 'exact-normalized-v1',
      impressions: c.impressions,
      clicks: c.clicks,
      avgPosition: c.avgPosition,
      variants: c.variants,
      querySet: c.queries.map(q => q.query),
      examples: c.queries.slice(0, 5).map((q) => q.query),
      source: written ? 'gsc+model' : 'gsc'
    });
  }
  return out;
}

function sentenceCase(s) {
  const t = String(s).trim();
  const q = t.charAt(0).toUpperCase() + t.slice(1);
  return /[?؟]$/.test(q) ? q : `${q}${queryLanguage(q) === 'ar' ? '؟' : '?'}`;
}

/** Everything the import screen needs, in one call. */
export async function candidates(projectId, { days = 90 } = {}) {
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  const { rows, evidence } = await fetchQuerySnapshot(project, { days });
  if (!rows.length) return { rows: 0, candidates: [] };

  const clusters = cluster(rows, { brand: project.brand_name, aliases: project.aliases || [], domain: project.domain });
  const proposed = await proposeFromClusters(clusters, {
    brand: project.brand_name, aliases: project.aliases || [], domain: project.domain,
    category: project.category, qualifier: project.qualifier,
    market: project.market
  });

  // Flag anything already tracked so the screen does not offer duplicates.
  const existing = await many('SELECT id, text, source, active, origin_details FROM prompts WHERE project_id = $1 ORDER BY active DESC, id DESC', [projectId]);

  return {
    rows: rows.length,
    totalImpressions: rows.reduce((n, r) => n + r.impressions, 0),
    clusters: clusters.length,
    candidates: proposed.map(p => {
      const previous = existingGscQuestion(p, existing, project.gsc_site_url);
      return {...p, evidenceToken: sealCandidate(projectId, p, evidence), alreadyTracked: Boolean(previous), existingQuestion: previous ? {id:previous.id, text:previous.text, active:previous.active} : null};
    })
  };
}

/** Import reviewed questions with signed search evidence. No AI measurements are changed. */
export async function importQuestions(projectId, chosen, database = pool) {
  const client = await database.connect();
  const one = async (sql, args) => (await client.query(sql, args)).rows[0] || null;
  try {
    await client.query('BEGIN');
    // Serialize imports for this project, including simultaneous browser tabs.
    await client.query('SELECT pg_advisory_xact_lock(46046, $1::integer)', [projectId]);
    const project = await one('SELECT gsc_site_url, brand_name, aliases, domain FROM projects WHERE id = $1', [projectId]);
    let added = 0;
    // Validate every selection before writing any of them. Client metrics are never authoritative.
    const verified = chosen.map(c => {
      const candidate = openCandidate(c.evidenceToken, projectId, project?.gsc_site_url);
      if (candidate.groupingMethod !== 'exact-normalized-v1') {
        const err = new Error('Search grouping has changed. Load Search Console suggestions again before importing.');
        err.code = 'GSC_SELECTION_EXPIRED';
        throw err;
      }
      const text = typeof c.reviewedText === 'string' ? c.reviewedText.trim() : candidate.text;
      if (!isBuyerQuestion(text) || !preservesQueryBasics(candidate.cluster, text) || containsSearchBrand(text, [project?.brand_name, ...(project?.aliases || []), project?.domain])) {
        const err = new Error('Write a complete question using 12–300 characters, starting with a question word such as how, which, كيف or هل. Preserve the source language, amounts, product restrictions and locations. Do not add your brand or infer a new product from your business scope.');
        err.code = 'GSC_SELECTION_EXPIRED';
        throw err;
      }
      return {...candidate, proposedText:candidate.text, text, wordingEdited:text!==candidate.text};
    });
    const existing = (await client.query('SELECT id, text, source, active, origin_details FROM prompts WHERE project_id = $1', [projectId])).rows;
    for (const c of verified) {
      if (existingGscQuestion(c, existing, project?.gsc_site_url)) continue;
      const row = await one(
        `INSERT INTO prompts (project_id, text, cluster, intent, ai_search_volume, source, origin_details)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (project_id, text) DO NOTHING RETURNING id`,
        [
          projectId,
          String(c.text).slice(0, 300),
          String(c.cluster || 'search console').slice(0, 80),
          'unclassified',
          Math.max(0, Math.round(Number(c.impressions) || 0)),
          c.source === 'gsc+model' ? 'gsc+model' : c.source === 'gsc' ? 'gsc-query' : 'gsc',
          JSON.stringify({ proposedText:c.proposedText, importedText:c.text, wordingEdited:c.wordingEdited, wordingReviewVersion:'gsc-review-v1', property: project?.gsc_site_url || null, groupingMethod: c.groupingMethod, language: c.language, querySet: c.querySet, gscSnapshot: { ...c.evidence, scope: 'imported query group', matchedQueries: c.querySet.length, storedQueries: c.querySet.length, impressions: c.impressions, clicks: c.clicks, avgPosition: c.avgPosition },
            queryExamples: (Array.isArray(c.examples) ? c.examples : []).slice(0, 5).map(x => String(x).slice(0, 300)),
            impressions: Math.max(0, Math.round(Number(c.impressions) || 0)), importedAt: new Date().toISOString() })
        ]
      );
      if (row) {
        added++;
        existing.push({text:c.text, source:'gsc', origin_details:{property:project?.gsc_site_url, querySet:c.querySet}});
      }
    }
    await client.query('COMMIT');
    return added;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** Refresh search evidence only. No model calls and no visibility measurements. */
export async function refreshSearchEvidence(project) {
  const prompts = await many("SELECT id, origin_details FROM prompts WHERE project_id=$1 AND active AND source LIKE 'gsc%'", [project.id]);
  const eligible = prompts.filter(p => p.origin_details?.property === project.gsc_site_url && (p.origin_details?.querySet?.length || p.origin_details?.queryExamples?.length));
  if (!eligible.length) return { updated: 0, message: 'No active questions have stored queries for the connected property.' };
  const snapshot = await fetchQuerySnapshot(project, { days: 90 });
  for (const p of eligible) {
    const result = matchSearchSnapshot(p.origin_details, snapshot);
    await query(`UPDATE prompts SET origin_details = COALESCE(origin_details,'{}'::jsonb) || jsonb_build_object('gscSnapshot',$3::jsonb)
      WHERE id=$1 AND project_id=$2`, [p.id, project.id, JSON.stringify(result)]);
  }
  return { updated: eligible.length, message: `Search evidence refreshed for ${eligible.length} questions. AI measurements are unchanged.` };
}
