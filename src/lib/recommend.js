import { many, query } from '../db/index.js';

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
  engine_gap: 2,
  sentiment_correction: 3,
  decline_alert: 1,
  replicate_winner: 2
};

const AGGREGATOR_HINT = /(clutch|g2|capterra|trustpilot|reddit|quora|designrush|sortlist|yelp|tripadvisor|wikipedia|linkedin|glassdoor|producthunt|crunchbase)/i;

function norm(volume) {
  // 0 to 100, compressing the long tail so one huge prompt cannot dominate.
  return Math.min(100, Math.round(Math.sqrt(Math.max(0, volume)) * 4.5));
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

  const sourceRows = await many(
    `SELECT c.domain,
            COUNT(*)::int AS n,
            COUNT(DISTINCT r.prompt_id)::int AS prompts,
            MIN(c.url) AS sample_url
     FROM citations c
     JOIN runs r ON r.id = c.run_id
     WHERE r.project_id = $1 AND r.cycle_date = $2
     GROUP BY c.domain
     ORDER BY n DESC`,
    [projectId, cycle]
  );

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

  return evaluateRules({ project, stats, sourceRows, ownCitedByPrompt, priorRates, ga4 });
}

/**
 * Pure rule evaluation. No database access, so it can be tested with fixtures
 * and reasoned about on its own.
 */
export function evaluateRules({ project, stats, sourceRows = [], ownCitedByPrompt = new Map(), priorRates = new Map(), ga4 = [] }) {
  /* ---- reshape into per-prompt views ---- */

  const prompts = new Map();
  for (const row of stats) {
    if (!prompts.has(row.prompt_id)) {
      prompts.set(row.prompt_id, {
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
  const rate = (hits, runs) => (runs ? hits / runs : 0);

  for (const p of prompts.values()) {
    const ownRate = rate(p.owned.hits, p.owned.runs);
    const volumeScore = norm(p.volume);
    const avgOrdinal = p.owned.ordinalN ? p.owned.ordinalSum / p.owned.ordinalN : null;
    const cited = ownCitedByPrompt.get(p.id) || 0;

    /* Rule 1: invisible on a question that matters */
    if (ownRate === 0 && p.owned.runs >= 2) {
      out.push(
        rec({
          type: 'content_gap',
          title: `Invisible for: "${p.text}"`,
          action:
            `No answer engine named you across ${p.owned.runs} runs. Publish or rewrite a page that answers this question directly. ` +
            `Put a plain 40 to 60 word answer in the first paragraph before any preamble, use the question itself as an H2, and add a named-entity sentence ` +
            `("${project.brand_name} is a ...") so a model can attribute the answer to you.`,
          impact: volumeScore * 1.0,
          evidence: { prompt_id: p.id, prompt: p.text, runs: p.owned.runs, own_rate: 0, cluster: p.cluster }
        })
      );
    }

    /* Rule 2: named in the answer but your site is never the source */
    if (ownRate > 0 && cited === 0) {
      out.push(
        rec({
          type: 'citable_asset',
          title: `Mentioned but never cited for "${p.text}"`,
          action:
            `Models name you here but pull the supporting detail from elsewhere, so you get no click and no control of the framing. ` +
            `Add something quotable to the matching page: an original statistic, a pricing table, a spec comparison, or a dated methodology note. ` +
            `Models cite pages that carry facts they cannot paraphrase from memory.`,
          impact: volumeScore * 0.8 * ownRate,
          evidence: { prompt_id: p.id, prompt: p.text, own_rate: Math.round(ownRate * 100), citations: 0 }
        })
      );
    }

    /* Rule 3: your page is a source but the brand is not being named */
    if (cited > 0 && ownRate < 0.4) {
      out.push(
        rec({
          type: 'entity_authority',
          title: `Cited as a source but rarely named for "${p.text}"`,
          action:
            `Your page feeds the answer but the brand does not survive into it. This is an entity problem, not a content problem. ` +
            `Add Organization schema with sameAs pointing at your Companies House, LinkedIn and review profiles, make sure the brand name appears in the ` +
            `first sentence of the page, and keep naming consistent across every third-party profile.`,
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
          title: `Listed ${avgOrdinal.toFixed(1)} on average for "${p.text}"`,
          action:
            `You appear but late in the list, where almost nobody reads. Position is driven by corroboration across sources. ` +
            `Get three additional independent references for this specific claim, ideally a review platform, an industry roundup and a first-party case study with named results.`,
          impact: volumeScore * 0.5 * (avgOrdinal / 5),
          evidence: { prompt_id: p.id, prompt: p.text, avg_ordinal: Number(avgOrdinal.toFixed(2)) }
        })
      );
    }

    /* Rule 5: a competitor owns this question */
    for (const c of p.competitors.values()) {
      const cRate = rate(c.hits, c.runs);
      if (cRate - ownRate >= 0.4 && cRate >= 0.5) {
        out.push(
          rec({
            type: 'competitor_comparison',
            title: `${c.name} owns "${p.text}"`,
            action:
              `${c.name} appears in ${Math.round(cRate * 100)}% of answers here against your ${Math.round(ownRate * 100)}%. ` +
              `Build a page that addresses the comparison honestly, including where they are the better fit. Balanced comparison pages get cited far more often ` +
              `than one-sided ones, because models are trained to prefer sources that acknowledge trade-offs.`,
            impact: volumeScore * (cRate - ownRate),
            evidence: {
              prompt_id: p.id,
              prompt: p.text,
              competitor: c.name,
              competitor_rate: Math.round(cRate * 100),
              own_rate: Math.round(ownRate * 100)
            }
          })
        );
      }
    }

    /* Rule 6: strong on one engine, absent on another */
    const engineRates = [...p.byEngine.entries()].map(([engine, v]) => ({ engine, r: rate(v.hits, v.runs) }));
    if (engineRates.length >= 2) {
      const best = engineRates.reduce((a, b) => (b.r > a.r ? b : a));
      const worst = engineRates.reduce((a, b) => (b.r < a.r ? b : a));
      if (best.r >= 0.5 && worst.r <= 0.15) {
        const fix =
          worst.engine === 'perplexity'
            ? 'Perplexity leans hard on freshly crawled pages. Check the page is indexed, refresh the publish date with a real update, and confirm your robots.txt allows PerplexityBot and Perplexity-User.'
            : worst.engine === 'gemini'
              ? 'Gemini leans on Google surfaces. Check the Business Profile, make sure the entity is consistent across Google properties, and confirm the page ranks in classic organic for the same question.'
              : 'Check that the source pages this engine favours allow its crawler, and that your content exists in a plain HTML form rather than requiring JavaScript to read.';
        out.push(
          rec({
            type: 'engine_gap',
            title: `Strong on ${best.engine}, absent on ${worst.engine}`,
            action: `${Math.round(best.r * 100)}% on ${best.engine} against ${Math.round(worst.r * 100)}% on ${worst.engine} for "${p.text}". ${fix}`,
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
          title: `Unflattering framing for "${p.text}"`,
          action:
            `An answer characterised you negatively. Read the excerpt, trace which source it came from, and correct it at the source: ` +
            `respond publicly to the review, update the outdated page, or publish a clearer statement of what you do. Models repeat what the open web says about you.`,
          impact: volumeScore * 0.9,
          evidence: { prompt_id: p.id, prompt: p.text, snippet: p.owned.snippet, run_id: p.owned.sampleRun }
        })
      );
    }

    /* Rule 8: it got worse */
    const before = priorRates.get(p.id);
    if (before !== undefined && before - ownRate >= 0.2) {
      out.push(
        rec({
          type: 'decline_alert',
          title: `Visibility fell ${Math.round((before - ownRate) * 100)} points for "${p.text}"`,
          action:
            `Down from ${Math.round(before * 100)}% to ${Math.round(ownRate * 100)}% since the last cycle. ` +
            `Check whether a source that used to cite you has changed, whether a competitor published something new, and whether the page is still indexed.`,
          impact: volumeScore * (before - ownRate) * 1.2,
          evidence: { prompt_id: p.id, prompt: p.text, before: Math.round(before * 100), now: Math.round(ownRate * 100) }
        })
      );
    }
  }

  /* Rule 9: sources that shape your category and do not include you */
  const ownDomain = project.domain.replace(/^www\./, '');
  for (const s of sourceRows.slice(0, 15)) {
    if (s.domain === ownDomain) continue;
    if (s.prompts < 2) continue;
    const isAggregator = AGGREGATOR_HINT.test(s.domain);
    out.push(
      rec({
        type: 'source_gap',
        title: `${s.domain} shapes ${s.prompts} of your questions`,
        action: isAggregator
          ? `This platform is cited across ${s.prompts} tracked questions. Claim and complete your profile, get recent reviews posted, and make sure your listed services use the same wording as the questions you want to win.`
          : `Cited across ${s.prompts} tracked questions and you are not on it. Pitch a contribution, request inclusion in the relevant roundup, or earn a mention. This is digital PR with a measurable target rather than a vanity link.`,
        targetUrl: s.sample_url,
        impact: Math.min(100, s.n * 6),
        evidence: { domain: s.domain, citations: s.n, prompts: s.prompts }
      })
    );
  }

  /* Rule 10: a page that AI traffic already converts on */
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
            title: `${row.landing_page} converts AI traffic at ${(cvr * 100).toFixed(1)}%`,
            action:
              `This page takes AI assistant traffic and converts it well above your ${(avgCvr * 100).toFixed(1)}% average. ` +
              `Work out what shape it has, usually a direct answer up top, a table, and a clear next step, and apply the same structure to the pages tied to your zero-visibility questions.`,
            targetUrl: row.landing_page,
            impact: Math.min(100, row.sessions * 1.5),
            evidence: { sessions: row.sessions, conversions: row.conversions, revenue: row.revenue }
          })
        );
      }
    }
  }

  return out.sort((a, b) => b.priority - a.priority);
}

/** Upsert into the recommendations table, keeping human status changes intact. */
export async function persistRecommendations(projectId, recs) {
  for (const r of recs) {
    const key = r.evidence.prompt_id || r.evidence.domain || r.target_url || r.title;
    const fingerprint = `${r.type}:${key}`;
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
  return recs.length;
}
