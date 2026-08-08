import { many, one } from '../db/index.js';

/**
 * Scoring for a sector study.
 *
 * Three rules shape everything here, and each exists because breaking it
 * would publish a number that means something other than it appears to.
 *
 *   Cohorts are scored separately, never against each other. A Sharjah
 *   developer and a UAE major are answering different questions, so a
 *   combined table would be a ranking of prompt sets, not of companies.
 *
 *   Denominators count answers that existed. Google shows an AI Overview for
 *   a minority of these questions; counting the silent ones as failures to
 *   appear would report a gap in the measurement as an absence of the
 *   developer.
 *
 *   Project mentions do not enter the corporate score. Naming Al Zahia is not
 *   naming Sharjah Holding, and the run rules treat them as separate.
 */

export const COMPOSITE_WEIGHTS = {
  mention_rate: 0.35,
  top_three_rate: 0.25,
  recommendation_rate: 0.2,
  citation_rate: 0.2
};

/**
 * Per developer, per cohort, per run. Kept at run granularity so spread can
 * be reported: 40% from runs of 20/40/60 is a different finding from 38/40/42.
 */
async function rawByRun(studyId, cycle) {
  return many(
    `WITH answered AS (
       -- Only answers that actually contained something to be named in.
       SELECT a.id, a.prompt_id, a.engine, a.run_index, p.cohorts AS prompt_cohorts
       FROM sector_answers a
       JOIN sector_prompts p ON p.id = a.prompt_id
       WHERE a.study_id = $1 AND a.cycle_date = $2
         AND a.ok AND length(COALESCE(a.answer_text, '')) > 0
         AND NOT p.excluded_from_public
     )
     SELECT c.id AS company_id, c.key, c.name, c.domain, c.cohorts AS company_cohorts,
            an.run_index,
            an.prompt_cohorts,
            COUNT(*)::int AS answers,
            COUNT(m.id) FILTER (WHERE m.mentioned AND NOT m.via_project)::int AS mentions,
            COUNT(m.id) FILTER (WHERE m.mentioned AND NOT m.via_project AND m.ordinal <= 3)::int AS top_three,
            COUNT(m.id) FILTER (WHERE m.recommended AND NOT m.via_project)::int AS recommendations,
            COUNT(m.id) FILTER (WHERE m.cited AND NOT m.via_project)::int AS citations,
            COUNT(m.id) FILTER (WHERE m.via_project)::int AS project_mentions
     FROM sector_companies c
     CROSS JOIN answered an
     LEFT JOIN sector_mentions m ON m.answer_id = an.id AND m.company_id = c.id
     WHERE c.study_id = $1 AND c.active
     GROUP BY c.id, c.key, c.name, c.domain, c.cohorts, an.run_index, an.prompt_cohorts`,
    [studyId, cycle]
  );
}

const rate = (n, d) => (d > 0 ? n / d : 0);

export function composite(parts) {
  return (
    COMPOSITE_WEIGHTS.mention_rate * parts.mention_rate +
    COMPOSITE_WEIGHTS.top_three_rate * parts.top_three_rate +
    COMPOSITE_WEIGHTS.recommendation_rate * parts.recommendation_rate +
    COMPOSITE_WEIGHTS.citation_rate * parts.citation_rate
  );
}

/**
 * Which domains the engines actually read to answer these questions.
 *
 * The most original thing on the page: it is measured from the answers
 * themselves rather than from a rank tracker, and it shows how much of the
 * category conversation is mediated by portals and press rather than by the
 * developers being discussed.
 */
export async function citedSources(studyId, cycle) {
  const rows = await many(
    `WITH answered AS (
       SELECT a.id, a.links
       FROM sector_answers a
       JOIN sector_prompts p ON p.id = a.prompt_id
       WHERE a.study_id = $1 AND a.cycle_date = $2
         AND a.ok AND length(COALESCE(a.answer_text,'')) > 0
         AND NOT p.excluded_from_public
     ),
     flat AS (
       SELECT an.id AS answer_id, lower(regexp_replace(l->>'domain', '^www\\.', '')) AS domain
       FROM answered an, jsonb_array_elements(an.links) l
       WHERE l->>'domain' IS NOT NULL
     )
     SELECT domain,
            COUNT(*)::int AS links,
            COUNT(DISTINCT answer_id)::int AS answers
     FROM flat
     WHERE domain <> ''
     GROUP BY domain
     ORDER BY answers DESC, links DESC
     LIMIT 40`,
    [studyId, cycle]
  );

  const total = await one(
    `SELECT COUNT(*)::int AS n FROM sector_answers a JOIN sector_prompts p ON p.id = a.prompt_id
     WHERE a.study_id = $1 AND a.cycle_date = $2 AND a.ok
       AND length(COALESCE(a.answer_text,'')) > 0 AND NOT p.excluded_from_public`,
    [studyId, cycle]
  );

  const own = new Set(
    (await many('SELECT domain FROM sector_companies WHERE study_id = $1 AND active AND domain IS NOT NULL', [studyId]))
      .map((r) => String(r.domain).replace(/^www\./, '').toLowerCase())
  );

  return rows.map((r) => ({
    ...r,
    share: total.n ? r.answers / total.n : 0,
    // A developer's own site is a different kind of source from a portal.
    isDeveloper: own.has(r.domain)
  }));
}

/**
 * Score one study. Returns a table per cohort, plus the run-to-run spread on
 * the two metrics where instability is the point.
 */
export async function scoreStudy(slug = 'property-developers') {
  const study = await one('SELECT * FROM sector_studies WHERE slug = $1', [slug]);
  if (!study) throw new Error(`No study "${slug}"`);

  const cycle = (await one('SELECT MAX(cycle_date) AS d FROM sector_answers WHERE study_id = $1', [study.id]))?.d;
  if (!cycle) throw new Error('Nothing measured yet');

  const rows = await rawByRun(study.id, cycle);
  const cohorts = study.config.cohorts || [];

  // Which engines produced usable answers, and how often. An engine that
  // rarely answers is reported rather than quietly diluting everyone.
  const engines = await many(
    `SELECT engine,
            COUNT(*)::int AS attempted,
            COUNT(*) FILTER (WHERE ok AND length(COALESCE(answer_text,'')) > 0)::int AS answered
     FROM sector_answers WHERE study_id = $1 AND cycle_date = $2
     GROUP BY engine ORDER BY engine`,
    [study.id, cycle]
  );

  const out = [];

  for (const cohort of cohorts) {
    // A prompt belongs to a cohort explicitly, or is general enough to apply
    // to all of them. A company is scored only in cohorts it belongs to.
    const inCohort = (r) =>
      r.company_cohorts.includes(cohort.id) &&
      (!r.prompt_cohorts.length || r.prompt_cohorts.includes(cohort.id));

    const byCompany = new Map();
    for (const r of rows.filter(inCohort)) {
      if (!byCompany.has(r.company_id)) {
        byCompany.set(r.company_id, { key: r.key, name: r.name, domain: r.domain, runs: new Map() });
      }
      const c = byCompany.get(r.company_id);
      const prev = c.runs.get(r.run_index) || {
        answers: 0, mentions: 0, top_three: 0, recommendations: 0, citations: 0, project_mentions: 0
      };
      for (const k of Object.keys(prev)) prev[k] += r[k];
      c.runs.set(r.run_index, prev);
    }

    const companies = [...byCompany.values()].map((c) => {
      const runs = [...c.runs.values()];
      const totals = runs.reduce(
        (a, r) => {
          for (const k of Object.keys(a)) a[k] += r[k];
          return a;
        },
        { answers: 0, mentions: 0, top_three: 0, recommendations: 0, citations: 0, project_mentions: 0 }
      );

      const parts = {
        mention_rate: rate(totals.mentions, totals.answers),
        // Position is only meaningful where the company was named at all.
        top_three_rate: rate(totals.top_three, totals.mentions || totals.answers),
        recommendation_rate: rate(totals.recommendations, totals.answers),
        citation_rate: rate(totals.citations, totals.answers)
      };

      // Spread across runs, because a stable 40% and a volatile 40% are
      // different findings and only one of them is safe to act on.
      const perRun = runs.map((r) => ({
        mention_rate: rate(r.mentions, r.answers),
        top_three_rate: rate(r.top_three, r.mentions || r.answers)
      }));
      const spread = (k) => ({
        min: perRun.length ? Math.min(...perRun.map((p) => p[k])) : 0,
        max: perRun.length ? Math.max(...perRun.map((p) => p[k])) : 0
      });

      return {
        key: c.key,
        name: c.name,
        domain: c.domain,
        answers: totals.answers,
        runs: runs.length,
        ...parts,
        composite: composite(parts),
        spread: { mention_rate: spread('mention_rate'), top_three_rate: spread('top_three_rate') },
        project_mentions: totals.project_mentions
      };
    });

    out.push({
      id: cohort.id,
      label: cohort.label || cohort.id,
      description: cohort.description || null,
      companies: companies.sort((a, b) => b.composite - a.composite)
    });
  }

  const sources = await citedSources(study.id, cycle);

  // Per developer, across every cohort they sit in, for the detail section.
  const detail = await many(
    `SELECT c.key, c.name, c.domain, c.cohorts,
            COUNT(m.id) FILTER (WHERE m.mentioned AND NOT m.via_project)::int AS mentions,
            COUNT(m.id) FILTER (WHERE m.cited AND NOT m.via_project)::int AS citations,
            COUNT(m.id) FILTER (WHERE m.via_project)::int AS project_mentions,
            COUNT(m.id) FILTER (WHERE m.recommended AND NOT m.via_project)::int AS recommendations,
            MIN(m.ordinal) FILTER (WHERE m.mentioned AND NOT m.via_project)::int AS best_position,
            ROUND(AVG(m.ordinal) FILTER (WHERE m.mentioned AND NOT m.via_project)::numeric, 1)::float AS avg_position
     FROM sector_companies c
     LEFT JOIN sector_mentions m ON m.company_id = c.id
     LEFT JOIN sector_answers a ON a.id = m.answer_id AND a.cycle_date = $2
     WHERE c.study_id = $1 AND c.active
     GROUP BY c.key, c.name, c.domain, c.cohorts
     ORDER BY mentions DESC`,
    [study.id, cycle]
  );

  return {
    study: { slug: study.slug, name: study.name, market: study.market },
    cycle,
    sources,
    developers: detail,
    weights: COMPOSITE_WEIGHTS,
    engines: engines.map((e) => ({
      ...e,
      answer_rate: rate(e.answered, e.attempted),
      // Below this, a surface is describing itself rather than the market.
      thin: e.attempted > 0 && rate(e.answered, e.attempted) < 0.5
    })),
    cohorts: out,
    // Stated on the page, not left for a reader to infer.
    caveats: {
      cross_cohort: 'Scores are calculated within a cohort and are not comparable across cohorts.',
      denominators: 'Rates are over answers that were actually returned, not over attempts.',
      projects: 'Mentions of a project name are recorded separately and do not enter the corporate score.',
      annotated: 'Accuracy, sentiment, hallucination rate and attribute association are human-annotated and are not part of this composite.'
    }
  };
}
