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

/**
 * Being named without being cited is the most common and least understood
 * state in AI search, and the reason is structural rather than accidental.
 *
 * Asked directly why it had recommended a development without citing the
 * developer, ChatGPT answered plainly: "a developer's website is naturally
 * promotional". The models prefer sources that read as independent, so a
 * brand's own site loses the citation to a portal even when the brand owns
 * the authoritative facts.
 *
 * That means the fix is not "write better marketing copy". It is to make the
 * page read as a reference document, and to earn corroboration on whichever
 * independent source is currently taking the citation.
 */
function citableAdvice(prompt, ownDomain, competitorDomains) {
  const took = whoTookIt(prompt, ownDomain, competitorDomains);
  const portals = took.filter((t) => t.kind === 'directory' || t.kind === 'portal');
  const news = took.filter((t) => t.kind === 'news' || t.kind === 'publisher');
  const community = took.filter((t) => t.kind === 'community');
  const rivals = took.filter((t) => t.kind === 'competitor');

  const opening = took.length
    ? `You are named in the answer, but the citation went to ${took.slice(0, 3).map((t) => t.domain).join(', ')}. ` +
      `You get the recommendation, they get the click.`
    : `You are named in the answer, but nothing on your site was used as a source, so you get the mention without the click.`;

  /**
   * Observed directly: asked why it had not cited a developer's own site for
   * facts about that developer's own project, ChatGPT called it an oversight
   * and produced the correct citation immediately. It was not a knowledge
   * problem. The model defaulted to portals because a company's own site
   * reads as promotional, and portals read as neutral.
   *
   * That distinction is what makes this fixable, and it dictates the split
   * below: own the facts only you can verify, and let independent sources
   * carry the ones you would never be trusted on.
   */
  const why =
    `This is structural rather than accidental. Models treat a company's own site as promotional and prefer a source ` +
    `that reads as independent, even when you hold the authoritative facts about your own product. Pushed on it, they ` +
    `will concede your site is the primary source. They just do not reach for it unprompted.`;

  const split =
    `Split the work accordingly. Your own page should own the facts only you can verify: specifications, capacity, ` +
    `what is included, timelines, coverage, official figures. Those are the claims a model cannot get anywhere else, ` +
    `and they are what it will cite you for. Do not fight for the claims you will never be trusted on, such as what ` +
    `something really costs in the market, what the experience is actually like, or how you compare with a rival. ` +
    `Those need to come from somewhere else.`;

  const fix = [
    `Rewrite the matching page to read as reference material rather than marketing: hard numbers, a specification table, ` +
      `a visible last-updated date, a named author, and a heading that states the question a buyer types. Facts a model ` +
      `cannot paraphrase from memory are the ones that earn a citation.`,
    portals.length
      ? `${portals[0].domain} is being read as the neutral account of you. Make sure your listing there is accurate and ` +
        `current, because right now it is speaking on your behalf.`
      : null,
    news.length
      ? `Earn a mention on ${news[0].domain}. Third-party corroboration is what lets a model cite a claim about you ` +
        `without depending on you for it.`
      : null,
    community.length
      ? `${community[0].domain} is shaping this answer. You cannot buy your way in, but answering honestly from a real ` +
        `account with history does work.`
      : null,
    rivals.length
      ? `${rivals[0].domain} is a competitor and you will never appear on it. Run the page teardown on this action to ` +
        `see which structural features earned it the citation, then match them.`
      : null
  ].filter(Boolean);

  return `${opening} ${why} ${split} ${fix.join(' ')}`;
}


/**
 * Advice per kind of source. The distinction that matters is whether you can
 * realistically appear on it at all: telling someone to pitch a contribution
 * to a competitor's homepage is worse than saying nothing.
 */
const SOURCE_ADVICE = {
  directory: {
    effort: 2,
    title: (d, n) => `Claim your profile on ${d}`,
    action: (d, n) =>
      `${d} is cited across ${n} of your tracked questions, and you are not in what it returns. This is the cheapest gap on the list to close. ` +
      `Claim and complete the profile, get recent reviews posted, and make sure the services you list use the same wording as the questions you want to win. ` +
      `Directories are cited because they read as neutral third-party summaries, so the profile matters more than the link.`
  },
  community: {
    effort: 3,
    title: (d, n) => `${d} shapes ${n} of your answers`,
    action: (d, n) =>
      `Engines lean on ${d} because it reads as unfiltered opinion. You cannot buy your way in, and an obvious plant will be downvoted and may be held against you. ` +
      `The workable version is to answer questions in your category honestly, from a real account with history, disclosing who you are. ` +
      `One genuinely useful answer to an existing thread is worth more than a new post about yourself.`
  },
  competitor: {
    effort: 4,
    title: (d, n) => `A competitor's own site is answering ${n} of your questions`,
    action: (d, n) =>
      `${d} belongs to a competitor, so there is no version of this where you get listed on it. The useful question is why that page was chosen at all. ` +
      `Run the page teardown on this action to see which structural features earned the citation, then match them on your own equivalent page.`
  },
  reference: {
    effort: 5,
    title: (d, n) => `${d} is cited for ${n} of your questions`,
    action: (d, n) =>
      `${d} is a reference source. Inclusion is governed by notability rules rather than outreach, and pushing at it usually backfires. ` +
      `Treat this as context rather than a task: it tells you the engine wants an authoritative, neutral framing for this question, which you can supply on your own page with clear sourcing and dates.`
  },
  publisher: {
    effort: 3,
    title: (d, n) => `Get published on ${d}`,
    action: (d, n) =>
      `${d} is cited across ${n} of your questions and accepts outside contributions. Pitch a piece that answers one of those questions properly rather than a company profile. ` +
      `Contributed articles get cited when they carry original data or a clear methodology, so lead with something only you can say.`
  },
  editorial: {
    effort: 2,
    title: (d, n) => `${d} shapes ${n} of your questions`,
    action: (d, n) =>
      `Cited across ${n} of your tracked questions and you are not in it. Work out whether it is a roundup you could be added to, a review you could earn, or a piece you could contribute to. ` +
      `Use the page teardown on this action first, so the pitch names the specific gap in their coverage rather than asking to be added.`
  },
  own: { effort: 1, title: (d) => `Your own page is being cited`, action: (d) => `${d} is already a source for these answers. Nothing to do here.` }
};

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
  const sourceRows = await many(
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
            `Not named once across ${p.owned.runs} answers` +
            (rivals.length ? `, while ${rivals.join(', ')} ${rivals.length > 1 ? 'were' : 'was'}. ` : '. ') +
            (topQuery
              ? `The engine got there by searching "${topQuery}", so start by checking your rank for that. If you are off page one you are not even in the candidate set, and no amount of rewriting fixes that. `
              : '') +
            `On the page itself: answer the question in the first 40 to 60 words before any preamble, use the question as an H2, and include a sentence that names you plainly ` +
            `("${project.brand_name} is a ...") so the model has something to attribute.`,
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
          title: `Named but never cited for "${p.text}"`,
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

    /* Rule 5: note where a competitor leads. Rolled up after the loop, because
       you write one comparison page per rival, not one per question. */
    for (const c of p.competitors.values()) {
      const cRate = rate(c.hits, c.runs);
      if (cRate - ownRate >= 0.4 && cRate >= 0.5) {
        if (!rivalGaps.has(c.name)) {
          rivalGaps.set(c.name, { name: c.name, domain: c.domain, questions: [], gapSum: 0, impact: 0 });
        }
        const g = rivalGaps.get(c.name);
        g.questions.push({ prompt_id: p.id, text: p.text, theirs: Math.round(cRate * 100), yours: Math.round(ownRate * 100) });
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

    /* Rule 8: the search the engine ran, when there is no content gap to fold it into */
    if (fanOut.length && ownRate > 0 && ownRate < 0.5) {
      const list = fanOut.map((f) => `"${f.query}"`).join(', ');
      out.push(
        rec({
          type: 'fanout_target',
          title: `The engines searched ${list} to answer this`,
          action:
            `To build its answer for "${p.text}", the engine ran ${fanOut.length > 1 ? 'these searches' : 'this search'}: ${list}. ` +
            `That is a normal Google query, so classic SEO applies directly. Check where you rank for it today. If you are not on page one, ` +
            `you are not in the candidate set the model reads from, and no amount of on-page rewriting for the conversational question will fix that. ` +
            `Treat it as a keyword target and track it alongside your usual rankings.`,
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
          `Across ${n} of your tracked question${n > 1 ? 's' : ''}, ${g.name} is named in ${avgTheirs}% of answers against your ${avgYours}%. ` +
          `Examples: ${examples}. ` +
          `Write one honest comparison page covering ${g.name}, including the cases where they are the better choice. Balanced comparisons get cited far more often ` +
          `than one-sided ones, because models favour sources that acknowledge trade-offs. ` +
          `Then look at what they have that you do not: check which pages of theirs the engines are citing on the Sources tab.`,
        targetUrl: g.domain ? `https://${g.domain}` : null,
        impact: Math.min(100, g.impact / Math.max(1, Math.sqrt(n))),
        evidence: {
          competitor: g.name,
          competitor_rate: avgTheirs,
          own_rate: avgYours,
          questions: g.questions.map((q) => q.text).slice(0, 6)
        }
      })
    );
  }

  /* Rule 10: sources that shape your category, with advice that fits the source */

  for (const s of sourceRows.slice(0, 15)) {
    if (s.prompts < 2) continue;
    const { kind, reachable } = classifySource(s.domain, { ownDomain, competitorDomains });
    if (kind === 'own') continue;

    const advice = SOURCE_ADVICE[kind] || SOURCE_ADVICE.editorial;
    // Worth knowing about, but a source you cannot appear on is not a task in
    // the same sense, so it should not outrank things you can act on.
    const weight = reachable ? 1 : 0.55;

    out.push(
      rec({
        type: kind === 'competitor' ? 'competitor_page' : 'source_gap',
        title: advice.title(s.domain, s.prompts),
        action: advice.action(s.domain, s.prompts),
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
