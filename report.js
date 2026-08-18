import { many, one } from '../db/index.js';

/**
 * The aggregated report.
 *
 * A list of sixty actions is not a plan. What a person can act on is the
 * pattern underneath them: which sources have cited a competitor in every
 * cycle and never you, what the pages being cited have in common, and which
 * problems have persisted long enough to be structural rather than noise.
 *
 * Everything here is counted from stored evidence. Where a causal claim would
 * be convenient, this says what it can see instead.
 */

/** How long each problem has been true, which separates structure from noise. */
async function persistence(projectId) {
  const cycles = await many(
    'SELECT DISTINCT cycle_date FROM recommendation_history WHERE project_id = $1 ORDER BY cycle_date DESC',
    [projectId]
  );

  const rows = await many(
    `SELECT fingerprint, type,
            (ARRAY_AGG(title ORDER BY cycle_date DESC))[1] AS title,
            (ARRAY_AGG(target_url ORDER BY cycle_date DESC))[1] AS target_url,
            (ARRAY_AGG(evidence ORDER BY cycle_date DESC))[1] AS evidence,
            COUNT(DISTINCT cycle_date)::int AS cycles,
            MIN(cycle_date) AS first_seen,
            MAX(cycle_date) AS last_seen,
            AVG(priority)::float AS priority
     FROM recommendation_history
     WHERE project_id = $1
     GROUP BY fingerprint, type
     ORDER BY COUNT(DISTINCT cycle_date) DESC, AVG(priority) DESC`,
    [projectId]
  );

  const total = cycles.length;
  return {
    totalCycles: total,
    since: cycles.at(-1)?.cycle_date || null,
    items: rows.map((r) => ({
      ...r,
      // Present in most cycles means the thing causing it has not changed.
      share: total ? r.cycles / total : 0,
      standing: total >= 3 && r.cycles / total >= 0.6 ? 'recurring' : r.cycles === 1 ? 'new' : 'intermittent'
    }))
  };
}

/**
 * Sources that shape answers in this category, and whether they have ever
 * cited you. A source citing a competitor in every cycle and never you is
 * the clearest thing a report can point at.
 */
async function sourceGaps(projectId) {
  const project = await one('SELECT domain FROM projects WHERE id = $1', [projectId]);
  const own = String(project?.domain || '').replace(/^www\./, '').toLowerCase();

  const rows = await many(
    `SELECT lower(regexp_replace(c.domain, '^www\\.', '')) AS domain,
            COUNT(DISTINCT r.cycle_date)::int AS cycles,
            COUNT(DISTINCT r.prompt_id)::int AS questions,
            COUNT(*)::int AS citations,
            (ARRAY_AGG(c.url ORDER BY c.position))[1] AS example_url
     FROM citations c
     JOIN runs r ON r.id = c.run_id
     WHERE r.project_id = $1 AND r.ok
     GROUP BY 1
     ORDER BY COUNT(DISTINCT r.cycle_date) DESC, COUNT(*) DESC
     LIMIT 40`,
    [projectId]
  );

  const totalCycles = (await one('SELECT COUNT(DISTINCT cycle_date)::int AS n FROM runs WHERE project_id = $1 AND ok', [projectId]))?.n || 0;
  const ownCycles = rows.find((r) => r.domain === own)?.cycles || 0;

  return {
    totalCycles,
    ownDomain: own,
    ownCited: ownCycles,
    sources: rows
      .filter((r) => r.domain !== own)
      .map((r) => ({
        ...r,
        persistent: totalCycles >= 3 && r.cycles / totalCycles >= 0.6
      }))
  };
}

/**
 * What the pages being cited have in common.
 *
 * This is the part worth reading: not "improve your content" but the
 * measured structural features of the pages that actually get cited, counted
 * across every teardown run for this project.
 */
async function citedPagePatterns(projectId) {
  const rows = await many(
    `SELECT DISTINCT ON (t.url) t.url, t.result
     FROM page_teardowns t
     JOIN citations c ON lower(c.url) = lower(t.url)
     JOIN runs r ON r.id = c.run_id AND r.project_id = $1
     WHERE t.result IS NOT NULL
     ORDER BY t.url, t.created_at DESC`,
    [projectId]
  );

  if (!rows.length) return { pages: 0, features: [], note: 'No page teardowns have been run yet.' };

  const counts = {
    schema: 0,
    faqSchema: 0,
    headingMatchesQuestion: 0,
    tables: 0,
    lists: 0,
    statistics: 0,
    namedAuthor: 0,
    visibleDate: 0
  };
  const words = [];
  const schemaTypes = new Map();

  for (const { result } of rows) {
    const s = result?.structure || result || {};
    if (s.schemaTypes?.length) {
      counts.schema++;
      for (const t of s.schemaTypes) schemaTypes.set(t, (schemaTypes.get(t) || 0) + 1);
      if (s.schemaTypes.some((t) => /FAQ|QAPage/i.test(t))) counts.faqSchema++;
    }
    if (s.headingMatch || s.matchingHeadings?.length) counts.headingMatchesQuestion++;
    if (s.tables) counts.tables++;
    if (s.lists) counts.lists++;
    if (s.statistics || s.stats) counts.statistics++;
    if (s.author) counts.namedAuthor++;
    if (s.date || s.published || s.updated) counts.visibleDate++;
    if (s.wordCount) words.push(s.wordCount);
  }

  const n = rows.length;
  const pct = (x) => Math.round((x / n) * 100);

  return {
    pages: n,
    medianWords: words.length ? words.sort((a, b) => a - b)[Math.floor(words.length / 2)] : null,
    schemaTypes: [...schemaTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    features: [
      ['Answers the question in a heading', pct(counts.headingMatchesQuestion)],
      ['Carries structured data', pct(counts.schema)],
      ['Uses FAQ or QA schema', pct(counts.faqSchema)],
      ['Contains a list', pct(counts.lists)],
      ['Contains a table', pct(counts.tables)],
      ['Quotes specific figures', pct(counts.statistics)],
      ['Names an author', pct(counts.namedAuthor)],
      ['Shows a date', pct(counts.visibleDate)]
    ].sort((a, b) => b[1] - a[1])
  };
}

/** Visibility over time, so the report opens with where things stand. */
async function trend(projectId) {
  return many(
    `SELECT r.cycle_date,
            COUNT(*) FILTER (WHERE m.mentioned)::float / NULLIF(COUNT(*), 0) AS rate,
            COUNT(DISTINCT r.prompt_id)::int AS questions
     FROM runs r
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.project_id = $1 AND r.ok
     GROUP BY r.cycle_date ORDER BY r.cycle_date`,
    [projectId]
  );
}

/** What has been done, and what happened next, without claiming one caused the other. */
async function completed(projectId) {
  return many(
    `SELECT title, type, completed_at, target_url
     FROM recommendations
     WHERE project_id = $1 AND status = 'done' AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 40`,
    [projectId]
  );
}

export async function buildReport(projectId) {
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new Error('Project not found');

  const [p, s, patterns, points, done] = await Promise.all([
    persistence(projectId),
    sourceGaps(projectId),
    citedPagePatterns(projectId),
    trend(projectId),
    completed(projectId)
  ]);

  const first = points[0]?.rate ?? null;
  const last = points.at(-1)?.rate ?? null;

  return {
    project: { name: project.name, domain: project.domain, brand: project.brand_name },
    generatedAt: new Date().toISOString(),
    trend: {
      points,
      first,
      last,
      change: first !== null && last !== null ? last - first : null,
      cycles: points.length
    },
    persistence: p,
    sources: s,
    patterns,
    completed: done,
    // Stated once, at the top of the object, so no consumer has to infer it.
    caveats: [
      'Counts come from stored answers. Where a number is missing, the measurement did not run rather than returning zero.',
      'Completed actions and visibility changes are shown side by side. We do not claim one caused the other: too much moves at once in these systems to attribute a change to a single edit.',
      'A source citing a competitor is not proof it will cite you. It is evidence that the source shapes answers in your category and is worth pursuing.'
    ]
  };
}
