import { many, query } from '../db/index.js';
import { classifySource } from './teardown.js';

/**
 * The recommendations engine.
 *
 * Every rule takes measured evidence and emits an action a person can do
 * this week. Nothing here is generic advice: each recommendation names a
 * prompt, a competitor, a source domain or a URL, and carries the run IDs
 * that justify it so the claim can be checked.
 *
 * priority = impact / effort
 *   impact  scales with the AI search volume of the prompt and the size of the gap
 *   effort  is a fixed 1 to 5 estimate per action type
 */

const EFFORT = {
  content_gap: 4,
  citable_asset: 3,
  entity_authority: 3,
  ordinal_push: 2,
  competitor_comparison: 4,
  source_gap: 2,
  competitor_page: 4,
  engine_gap: 2,
  sentiment_correction: 3,
  decline_alert: 1,
  replicate_winner: 2,
  fanout_target: 3
};

/**
 * Which sources took the citation for a question where the brand was named
 * but its own site was not used.
 */
function whoTookIt(prompt, ownDomain, competitorDomains) {
  return (prompt.citedDomains || [])
    .filter((c) => c.domain && c.domain !== ownDomain)
    .map((c) => ({ ...c, ...classifySource(c.domain, { ownDomain, competitorDomains }) }));
}

/** A citation gap is an observation, not an explanation of selection. */
function citableAdvice(prompt, ownDomain, competitorDomains) {
  const sources = whoTookIt(prompt, ownDomain, competitorDomains).map(s => s.domain).slice(0,4);
  return "This task records brand mentions without a recorded citation to your site in its sample. Read the stored answers and source links. Check whether a citation was expected for this question and whether your relevant page supplies the needed facts. Update a page or correct a listing only if you identify missing or inaccurate information. A citation gap does not prove that engines distrust your site or that clicks went elsewhere." +
    (sources.length ? ` Recorded sources to review: ${sources.join(', ')}.` : '');
}

/**
 * Score volume relative to this project's own question set, not an absolute
 * scale. An absolute scale collapses: if a model assigns every question a
 * high volume they all hit the ceiling and every action lands on the same
 * priority, which is exactly what happened in the first live run.
 *
 * Percentile within the set guarantees a real spread from 25 to 100 however
 * the volumes were estimated, and keeps ordering meaningful when the
 * estimates themselves are unreliable.
 */
function makeScorer(volumes) {
  const sorted = [...new Set(volumes.filter((v) => Number.isFinite(v)))].sort((a, b) => a - b);
  if (sorted.length < 2) return () => 100;
  return (volume) => {
    const below = sorted.filter((v) => v < volume).length;
    const percentile = below / (sorted.length - 1);
    return Math.round(25 + 75 * percentile);
  };
}

function rec({ type, title, action, targetUrl = null, impact, evidence = {} }) {
  const effort = EFFORT[type] || 3;
  return {
    type,
    title,
    action,
    target_url: targetUrl,
    impact: Math.round(impact * 100) / 100,
    effort,
    priority: Math.round((impact / effort) * 100) / 100,
    evidence
  };
}

export async function buildRecommendations(projectId) {
  const project = (
    await many('SELECT * FROM projects WHERE id = $1', [projectId])
  )[0];
  if (!project) return [];

  const latest = await many(
    'SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok',
    [projectId]
  );
  const cycle = latest[0]?.d;
  if (!cycle) return [];

  const prior = await many(
    'SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok AND cycle_date < $2',
    [projectId, cycle]
  );
  const priorCycle = prior[0]?.d || null;

  const stats = await many(
    `SELECT p.id AS prompt_id, p.text, p.cluster, p.ai_search_volume,
            r.engine, e.id AS entity_id, e.name, e.kind, e.domain,
            COUNT(r.id)::int AS runs,
            SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::int AS hits,
            AVG(m.ordinal)::float AS avg_ordinal,
            SUM(CASE WHEN m.sentiment = 'negative' THEN 1 ELSE 0 END)::int AS negatives,
            (ARRAY_AGG(m.snippet) FILTER (WHERE m.snippet IS NOT NULL))[1] AS snippet,
            (ARRAY_AGG(r.id))[1]::int AS sample_run
     FROM runs r
     JOIN prompts p ON p.id = r.prompt_id
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id
     WHERE r.project_id = $1 AND r.cycle_date = $2 AND r.ok
     GROUP BY p.id, r.engine, e.id`,
    [projectId, cycle]
  );

  // Which domains took the citation, per question, so the advice can name them.
  const perPrompt = await many(
    `SELECT r.prompt_id, c.domain, MIN(c.url) AS url, COUNT(*)::int AS n
     FROM citations c
     JOIN runs r ON r.id = c.run_id
     WHERE r.project_id = $1 AND r.cycle_date = $2
     GROUP BY r.prompt_id, c.domain
     ORDER BY n DESC`,
    [projectId, cycle]
  );

  /**
   * Which questions each source shapes, not just how many.
   *
   * "keyspacerealty.com shapes 15 of your questions" is only actionable if
   * you can see the fifteen. One sample question was the least useful part
   * of an otherwise specific action.
   */
  const { isWrapper } = await import('./resolve.js');

  /**
   * A redirect wrapper is not a source. Telling someone that
   * "vertexaisearch.cloud.google.com shapes 53 of your questions" is a bug
   * presented as a finding, and there is nothing they could do about it.
   * Filtered here rather than downstream so no later rule can reintroduce it.
   */
  const sourceRows = (await many(
    `WITH per_prompt AS (
       SELECT c.domain, r.prompt_id, p.text AS question,
              COUNT(*)::int AS hits,
              MIN(c.position)::int AS best_position,
              (ARRAY_AGG(c.url ORDER BY c.position))[1] AS url
       FROM citations c
       JOIN runs r ON r.id = c.run_id
       JOIN prompts p ON p.id = r.prompt_id
       WHERE r.project_id = $1 AND r.cycle_date = $2
       GROUP BY c.domain, r.prompt_id, p.text
     )
     SELECT domain,
            SUM(hits)::int AS n,
            COUNT(*)::int AS prompts,
            (ARRAY_AGG(url ORDER BY best_position))[1] AS sample_url,
            (ARRAY_AGG(question ORDER BY best_position))[1] AS sample_question,
            JSONB_AGG(
              JSONB_BUILD_OBJECT('question', question, 'url', url, 'hits', hits)
              ORDER BY hits DESC, best_position
            ) AS questions
     FROM per_prompt
     GROUP BY domain
     ORDER BY n DESC`,
    [projectId, cycle]
  )).filter((s) => !isWrapper(`https://${s.domain}/`));

  const ownCited = await many(
    `SELECT r.prompt_id, COUNT(*)::int AS n
     FROM citations c
     JOIN runs r ON r.id = c.run_id
     WHERE r.project_id = $1 AND r.cycle_date = $2 AND c.domain = $3
     GROUP BY r.prompt_id`,
    [projectId, cycle, project.domain.replace(/^www\./, '')]
  );
  const ownCitedByPrompt = new Map(ownCited.map((r) => [r.prompt_id, r.n]));

  let priorRates = new Map();
  if (priorCycle) {
    const rows = await many(
      `SELECT r.prompt_id,
              SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS rate
       FROM runs r
       JOIN mentions m ON m.run_id = r.id
       JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
       WHERE r.project_id = $1 AND r.cycle_date = $2 AND r.ok
       GROUP BY r.prompt_id`,
      [projectId, priorCycle]
    );
    priorRates = new Map(rows.map((r) => [r.prompt_id, Number(r.rate)]));
  }

  const fanOutRows = await many(
    `SELECT r.prompt_id, q AS query, COUNT(*)::int AS n
     FROM runs r, UNNEST(r.fan_out_queries) AS q
     WHERE r.project_id = $1 AND r.cycle_date = $2 AND r.ok
     GROUP BY r.prompt_id, q
     ORDER BY n DESC`,
    [projectId, cycle]
  );
  const fanOutByPrompt = new Map();
  for (const row of fanOutRows) {
    if (!fanOutByPrompt.has(row.prompt_id)) fanOutByPrompt.set(row.prompt_id, []);
    const list = fanOutByPrompt.get(row.prompt_id);
    if (list.length < 5) list.push({ query: row.query, n: row.n });
  }

  // Which domains took the citation, per question. Rule 2 needs this to say
  // who got the click, and its absence was throwing the whole engine.
  const citationRows = await many(
    `SELECT r.prompt_id, c.domain, MIN(c.url) AS url, MIN(c.position)::int AS position, COUNT(*)::int AS n
     FROM citations c
     JOIN runs r ON r.id = c.run_id
     WHERE r.project_id = $1 AND r.cycle_date = $2 AND r.ok
     GROUP BY r.prompt_id, c.domain
     ORDER BY MIN(c.position)`,
    [projectId, cycle]
  );
  const citedByPrompt = new Map();
  for (const row of citationRows) {
    if (!citedByPrompt.has(row.prompt_id)) citedByPrompt.set(row.prompt_id, []);
    const list = citedByPrompt.get(row.prompt_id);
    if (list.length < 8) list.push({ domain: row.domain, url: row.url, position: row.position, n: row.n });
  }

  const ga4 = await many(
    `SELECT landing_page,
            SUM(sessions)::int AS sessions,
            SUM(conversions)::float AS conversions,
            SUM(revenue)::float AS revenue
     FROM ga4_daily
     WHERE project_id = $1 AND date > CURRENT_DATE - INTERVAL '30 days'
       AND landing_page IS NOT NULL
     GROUP BY landing_page
     ORDER BY sessions DESC
     LIMIT 25`,
    [projectId]
  );

  return evaluateRules({ project, stats, sourceRows, ownCitedByPrompt, citedByPrompt, priorRates, ga4, fanOutByPrompt });
}

/**
 * Pure rule evaluation. No database access, so it can be tested with fixtures
 * and reasoned about on its own.
 */
export function evaluateRules({
  project,
  stats,
  sourceRows = [],
  ownCitedByPrompt = new Map(),
  citedByPrompt = new Map(),
  priorRates = new Map(),
  ga4 = [],
  fanOutByPrompt = new Map()
}) {
  /* ---- reshape into per-prompt views ---- */

  // Needed by several rules, so defined once up front rather than beside the
  // first rule that happened to use it.
  const ownDomain = String(project.domain || '').replace(/^www\./, '');
  const competitorDomains = [
    ...new Set(stats.filter((r) => r.kind === 'competitor' && r.domain).map((r) => String(r.domain).replace(/^www\./, '')))
  ];

  const prompts = new Map();
  for (const row of stats) {
    if (!prompts.has(row.prompt_id)) {
      prompts.set(row.prompt_id, {
        citedDomains: citedByPrompt.get(row.prompt_id) || [],
        id: row.prompt_id,
        text: row.text,
        cluster: row.cluster,
        volume: row.ai_search_volume,
        byEngine: new Map(),
        owned: { runs: 0, hits: 0, ordinalSum: 0, ordinalN: 0, negatives: 0, snippet: null, sampleRun: null },
        competitors: new Map()
      });
    }
    const p = prompts.get(row.prompt_id);

    if (row.kind === 'owned') {
      p.owned.runs += row.runs;
      p.owned.hits += row.hits;
      if (row.avg_ordinal) {
        p.owned.ordinalSum += row.avg_ordinal * row.hits;
        p.owned.ordinalN += row.hits;
      }
      p.owned.negatives += row.negatives;
      if (!p.owned.snippet && row.snippet) p.owned.snippet = row.snippet;
      if (!p.owned.sampleRun) p.owned.sampleRun = row.sample_run;

      const eng = p.byEngine.get(row.engine) || { runs: 0, hits: 0 };
      eng.runs += row.runs;
      eng.hits += row.hits;
      p.byEngine.set(row.engine, eng);
    } else {
      const c = p.competitors.get(row.entity_id) || { name: row.name, domain: row.domain, runs: 0, hits: 0 };
      c.runs += row.runs;
      c.hits += row.hits;
      p.competitors.set(row.entity_id, c);
    }
  }

  const out = [];
  const rivalGaps = new Map();
  const rate = (hits, runs) => (runs ? hits / runs : 0);
  const norm = makeScorer([...prompts.values()].map((p) => p.volume));

  for (const p of prompts.values()) {
    const ownRate = rate(p.owned.hits, p.owned.runs);
    const volumeScore = norm(p.volume);
    const avgOrdinal = p.owned.ordinalN ? p.owned.ordinalSum / p.owned.ordinalN : null;
    const cited = ownCitedByPrompt.get(p.id) || 0;

    const fanOut = fanOutByPrompt.get(p.id) || [];
    const topQuery = fanOut[0]?.query || null;

    /* Rule 1: invisible on a question that matters */
    if (ownRate === 0 && p.owned.runs >= 2) {
      const rivals = [...p.competitors.values()]
        .filter((c) => rate(c.hits, c.runs) >= 0.5)
        .map((c) => c.name)
        .slice(0, 3);

      out.push(
        rec({
          type: 'content_gap',
          title: `Invisible for: "${p.text}"`,
          action:
            `You were not named in ${p.owned.runs} measured answers. This does not establish why. ` +
            (topQuery ? `The stored search trace includes "${topQuery}". A search trace does not establish your ranking or explain source selection. ` : '') +
            'Read the original answers and cited pages, confirm the question fits your buyers, and identify any specific missing information on your relevant page. ' +
            'Update that page only if the review supports a change. Pause irrelevant questions. Record what you reviewed and use a later measurement to check the outcome.',
          impact: volumeScore * 1.0,
          evidence: {
            prompt_id: p.id,
            prompt: p.text,
            runs: p.owned.runs,
            own_rate: 0,
            cluster: p.cluster,
            queries: topQuery ? fanOut.map((f) => f.query) : undefined
          }
        })
      );
    }

    /* Rule 2: named in the answer but your site is never the source */
    if (ownRate > 0 && cited === 0) {
      out.push(
        rec({
          type: 'citable_asset',
          title: "Review mentions and source links" + `: ${p.text}`,
          action: citableAdvice(p, ownDomain, competitorDomains),
          impact: volumeScore * 0.8 * ownRate,
          evidence: {
            prompt_id: p.id,
            prompt: p.text,
            own_rate: Math.round(ownRate * 100),
            citations: 0,
            took_the_citation: whoTookIt(p, ownDomain, competitorDomains).slice(0, 4),
            url: (p.citedDomains || [])[0]?.url || null,
            question: p.text,
            analysable: Boolean((p.citedDomains || [])[0]?.url)
          }
        })
      );
    }

    /* Rule 3: your page is a source but the brand is not being named */
    if (cited > 0 && ownRate < 0.4) {
      out.push(
        rec({
          type: 'entity_authority',
          title: "Review citations and brand naming" + `: ${p.text}`,
          action: "This task records citations alongside a low rate of brand naming. Compare the cited page with the answer. Check whether the brand identity is accurate and whether naming it is relevant to the question. Correct a specific identity error if found. A citation without a name does not diagnose a schema problem.",
          impact: volumeScore * 0.7,
          evidence: { prompt_id: p.id, prompt: p.text, own_rate: Math.round(ownRate * 100), citations: cited }
        })
      );
    }

    /* Rule 4: present but buried */
    if (ownRate >= 0.3 && avgOrdinal && avgOrdinal >= 3) {
      out.push(
        rec({
          type: 'ordinal_push',
          title: "Review where the brand appears" + `: ${p.text}`,
          action: "This task flagged the brand's recorded position in answers. Read the original list and check whether its order expresses a ranking. An extracted position is not a measure of attention or preference. Record any factual omission or misleading comparison you can substantiate. Do not commission extra references solely to change this position.",
          impact: volumeScore * 0.5 * (avgOrdinal / 5),
          evidence: { prompt_id: p.id, prompt: p.text, avg_ordinal: Number(avgOrdinal.toFixed(2)) }
        })
      );
    }

    /* Rule 5: note where a competitor leads. Rolled up after the loop, because
       review one grouped evidence task per rival, not one per question. */
    for (const c of p.competitors.values()) {
      const cRate = rate(c.hits, c.runs);
      if (cRate - ownRate >= 0.4 && cRate >= 0.5) {
        if (!rivalGaps.has(c.name)) {
          rivalGaps.set(c.name, { name: c.name, domain: c.domain, questions: [], gapSum: 0, impact: 0 });
        }
        const g = rivalGaps.get(c.name);
        g.questions.push({ prompt_id: p.id, text: p.text, theirs: Math.round(cRate * 100), yours: Math.round(ownRate * 100), own_runs: p.owned.runs, competitor_runs: c.runs });
        g.gapSum += cRate - ownRate;
        g.impact += volumeScore * (cRate - ownRate);
      }
    }

    /* Rule 6: strong on one engine, absent on another */
    const engineRates = [...p.byEngine.entries()].map(([engine, v]) => ({ engine, r: rate(v.hits, v.runs) }));
    if (engineRates.length >= 2) {
      const best = engineRates.reduce((a, b) => (b.r > a.r ? b : a));
      const worst = engineRates.reduce((a, b) => (b.r < a.r ? b : a));
      if (best.r >= 0.5 && worst.r <= 0.15) {
        out.push(
          rec({
            type: 'engine_gap',
            title: "Compare answers across engines" + `: ${p.text}`,
          action: "This task flagged different brand-naming rates across engines in its stored sample. Read each engine's answers and check sample sizes, question wording, dates and model settings. Different engines may answer the same question differently. Investigate a specific content or access issue only if the evidence supports it. An engine gap alone does not prove a crawling, indexing or profile problem.",
          impact: volumeScore * 0.45,
            evidence: { prompt_id: p.id, prompt: p.text, best: best.engine, worst: worst.engine }
          })
        );
      }
    }

    /* Rule 7: the model is describing you badly */
    if (p.owned.negatives > 0) {
      out.push(
        rec({
          type: 'sentiment_correction',
          title: "Review a flagged brand description" + `: ${p.text}`,
          action: "An automated check flagged negative language. Its interpretation needs review. Read the full answer to confirm that the language refers to your brand and is inaccurate or misleading. Check any linked source independently. Correct a verified error in material you control, or request a correction with evidence. Do not assume a cited page caused the wording or publish a response before checking.",
          impact: volumeScore * 0.9,
          evidence: { prompt_id: p.id, prompt: p.text, snippet: p.owned.snippet, run_id: p.owned.sampleRun }
        })
      );
    }

    /* Rule 8: the search the engine ran, when there is no content gap to fold it into */
    if (fanOut.length && ownRate > 0 && ownRate < 0.5) {
      const list = fanOut.map((f) => `"${f.query}"`).join(', ');
      out.push(
        rec({
          type: 'fanout_target',
          title: "Review recorded search queries" + `: ${p.text}`,
          action: "This task includes search queries recorded during answer collection. Compare the recorded queries with the buyer question and sources. A trace does not establish your search rank or explain source selection. Use a relevant query as a research lead. Validate buyer intent and any missing information before choosing a page change. Page-one ranking is not established here as a requirement for AI inclusion." + ` Recorded queries: ${list}.`,
          impact: volumeScore * 0.75 * (1 - ownRate),
          evidence: { prompt_id: p.id, prompt: p.text, queries: fanOut.map((f) => f.query), own_rate: Math.round(ownRate * 100) }
        })
      );
    }

    /* Rule 9: it got worse */
    const before = priorRates.get(p.id);
    if (before !== undefined && before - ownRate >= 0.2) {
      out.push(
        rec({
          type: 'decline_alert',
          title: "Review a possible measurement change" + `: ${p.text}`,
          action: "Stored cycle summaries differ. This card alone does not establish a like-for-like decline. Open the trend view and compare the same questions and engines, including sample sizes and measurement-method changes. Only investigate a decline after confirming a comparable cohort. Record a supported finding rather than assuming competitors or indexing caused the difference.",
          impact: volumeScore * (before - ownRate) * 1.2,
          evidence: { prompt_id: p.id, prompt: p.text, before: Math.round(before * 100), now: Math.round(ownRate * 100) }
        })
      );
    }
  }

  /* Rule 5, emitted: one comparison job per rival, not one per question */
  for (const g of rivalGaps.values()) {
    const n = g.questions.length;
    const avgTheirs = Math.round(g.questions.reduce((a, q) => a + q.theirs, 0) / n);
    const avgYours = Math.round(g.questions.reduce((a, q) => a + q.yours, 0) / n);
    const examples = g.questions
      .slice(0, 3)
      .map((q) => `"${q.text}"`)
      .join(', ');

    out.push(
      rec({
        type: 'competitor_comparison',
        title: `${g.name} beats you on ${n} question${n > 1 ? 's' : ''}`,
        action:
          `Observed: ${g.name} was named more often on ${n} tracked question${n > 1 ? 's' : ''}. Examples: ${examples}. ` +
          `Check next: inspect the original answers and cited pages for the same buyer need and market. ` +
          `Action supported now: investigate the gap. Consider a comparison page only if the evidence identifies a relevant buyer comparison your content does not answer. ` +
          `This result alone does not explain the competitor's appearance or establish that a content change will improve visibility.`,
        targetUrl: g.domain ? `https://${g.domain}` : null,
        impact: Math.min(100, g.impact / Math.max(1, Math.sqrt(n))),
        evidence: {
          competitor: g.name,
          competitor_rate: avgTheirs,
          own_rate: avgYours,
          // Both rates per question, so "they beat you on 6 questions" can be
          // opened and read rather than taken on trust.
          questions: g.questions.slice(0, 25).map((q) => ({
            question: q.text,
            prompt_id: q.prompt_id,
            own_runs: q.own_runs,
            competitor_runs: q.competitor_runs,
            own_rate: q.yours,
            competitor_rate: q.theirs
          }))
        }
      })
    );
  }

  /* Rule 10: sources that shape your category, with advice that fits the source */

  for (const s of sourceRows.slice(0, 15)) {
    if (s.prompts < 2) continue;
    const { kind, reachable } = classifySource(s.domain, { ownDomain, competitorDomains });
    if (kind === 'own') continue;

    // Worth knowing about, but a source you cannot appear on is not a task in
    // the same sense, so it should not outrank things you can act on.
    const weight = reachable ? 1 : 0.55;

    out.push(
      rec({
        type: kind === 'competitor' ? 'competitor_page' : 'source_gap',
        title: `Review whether ${s.domain} answers your buyers' questions`,
        action: 'Check the question, original answer and cited page for the same buyer need. A citation alone does not justify copying page features, claiming a listing or doing outreach. Review relevance first. One page analysis does not validate every question on this card.',
        targetUrl: s.sample_url,
        impact: Math.min(100, s.n * 6) * weight,
        evidence: {
          domain: s.domain,
          citations: s.n,
          prompts: s.prompts,
          sourceKind: kind,
          reachable,
          analysable: Boolean(s.sample_url),
          url: s.sample_url,
          question: s.sample_question || null,
          // The whole list, so "15 of your questions" can be read rather
          // than taken on trust. Capped so the row stays a reasonable size.
          questions: (s.questions || []).slice(0, 25)
        }
      })
    );
  }

  /* Rule 11: a page that AI traffic already converts on */
  if (ga4.length) {
    const totalSessions = ga4.reduce((a, r) => a + r.sessions, 0);
    const totalConv = ga4.reduce((a, r) => a + r.conversions, 0);
    const avgCvr = totalSessions ? totalConv / totalSessions : 0;
    for (const row of ga4.slice(0, 5)) {
      const cvr = row.sessions ? row.conversions / row.sessions : 0;
      if (row.sessions >= 20 && cvr > avgCvr * 1.3) {
        out.push(
          rec({
            type: 'replicate_winner',
            title: "Review a page's AI referral outcomes" + `: ${row.landing_page}`,
          action: "This task flagged a page from the available GA4 referral data. Inspect the reporting dates, attribution, session count and configured conversion events. Event counts may exceed the number of sessions and are not necessarily converted sessions. Check what users did before proposing a change. A high events-per-session ratio does not prove a page format caused conversions or will improve AI visibility elsewhere.",
          targetUrl: row.landing_page,
            impact: Math.min(100, row.sessions * 1.5),
            evidence: { sessions: row.sessions, conversions: row.conversions, revenue: row.revenue }
          })
        );
      }
    }
  }

  /* One question should not fill the screen. Keep the two strongest actions
     per question; the rest stay measurable but do not clutter the list. */
  const perPrompt = new Map();
  const capped = [];
  for (const r of out.sort((a, b) => b.priority - a.priority)) {
    const id = r.evidence.prompt_id;
    if (id === undefined) {
      capped.push(r);
      continue;
    }
    const seen = perPrompt.get(id) || 0;
    if (seen >= 2) continue;
    perPrompt.set(id, seen + 1);
    capped.push(r);
  }

  return capped.sort((a, b) => b.priority - a.priority);
}

/** Upsert into the recommendations table, keeping human status changes intact. */
export async function persistRecommendations(projectId, recs) {
  const written = [];
  // Anything the customer deleted outright stays gone, rather than returning
  // on the next cycle under the same fingerprint.
  const suppressed = new Set(
    (await many('SELECT fingerprint FROM recommendation_suppressions WHERE project_id = $1', [projectId]))
      .map((r) => r.fingerprint)
  );

  for (const r of recs) {
    const key = r.evidence.prompt_id || r.evidence.domain || r.target_url || r.title;
    const fingerprint = `${r.type}:${key}`;
    if (suppressed.has(fingerprint)) continue;
    written.push(fingerprint);

    // Keep a record per cycle. Without it the table shows only what is true
    // today, and "this has been true for eight weeks" cannot be said.
    await query(
      `INSERT INTO recommendation_history (project_id, cycle_date, fingerprint, type, title, target_url, priority, evidence)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id, cycle_date, fingerprint) DO UPDATE SET priority = EXCLUDED.priority, evidence = EXCLUDED.evidence`,
      [projectId, fingerprint, r.type, r.title, r.targetUrl || null, r.priority || 0, JSON.stringify(r.evidence || {})]
    );
    await query(
      `INSERT INTO recommendations
         (project_id, fingerprint, type, title, action, target_url, impact, effort, priority, evidence, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (project_id, fingerprint) DO UPDATE SET
         title = EXCLUDED.title,
         action = EXCLUDED.action,
         impact = EXCLUDED.impact,
         priority = EXCLUDED.priority,
         evidence = EXCLUDED.evidence,
         updated_at = now()`,
      [
        projectId,
        fingerprint,
        r.type,
        r.title,
        r.action,
        r.target_url,
        r.impact,
        r.effort,
        r.priority,
        JSON.stringify(r.evidence)
      ]
    );
  }

  /**
   * Remove actions the evidence no longer supports.
   *
   * Recommendations were only ever written, never withdrawn, so an action
   * survived after the thing behind it was gone. Repointing citations away
   * from a redirect wrapper left "vertexaisearch.cloud.google.com shapes 53
   * of your questions" sitting in the list with nothing underneath it.
   *
   * Work in progress is kept: someone who has started or finished a task
   * should not find it vanished because this cycle read the world slightly
   * differently.
   */
  // Collected as each one is written, since the fingerprint is derived in the
  // loop above rather than carried on the recommendation.

  // A rebuild that produced nothing is a failure, not a reason to empty the
  // board.
  if (!written.length) return { written: 0, withdrawn: 0 };

  const stale = await many(
    `SELECT id, title FROM recommendations
     WHERE project_id = $1 AND status = 'open' AND NOT (fingerprint = ANY($2::text[]))`,
    [projectId, written]
  );

  if (stale.length) {
    await query(
      `DELETE FROM recommendations
       WHERE project_id = $1 AND status = 'open' AND NOT (fingerprint = ANY($2::text[]))`,
      [projectId, written]
    );
  }

  return { written: recs.length, withdrawn: stale.length };

}
