/**
 * Real impressions and clicks, per question cluster, beside AI visibility.
 *
 * Sessions tell you who arrived. Impressions and clicks tell you how much
 * demand exists in the first place, and they exist nowhere except the search
 * consoles - Google's, and Bing's when that is connected. A cluster with
 * thousands of impressions and a near-zero named rate is the whole product
 * argument in one row: the audience is asking, the engines are answering,
 * and the brand is not in the answer.
 *
 * The two columns are never summed or divided into each other. Impressions
 * are counted over 90 days of search; named rate is counted over one cycle
 * of answers. Different denominators, different clocks, stated wherever the
 * table is drawn.
 *
 * Shared deliberately by the script, the Traffic tab and the PDF report, so
 * a figure a client reads in the report is the same figure, from the same
 * rule, as the one on screen.
 */
import { many } from '../db/index.js';

export const DEMAND_WINDOW_DAYS = 90;

/** Enough searching that absence from AI answers is worth acting on. */
export const GAP_MIN_IMPRESSIONS = 500;

export const DEMAND_METHOD =
  `Search impressions and clicks cover the last ${DEMAND_WINDOW_DAYS} days of connected console data. ` +
  'AI visibility uses measured answers from the latest cycle. These are different clocks and denominators, never combined. ' +
  'Candidate query matches use case-insensitive substring overlap with any topic or question token longer than two characters. ' +
  'This broad rule can match common words and unrelated intent. Impressions are summed across every matching query, not unique people or AI questions. ' +
  'A query can match multiple topics, so topic totals must not be added together. Queries matching no topic are left out. Review query examples before acting.';

/**
 * Match GSC queries against a cluster.
 *
 * Two-pass strategy:
 * 1. Try matching against the actual question texts (the real language a buyer
 *    uses). A question like "what activities can I do in Hatta" shares words
 *    with real GSC queries even when the cluster name "activity_based" does not.
 * 2. Fall back to matching on the cluster name itself, for clusters that were
 *    imported directly from real search queries and whose name IS the query.
 *
 * A GSC query is included if ANY question text (or the cluster name) produces
 * a word-level overlap of at least one meaningful word (>2 chars). This is
 * intentionally broader than the original all-words-must-match rule, because
 * the purpose is to surface demand that exists - the user can verify by eye.
 */
export function matchQueries(clusterName, queries, questionTexts = []) {
  // Tokenise each question and the cluster name into meaningful words.
  const tokenise = (s) => String(s).toLowerCase().split(/[_\s\-?]+/).filter((w) => w.length > 2);

  const allWordSets = [
    tokenise(clusterName),
    ...questionTexts.map(tokenise)
  ].filter((ws) => ws.length > 0);

  if (!allWordSets.length) return [];

  return queries.filter((q) => {
    const qText = String(q.query || '').toLowerCase();
    // A query matches if ANY of our word sets has at least one word in the query.
    return allWordSets.some((words) => words.some((w) => qText.includes(w)));
  });
}

/**
 * @param queries rows of { query, impressions, clicks, source } from any
 *        console; source lets Bing join later without changing this shape.
 */
export async function demandByCluster(projectId, queries) {
  const [clusters, questionRows] = await Promise.all([
    many(
      `SELECT p.cluster,
              COUNT(DISTINCT p.id)::int AS questions,
              COUNT(m.run_id) FILTER (WHERE r.cycle_date = (SELECT MAX(cycle_date) FROM runs WHERE project_id = $1 AND ok))::int AS measured,
              COUNT(*) FILTER (WHERE m.mentioned AND r.cycle_date = (SELECT MAX(cycle_date) FROM runs WHERE project_id = $1 AND ok))::int AS named
       FROM prompts p
       LEFT JOIN runs r ON r.prompt_id = p.id AND r.ok
       LEFT JOIN mentions m ON m.run_id = r.id AND m.entity_id =
         (SELECT id FROM entities WHERE project_id = $1 AND kind = 'owned' ORDER BY id LIMIT 1)
       WHERE p.project_id = $1 AND p.active
       GROUP BY p.cluster`,
      [projectId]
    ),
    // Fetch every active question text so matchQueries can use real language
    // rather than internal cluster-name vocabulary.
    many(
      `SELECT cluster, text FROM prompts WHERE project_id = $1 AND active`,
      [projectId]
    )
  ]);

  // Index question texts by cluster for O(1) lookup.
  const textsByCluster = new Map();
  for (const r of questionRows) {
    if (!textsByCluster.has(r.cluster)) textsByCluster.set(r.cluster, []);
    textsByCluster.get(r.cluster).push(r.text);
  }

  const out = clusters.map((c) => {
    const questionTexts = textsByCluster.get(c.cluster) || [];
    const hit = matchQueries(c.cluster, queries, questionTexts);
    const impressions = hit.reduce((n, q) => n + (q.impressions || 0), 0);
    const clicks = hit.reduce((n, q) => n + (q.clicks || 0), 0);
    return {
      cluster: c.cluster,
      questions: c.questions,
      measured: c.measured,
      named: c.named,
      // Absent stays absent: a cluster with no answers this cycle is not 0%.
      rate: c.measured ? c.named / c.measured : null,
      impressions: hit.length ? impressions : null,
      clicks: hit.length ? clicks : null,
      matchedQueries: hit.length,
      queryExamples: hit.slice(0, 5).map(q => String(q.query || '')),
      /**
       * Two kinds of row share this table and must not read alike. A cluster
       * imported from a real search query matches itself and reports real
       * demand. A cluster named in generator vocabulary - "category
       * discovery", "qualified best" - cannot appear verbatim inside anyone's
       * search, so it matches nothing. Printing 0 impressions for the second
       * kind states a measurement that was never taken, and a client reading
       * the table cannot tell the two apart. Null means unmatched; zero means
       * matched and genuinely unsearched.
       */
      measurable: hit.length > 0,
      // The row worth acting on: real demand, and the brand is not in the answer.
      gap: hit.length > 0 && impressions >= GAP_MIN_IMPRESSIONS && c.measured > 0 && c.named / c.measured < 0.15
    };
  });

  // Gaps first, then real demand, then the unmatchable rows last: the table
  // should open on what to act on and end on what it cannot see.
  out.sort((a, b) =>
    (b.gap - a.gap) ||
    (b.measurable - a.measurable) ||
    ((b.impressions || 0) - (a.impressions || 0))
  );
  return out;
}
