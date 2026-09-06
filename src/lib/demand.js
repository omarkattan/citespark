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
  `Impressions and clicks come from the connected search consoles over the last ${DEMAND_WINDOW_DAYS} days. ` +
  'The AI named rate comes from the most recent measurement cycle. They are shown side by side, never combined: ' +
  'one counts searches, the other counts answers. A query is matched to a cluster when every word of the cluster ' +
  'name appears in the query, so any row can be checked by hand. Queries matching no cluster are left out, which ' +
  'understates demand rather than inventing it. Clusters whose names cannot appear inside a real ' +
  'search query, such as the generator vocabulary ones, match nothing and are shown as no matching ' +
  'queries rather than as zero impressions: the demand is unmeasured here, not absent.';

/** Literal, checkable matching. Deliberately not fuzzy. */
export function matchQueries(clusterName, queries) {
  const words = String(clusterName).toLowerCase().split(/[_\s-]+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  return queries.filter((q) => {
    const text = String(q.query || '').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/**
 * @param queries rows of { query, impressions, clicks, source } from any
 *        console; source lets Bing join later without changing this shape.
 */
export async function demandByCluster(projectId, queries) {
  const clusters = await many(
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
  );

  const out = clusters.map((c) => {
    const hit = matchQueries(c.cluster, queries);
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
