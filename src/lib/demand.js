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

export const DEMAND_MATCH_VERSION = 'whole-word-v2';

export const DEMAND_METHOD =
  `Search impressions and clicks cover the last ${DEMAND_WINDOW_DAYS} days of connected console data. ` +
  'AI visibility uses measured answers from the latest cycle. These are different clocks and denominators, never combined. ' +
  'Query matching v2 uses whole words, ignores common question words, and requires shared subject terms. ' +
  'At least two specific subject terms must overlap, covering at least half of the shorter subject-term set. Generic marketing and location terms do not count as subject evidence. ' +
  'A complete topic can also match when all its terms occur in the query and at least one is specific, including a single topic such as SEO. No synonyms or inferred intent are added. ' +
  'These are candidate matches, not verified intent. Relevant queries may be missed. Impressions are summed across every matching query, not unique people or AI questions. ' +
  'A query can match multiple topics, so topic totals must not be added together. Queries matching no topic are left out. Review query examples before acting. ' +
  'Matching changed from broad substring matching in September 2026. Totals may differ from earlier exports because of this rule change, not a change in search performance.';

// Deterministic text cleanup only. No stemming, brand detection or measurement changes.
const QUESTION_WORDS = new Set(('what which who where when why how do does did is are was were be been being can could should would will may i my me you your we our us they their it its a an the and or of for to in on at by with from as into about this that these those best top rated latest find get hire look looking choose choosing typical much many dubai uae abu dhabi united arab emirates دبي الامارات ' +
  'ما ماذا من كيف اين متى لماذا هل هو هي هذا هذه ذلك التي الذي في على عن الى مع او و افضل').split(' '));
const GENERIC_TERMS = new Set(('marketing digital service services agency agencies company companies business businesses partner partners dubai uae abu dhabi united arab emirates cost costs price prices pricing comparison selection discovery qualified category benefits benefit improve improving offer offers work working ' +
  'دبي الامارات شركة شركات وكالة وكالات خدمات خدمة تسويق رقمي افضل').split(' '));

function queryTerms(value) {
  const clean = String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا')
    .replace(/\be[ -]commerce\b/g, 'ecommerce');
  return [...new Set((clean.match(/[\p{L}\p{N}]+/gu) || [])
    .filter(word => word.length > 1 && !QUESTION_WORDS.has(word)))];
}

/** Each question is matched independently. Never assemble a match across unrelated questions. */
export function matchQueries(clusterName, queries, questionTexts = []) {
  const topic = queryTerms(clusterName);
  const sets = [topic, ...questionTexts.map(queryTerms)].filter(words => words.length);
  const specific = word => !GENERIC_TERMS.has(word) && !/^\d+$/.test(word);
  return queries.filter(q => {
    const terms = queryTerms(q.query);
    if (!terms.length) return false;
    const querySet = new Set(terms);
    return sets.some(words => {
      const shared = words.filter(word => querySet.has(word));
      if (!shared.some(specific)) return false;
      if (words === topic && shared.length === words.length) return true;
      const subjectMatches = shared.filter(specific);
      const shorter = Math.min(words.filter(specific).length, terms.filter(specific).length);
      return subjectMatches.length >= 2 && subjectMatches.length / shorter >= 0.5;
    });
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
