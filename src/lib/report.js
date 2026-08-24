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

  /**
   * Group the repeats.
   *
   * Six identical "Strong on ai_mode, absent on chatgpt" rows are one finding
   * about one engine, not six problems. Listing them separately turned a
   * short, actionable list into 116 items nobody would read, and made the
   * count itself misleading.
   */
  const seen = new Map();
  for (const r of rows) {
    const key = r.title.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, { ...r, copies: 1 });
    else {
      const g = seen.get(key);
      g.copies += 1;
      g.cycles = Math.max(g.cycles, r.cycles);
    }
  }

  return {
    totalCycles: total,
    since: cycles.at(-1)?.cycle_date || null,
    // Kept so the report can say what was collapsed rather than hiding it.
    collapsedFrom: rows.length,
    items: [...seen.values()].map((r) => ({
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

  // How many pages exist to be read, so the sample can be stated as a share
  // rather than a bare number. A pattern from three of forty is a hint; the
  // same three presented alone read as a finding.
  const universe = (
    await one(
      `SELECT COUNT(DISTINCT c.url)::int AS n
       FROM citations c JOIN runs r ON r.id = c.run_id
       WHERE r.project_id = $1 AND c.url IS NOT NULL`,
      [projectId]
    )
  )?.n || 0;

  if (!rows.length) {
    return {
      pages: 0,
      universe,
      features: [],
      note: 'No cited pages have been read yet. They are read automatically at the end of each cycle.'
    };
  }

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
    /**
     * These read the names the teardown actually produces.
     *
     * They were guessed, and five of the eight did not exist, so every page
     * scored zero on them. The report then published "names an author 0%" and
     * "shows a date 0%" as findings, which is both false and easy to disprove
     * by opening any one of the pages.
     */
    if (s.headingsMatchingQuestion?.length) counts.headingMatchesQuestion++;
    if (s.tables) counts.tables++;
    if (s.lists) counts.lists++;
    if (s.statMentions) counts.statistics++;
    if (s.hasAuthor) counts.namedAuthor++;
    if (s.publishedOrUpdated) counts.visibleDate++;
    if (s.wordCount) words.push(s.wordCount);
  }

  const n = rows.length;
  const pct = (x) => Math.round((x / n) * 100);

  return {
    pages: n,
    universe,
    // Below this, the reader should treat the shares as indicative.
    thin: n < 8,
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

/**
 * Visibility over time, on a question set that does not move.
 *
 * The rate across all questions is not comparable between cycles when the
 * question set grows: this project went from 8 questions to 135, and the
 * headline read as an 11 point fall when the brand was actually named five
 * times more often than at the start. A rate over a changing denominator is
 * not a trend, it is an artefact.
 */
async function trend(projectId) {
  const all = await many(
    `SELECT r.cycle_date,
            COUNT(*) FILTER (WHERE m.mentioned)::float / NULLIF(COUNT(*), 0) AS rate,
            COUNT(*) FILTER (WHERE m.mentioned)::int AS named_count,
            COUNT(DISTINCT r.prompt_id)::int AS questions
     FROM runs r
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.project_id = $1 AND r.ok
     GROUP BY r.cycle_date ORDER BY r.cycle_date`,
    [projectId]
  );

  // Questions measured in every cycle. This is the only set where a change
  // in rate means something changed in the world rather than in our setup.
  const stable = await many(
    `WITH cycles AS (SELECT DISTINCT cycle_date FROM runs WHERE project_id = $1 AND ok),
         everywhere AS (
           SELECT r.prompt_id FROM runs r
           WHERE r.project_id = $1 AND r.ok
           GROUP BY r.prompt_id
           HAVING COUNT(DISTINCT r.cycle_date) = (SELECT COUNT(*) FROM cycles)
         )
     SELECT r.cycle_date,
            COUNT(*) FILTER (WHERE m.mentioned)::float / NULLIF(COUNT(*), 0) AS rate,
            COUNT(DISTINCT r.prompt_id)::int AS questions
     FROM runs r
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.project_id = $1 AND r.ok AND r.prompt_id IN (SELECT prompt_id FROM everywhere)
     GROUP BY r.cycle_date ORDER BY r.cycle_date`,
    [projectId]
  );

  return { all, stable };
}

/**
 * The same finding stated forty times is one finding.
 *
 * "Invisible for: <question>" appeared twenty-five times in one report. That
 * is not twenty-five problems, it is one problem with twenty-five examples,
 * and a list that does not group them cannot be prioritised.
 */
function groupActions(items) {
  const themes = new Map();

  const themeOf = (i) => {
    if (/^Invisible for/i.test(i.title)) return { key: 'invisible', label: 'Questions where you never appear' };
    if (/shapes \d+ of your questions/i.test(i.title)) return { key: 'sources', label: 'Sources shaping answers without you' };
    if (/Cited as a source but rarely named/i.test(i.title)) return { key: 'cited_not_named', label: 'Linked, but not named in the answer' };
    if (/^Named but never cited/i.test(i.title)) return { key: 'named_not_cited', label: 'Named in the answer, but the link went elsewhere' };
    if (/^Visibility fell/i.test(i.title)) return { key: 'declines', label: 'Questions where visibility dropped' };
    if (/^Strong on .*absent on/i.test(i.title)) return { key: 'engines', label: 'Present on one engine, missing on another' };
    if (/^Claim your profile/i.test(i.title)) return { key: 'profiles', label: 'Profiles to claim' };
    return { key: i.type || 'other', label: i.title };
  };

  for (const i of items) {
    const t = themeOf(i);
    if (!themes.has(t.key)) themes.set(t.key, { key: t.key, label: t.label, items: [], recurring: 0 });
    const g = themes.get(t.key);
    g.items.push(i);
    if (i.standing === 'recurring') g.recurring++;
  }

  return [...themes.values()].sort((a, b) => b.items.length - a.items.length);
}

/**
 * Traffic the AI assistants actually sent.
 *
 * Visibility with no traffic beside it invites the question "so what". This
 * is the answer, and when it is missing the report should say why rather than
 * leaving a hole a reader fills with doubt.
 */
async function aiTraffic(projectId) {
  const project = await one('SELECT ga4_property_id, ga4_refresh_token FROM projects WHERE id = $1', [projectId]);

  if (!project?.ga4_refresh_token || !project?.ga4_property_id) {
    return {
      connected: false,
      why: project?.ga4_refresh_token
        ? 'Google is connected but no Analytics property has been chosen for this site.'
        : 'Google Analytics is not connected for this site, so we cannot show what the assistants sent. Connecting it is read-only and takes one screen.'
    };
  }

  const rows = await many(
    `SELECT day, source, sessions, conversions FROM ga
     WHERE project_id = $1 AND day > CURRENT_DATE - 90
     ORDER BY day`,
    [projectId]
  ).catch(() => []);

  if (!rows.length) return { connected: true, rows: [], why: 'Connected, but nothing has been pulled yet.' };

  const bySource = new Map();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, { source: r.source, sessions: 0, conversions: 0 });
    const g = bySource.get(r.source);
    g.sessions += Number(r.sessions || 0);
    g.conversions += Number(r.conversions || 0);
  }

  return {
    connected: true,
    days: 90,
    total: rows.reduce((n, r) => n + Number(r.sessions || 0), 0),
    conversions: rows.reduce((n, r) => n + Number(r.conversions || 0), 0),
    sources: [...bySource.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 8),
    trend: rows
  };
}

/**
 * Who is being named instead.
 *
 * A report about your own visibility with no competitor in it cannot answer
 * the first question anyone asks, which is whether this is bad or normal.
 */
async function rivals(projectId) {
  const day = (await one('SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok', [projectId]))?.d;
  if (!day) return [];

  return many(
    `SELECT e.name, e.kind,
            COUNT(*) FILTER (WHERE m.mentioned)::float / NULLIF(COUNT(*), 0) AS rate,
            COUNT(*) FILTER (WHERE m.mentioned)::int AS named
     FROM mentions m
     JOIN runs r ON r.id = m.run_id
     JOIN entities e ON e.id = m.entity_id
     WHERE r.project_id = $1 AND r.cycle_date = $2 AND r.ok
     GROUP BY e.id, e.name, e.kind
     HAVING COUNT(*) FILTER (WHERE m.mentioned) > 0
     ORDER BY 3 DESC
     LIMIT 10`,
    [projectId, day]
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

/**
 * Strip the buyer-type preamble from a question before a client reads it.
 *
 * "As someone evaluating shared family office platforms versus establishing
 * my own structure,. What are the best family office services in the UAE" is
 * how we ask the engine. It is not how anyone should read it in a report,
 * stray punctuation and all.
 */
function readable(text, personas = []) {
  let out = String(text || '');
  for (const p of personas) {
    const d = String(p.descriptor || '').trim().replace(/[.,;:\s]+$/, '');
    if (d && out.startsWith(d)) {
      out = out.slice(d.length).replace(/^[.,;:\s]+/, '');
      break;
    }
  }
  return out.replace(/,\s*\./g, '.').trim();
}

export async function buildReport(projectId) {
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new Error('Project not found');

  const personas = await many('SELECT name, descriptor FROM personas WHERE project_id = $1', [projectId]);

  const [p, s, patterns, points, done, traffic, competitors] = await Promise.all([
    persistence(projectId),
    sourceGaps(projectId),
    citedPagePatterns(projectId),
    trend(projectId),
    completed(projectId),
    aiTraffic(projectId),
    rivals(projectId)
  ]);

  // The comparable set where there is one, the whole set otherwise.
  const series = points.stable.length >= 2 ? points.stable : points.all;
  const comparable = points.stable.length >= 2;
  const first = series[0]?.rate ?? null;
  const last = series.at(-1)?.rate ?? null;

  // Titles carry the raw prompt text, so they are cleaned once here.
  for (const item of p.items) item.title = readable(item.title, personas);

  return {
    project: { name: project.name, domain: project.domain, brand: project.brand_name },
    generatedAt: new Date().toISOString(),
    trend: {
      points: series,
      all: points.all,
      comparable,
      comparableCount: points.stable.at(-1)?.questions ?? 0,
      first,
      last,
      change: first !== null && last !== null ? last - first : null,
      // Absolute counts, because a rate over a growing question set falls
      // even when the brand is named more often than before.
      firstNamed: points.all[0]?.named_count ?? null,
      lastNamed: points.all.at(-1)?.named_count ?? null,
      firstQuestions: points.all[0]?.questions ?? null,
      lastQuestions: points.all.at(-1)?.questions ?? null,
      cycles: points.all.length
    },
    standings: competitors,
    traffic,
    themes: groupActions(p.items),
    persistence: p,
    sources: s,
    patterns,
    completed: done,
    traffic,
    competitors,
    /**
     * The three things worth doing first.
     *
     * A list of a hundred problems is not a plan, and the reader has to pick
     * anyway. Better we pick, and say why, than leave them to guess.
     */
    priorities: p.items
      .filter((i) => i.standing === 'recurring')
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 3),
    // Stated once, at the top of the object, so no consumer has to infer it.
    caveats: [
      'Counts come from stored answers. Where a number is missing, the measurement did not run rather than returning zero.',
      'Completed actions and visibility changes are shown side by side. We do not claim one caused the other: too much moves at once in these systems to attribute a change to a single edit.',
      'A source citing a competitor is not proof it will cite you. It is evidence that the source shapes answers in your category and is worth pursuing.',
      comparable
        ? 'The trend is measured on the questions asked in every cycle, so a change means something moved in the answers rather than in what we asked. The full question set is shown separately.'
        : 'Not enough cycles share a common question set yet, so the trend covers every question asked. Once three cycles share questions, this becomes a like-for-like comparison.'
    ]
  };
}
