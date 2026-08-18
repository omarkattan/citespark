import { many, one, query as sql } from '../db/index.js';
import { askEngine } from './dataforseo.js';
import { accessTokenFor } from './gsc.js';

/**
 * Does the AI Overview cite the page that already ranks for this search?
 *
 * Search Console answers "which of my pages earns which searches". This asks
 * the other half: for those same searches, does Google show an AI Overview,
 * and if so does it cite that page. Ranking third and being absent from the
 * answer sitting above the third result are different problems, and until now
 * nothing here could tell them apart.
 *
 * Cheap enough to run widely: an AI Overview call is roughly a tenth the cost
 * of a chat engine call.
 */

const API = 'https://www.googleapis.com/webmasters/v3';
const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
const sameUrl = (a, b) => strip(a) === strip(b);

/**
 * Query and page together, which the existing query-only fetch cannot give.
 * Ordered by impressions because a page nobody sees is not worth a call.
 */
/**
 * Is this search really about the brand?
 *
 * Of course an AI Overview names you for your own name. Checking branded
 * searches spends the allowance to confirm something already known, and on a
 * brand like "The Family Office" they can be most of the list. Flagged rather
 * than dropped, because the answer to a branded search is occasionally a
 * surprise worth seeing.
 */
export function isBranded(queryText, project) {
  const terms = [project.brand_name, project.name, ...(project.aliases || [])]
    .filter(Boolean)
    .map((t) => String(t).toLowerCase().trim())
    .filter((t) => t.length > 2);

  // The domain without its suffix catches "sandstormdigital" in a query.
  const host = String(project.domain || '').replace(/^www\./, '').split('.')[0].toLowerCase();
  if (host.length > 3) terms.push(host);

  const q = String(queryText).toLowerCase();
  return terms.some((t) => {
    if (q.includes(t)) return true;
    // "sandstorm digital" should match "sandstormdigital" and vice versa.
    const squashed = t.replace(/\s+/g, '');
    return squashed.length > 4 && q.replace(/\s+/g, '').includes(squashed);
  });
}

export async function fetchPageQueries(
  project,
  { days = 90, limit = 5000, minImpressions = 1, path = '' } = {}
) {
  const site = project.gsc_site_url;
  if (!site) throw new Error('No Search Console property chosen for this site');

  const token = await accessTokenFor(project);
  const iso = (d) => d.toISOString().slice(0, 10);
  const startDate = iso(new Date(Date.now() - days * 86400000));
  const endDate = iso(new Date());

  /**
   * Search Console returns 25,000 rows a page and most sites have more than
   * one page of them. A single request capped the list at whatever came back
   * first, so a site with a thousand searches only ever saw a fraction and
   * had no way to know what was missing.
   */
  const all = [];
  const PAGE = 25000;
  for (let startRow = 0; startRow < 100000; startRow += PAGE) {
    const res = await fetch(`${API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ['query', 'page'],
        rowLimit: PAGE,
        startRow,
        dataState: 'final',
        // Filtering server side is far cheaper than pulling everything and
        // discarding it, and it is how someone asks for one section of a site.
        ...(path
          ? { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: path }] }] }
          : {})
      })
    });
    if (!res.ok) throw new Error(`Search Console query failed: ${res.status}`);

    const json = await res.json();
    const rows = json.rows || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }

  const rows = all
    .map((r) => ({
      query: r.keys[0],
      page: r.keys[1],
      impressions: r.impressions,
      clicks: r.clicks,
      position: Math.round(r.position * 10) / 10
    }))
    .filter((r) => r.impressions >= minImpressions);

  // One page per query: the same search can surface several pages, and the
  // one Google shows most is the one being tested.
  const best = new Map();
  for (const r of rows) {
    const prev = best.get(r.query);
    if (!prev || r.impressions > prev.impressions) best.set(r.query, r);
  }

  return [...best.values()]
    .map((r) => ({ ...r, branded: isBranded(r.query, project) }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit);
}

/**
 * The sections this site actually has, counted from its own pages.
 *
 * A hardcoded example is wrong for everyone except the site it came from.
 * These are the real path segments, so someone can pick a folder rather than
 * guess at the shape of their own URLs.
 */
export function sectionsFrom(rows) {
  const counts = new Map();

  for (const r of rows) {
    let path;
    try {
      path = new URL(r.page).pathname;
    } catch {
      continue;
    }
    const parts = path.split('/').filter(Boolean);
    // Both depths, because /en/insights and /en/insights/articles are both
    // things someone might want to scope to.
    for (const depth of [1, 2, 3]) {
      if (parts.length < depth) continue;
      const seg = '/' + parts.slice(0, depth).join('/');
      if (!counts.has(seg)) counts.set(seg, { path: seg, pages: new Set(), queries: 0, impressions: 0 });
      const c = counts.get(seg);
      c.pages.add(r.page);
      c.queries += 1;
      c.impressions += r.impressions;
    }
  }

  return [...counts.values()]
    .map((c) => ({ path: c.path, pages: c.pages.size, queries: c.queries, impressions: c.impressions }))
    // A segment covering everything says nothing, and one covering a single
    // page is just that page.
    .filter((c) => c.pages > 1 && c.queries >= 3)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 12);
}

/**
 * Check one search. Returns the three states separately, because "Google
 * showed no overview" is a fact about Google and "showed one without you" is
 * a fact about the page, and reporting them as one number would be wrong.
 */
export async function checkQuery({ query, page, market, ownDomain, competitorDomains = [] }) {
  const answer = await askEngine({ engine: 'ai_overview', prompt: query, market });

  if (!answer.ok && !answer.noOverview) {
    return { query, page, error: answer.error || 'request failed', cost: answer.costUsd || 0 };
  }

  // A missing overview is a legitimate outcome, not a failure.
  if (answer.noOverview || (!answer.text && !answer.citations?.length)) {
    return { query, page, overview: false, domainCited: false, pageCited: false, cost: answer.costUsd || 0 };
  }

  const cites = answer.citations || [];
  const ours = cites.filter((c) => strip(c.domain) === strip(ownDomain));
  const exact = page ? ours.find((c) => sameUrl(c.url, page)) : null;

  return {
    query,
    page,
    overview: true,
    domainCited: ours.length > 0,
    // Cited the domain but a different page is its own finding: the site is
    // trusted here, just not through the page that earns the search.
    pageCited: Boolean(exact),
    citedUrl: exact?.url || ours[0]?.url || null,
    competitors: cites
      .filter((c) => strip(c.domain) !== strip(ownDomain))
      .slice(0, 8)
      .map((c) => ({
        domain: c.domain,
        url: c.url,
        tracked: competitorDomains.some((d) => strip(d) === strip(c.domain))
      })),
    cost: answer.costUsd || 0
  };
}

/** Run a batch and store it. */
export async function runPageChecks(projectId, { limit = 50, days = 90, queries = null } = {}) {
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new Error('Project not found');

  const rivals = (
    await many("SELECT domain FROM entities WHERE project_id = $1 AND kind = 'competitor' AND domain IS NOT NULL", [projectId])
  ).map((r) => r.domain);

  // An explicit list where the customer has chosen. Taking the top N whatever
  // they picked would make the picker decorative.
  const all = await fetchPageQueries(project, { days, limit: 250 });
  const rows = queries?.length
    ? all.filter((r) => queries.includes(r.query))
    : all.filter((r) => !r.branded).slice(0, limit);
  const results = [];
  let spend = 0;

  for (const row of rows) {
    const r = await checkQuery({
      query: row.query,
      page: row.page,
      market: project.market,
      ownDomain: project.domain,
      competitorDomains: rivals
    });
    spend += r.cost || 0;

    await sql(
      `INSERT INTO page_checks
         (project_id, query, page, impressions, clicks, position, overview, domain_cited, page_cited, cited_url, competitors, cost_usd, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (project_id, checked_on, query) DO UPDATE SET
         page = EXCLUDED.page, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
         position = EXCLUDED.position, overview = EXCLUDED.overview, domain_cited = EXCLUDED.domain_cited,
         page_cited = EXCLUDED.page_cited, cited_url = EXCLUDED.cited_url,
         competitors = EXCLUDED.competitors, cost_usd = EXCLUDED.cost_usd, error = EXCLUDED.error`,
      [
        projectId, row.query, row.page, row.impressions, row.clicks, row.position,
        Boolean(r.overview), Boolean(r.domainCited), Boolean(r.pageCited),
        r.citedUrl || null, JSON.stringify(r.competitors || []), r.cost || 0, r.error || null
      ]
    );
    results.push({ ...row, ...r });
  }

  return { checked: results.length, spend: Math.round(spend * 10000) / 10000, results };
}

/** The latest batch, summarised the way it should be read. */
export async function readPageChecks(projectId) {
  const day = (await one('SELECT MAX(checked_on) AS d FROM page_checks WHERE project_id = $1', [projectId]))?.d;
  if (!day) return null;

  const rows = await many(
    'SELECT * FROM page_checks WHERE project_id = $1 AND checked_on = $2 ORDER BY impressions DESC',
    [projectId, day]
  );

  const withOverview = rows.filter((r) => r.overview);
  const impressions = (list) => list.reduce((n, r) => n + r.impressions, 0);

  return {
    checkedOn: day,
    total: rows.length,
    // Reported separately throughout, because they mean different things.
    noOverview: rows.filter((r) => !r.overview && !r.error).length,
    withOverview: withOverview.length,
    cited: withOverview.filter((r) => r.domain_cited).length,
    exactPage: withOverview.filter((r) => r.page_cited).length,
    wrongPage: withOverview.filter((r) => r.domain_cited && !r.page_cited).length,
    // The number that makes the case: searches you already rank for, where an
    // overview appears above you and does not mention you.
    missedImpressions: impressions(withOverview.filter((r) => !r.domain_cited)),
    totalImpressions: impressions(rows),
    errors: rows.filter((r) => r.error).length,
    rows
  };
}
