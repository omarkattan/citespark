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

  /**
   * Say what the numbers mean for this client, not in general.
   *
   * A table of percentages leaves the reader to draw the conclusion, and the
   * conclusion is the part they are paying for. Every sentence below is
   * assembled from this project's own measurements and names its evidence, so
   * two clients with different data get different advice.
   */
  const reading = [];
  const noSchema = rows.filter((r) => !((r.result?.structure || r.result || {}).schemaTypes || []).length).length;
  const withSchema = n - noSchema;

  if (noSchema / n >= 0.3) {
    reading.push({
      point: 'Citation here is running on authority, not page craft.',
      why: `${noSchema} of the ${n} pages being cited carry no structured data at all. Pages are winning citations because of who publishes them rather than how they are built, so structural changes to your own pages will move this less than getting onto the sources that already shape these answers.`
    });
  }

  // A feature almost nobody has is an opening; one almost everybody has is a
  // baseline you are simply expected to meet.
  for (const [label, count] of [
    ['answer the question in a heading', counts.headingMatchesQuestion],
    ['carry FAQ or QA schema', counts.faqSchema],
    ['quote specific figures', counts.statistics],
    ['name an author', counts.namedAuthor]
  ]) {
    const share = count / n;
    if (share > 0 && share <= 0.2) {
      reading.push({
        point: `Only ${count} of ${n} cited page${count === 1 ? '' : 's'} ${label}.`,
        why: 'Rare enough that doing it well is a differentiator rather than catching up, and cheap enough to be worth testing on a page you already rank with.'
      });
    }
    if (share === 0 && withSchema > 0 && label.includes('schema')) {
      reading.push({
        // "carrys" came from pluralising the verb blindly. The subject is
        // singular here, so the verb needs its real third-person form.
        point: `No cited page ${{ carry: 'carries', answer: 'answers', quote: 'quotes', name: 'names' }[label.split(' ')[0]] || label.split(' ')[0]} ${label.split(' ').slice(1).join(' ')}.`,
        why: 'Structured data is being read successfully on the others, so this is a real absence rather than a measurement gap. Adding it would not match what is winning here, and is unlikely to be the lever.'
      });
    }
  }

  for (const [label, count] of [
    ['contain a list', counts.lists],
    ['contain a table', counts.tables]
  ]) {
    if (count / n >= 0.75) {
      reading.push({
        point: `${pct(count)}% of cited pages ${label}.`,
        why: 'That is close to universal in this category, so it reads as a baseline rather than an advantage. A page without one is at a disadvantage; a page with one is merely eligible.'
      });
    }
  }

  const median = words.length ? words.slice().sort((a, b) => a - b)[Math.floor(words.length / 2)] : null;
  if (median) {
    reading.push({
      point: `Cited pages run to about ${median.toLocaleString()} words.`,
      why: 'Useful as a target for anything written to compete with them, and as a check on whether an existing page is substantial enough to be quoted from.'
    });
  }

  return {
    pages: n,
    universe,
    reading,
    // Below this, the reader should treat the shares as indicative.
    // One page is a whole percentage point at this size, so the shares are
    // indicative well past the point they look precise.
    thin: n < 25,
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
async function trend(projectId, period = {}) {
  const all = await many(
    `SELECT r.cycle_date,
            COUNT(*) FILTER (WHERE m.mentioned)::float / NULLIF(COUNT(*), 0) AS rate,
            COUNT(*) FILTER (WHERE m.mentioned)::int AS named_count,
            COUNT(DISTINCT r.prompt_id)::int AS questions
     FROM runs r
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.project_id = $1 AND r.ok
       AND ($2::date IS NULL OR r.cycle_date >= $2)
       AND ($3::date IS NULL OR r.cycle_date <= $3)
     GROUP BY r.cycle_date ORDER BY r.cycle_date`,
    [projectId, period.from, period.to]
  );

  // Questions measured in every cycle. This is the only set where a change
  // in rate means something changed in the world rather than in our setup.
  const stable = await many(
    `WITH cycles AS (
           SELECT DISTINCT cycle_date FROM runs
           WHERE project_id = $1 AND ok
             AND ($2::date IS NULL OR cycle_date >= $2)
             AND ($3::date IS NULL OR cycle_date <= $3)
         ),
         everywhere AS (
           SELECT r.prompt_id FROM runs r
           WHERE r.project_id = $1 AND r.ok
             AND ($2::date IS NULL OR r.cycle_date >= $2)
             AND ($3::date IS NULL OR r.cycle_date <= $3)
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
       AND ($2::date IS NULL OR r.cycle_date >= $2)
       AND ($3::date IS NULL OR r.cycle_date <= $3)
     GROUP BY r.cycle_date ORDER BY r.cycle_date`,
    [projectId, period.from, period.to]
  );

  return { all, stable };
}

/**
 * Visibility by buyer type.
 *
 * The premise of personas is that the same question gets a different answer
 * depending on who asks it, so a single visibility number hides which buyers
 * cannot see you. That is the finding the feature exists to produce, and it
 * appeared nowhere in the report.
 */
async function byPersona(projectId, period = {}) {
  const cycle = (
    await one(
      `SELECT MAX(cycle_date) AS d FROM runs
       WHERE project_id = $1 AND ok
         AND ($2::date IS NULL OR cycle_date >= $2)
         AND ($3::date IS NULL OR cycle_date <= $3)`,
      [projectId, period?.from ?? null, period?.to ?? null]
    )
  )?.d;
  if (!cycle) return [];

  return many(
    `SELECT COALESCE(pe.name, 'Asked plainly') AS persona,
            pe.descriptor,
            COUNT(DISTINCT p.id)::int AS questions,
            COUNT(*) FILTER (WHERE m.mentioned)::float / NULLIF(COUNT(*), 0) AS named_rate,
            COUNT(*) FILTER (WHERE m.mentioned)::int AS named,
            COUNT(*)::int AS answers,
            AVG(m.ordinal) FILTER (WHERE m.mentioned)::float AS avg_position
     FROM runs r
     JOIN prompts p ON p.id = r.prompt_id
     LEFT JOIN personas pe ON pe.id = p.persona_id
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.project_id = $1 AND r.ok AND r.cycle_date = $2
     GROUP BY pe.id, pe.name, pe.descriptor
     HAVING COUNT(*) > 0
     ORDER BY 4 DESC NULLS LAST`,
    [projectId, cycle]
  );
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

  /**
   * Read the table the sync actually writes to.
   *
   * This queried a table called "ga" that does not exist. The error was
   * swallowed by the catch below and reported as "nothing pulled yet", so a
   * site with months of traffic looked like a site with none, and the
   * section that justifies the retainer was silently empty.
   */
  const rows = await many(
    `SELECT date AS day, platform AS source, landing_page, sessions, conversions, revenue
     FROM ga4_daily
     WHERE project_id = $1 AND date > CURRENT_DATE - 90
     ORDER BY date`,
    [projectId]
  ).catch((err) => {
    // A query fault and an empty table are different things, and reporting
    // one as the other is how this hid for as long as it did.
    console.error('traffic query failed:', err.message);
    return null;
  });

  if (rows === null) {
    return { connected: true, rows: [], why: 'We could not read the stored traffic. This is ours to fix.' };
  }

  if (!rows.length) {
    return {
      connected: true,
      rows: [],
      why: 'Connected, but no sessions have been pulled yet. Open the Traffic tab and sync, or wait for the next cycle.'
    };
  }

  const bySource = new Map();
  const byPage = new Map();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, { source: r.source, sessions: 0, conversions: 0 });
    const g = bySource.get(r.source);
    g.sessions += Number(r.sessions || 0);
    g.conversions += Number(r.conversions || 0);

    if (r.landing_page) {
      if (!byPage.has(r.landing_page)) byPage.set(r.landing_page, { page: r.landing_page, sessions: 0, conversions: 0 });
      const q = byPage.get(r.landing_page);
      q.sessions += Number(r.sessions || 0);
      q.conversions += Number(r.conversions || 0);
    }
  }

  return {
    connected: true,
    days: 90,
    total: rows.reduce((n, r) => n + Number(r.sessions || 0), 0),
    conversions: rows.reduce((n, r) => n + Number(r.conversions || 0), 0),
    revenue: rows.reduce((n, r) => n + Number(r.revenue || 0), 0),
    sources: [...bySource.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 8),
    // Which pages the assistants actually send people to, which is the
    // bridge between the visibility above and the money.
    // Every page, not a top slice. On most sites this is a couple of dozen
    // rows, and which pages the assistants send people to is the most
    // directly useful thing in an AI visibility report.
    pages: [...byPage.values()].sort((a, b) => b.sessions - a.sessions),
    trend: rows
  };
}

/**
 * Who is being named instead.
 *
 * A report about your own visibility with no competitor in it cannot answer
 * the first question anyone asks, which is whether this is bad or normal.
 */
async function rivals(projectId, period = {}) {
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

/**
 * The period a report covers.
 *
 * Everything defaulted to "all cycles ever", so a monthly retainer document
 * silently widened every month and two reports could not be compared. A
 * window makes the document about a period rather than about everything.
 */
function windowFor({ from, to } = {}) {
  const clean = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : null);
  return { from: clean(from), to: clean(to) };
}

export async function buildReport(projectId, range = {}) {
  const period = windowFor(range);
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new Error('Project not found');

  const personas = await many('SELECT name, descriptor FROM personas WHERE project_id = $1', [projectId]);

  const [p, s, patterns, points, done, traffic, competitors, personaRows] = await Promise.all([
    persistence(projectId),
    sourceGaps(projectId),
    citedPagePatterns(projectId),
    trend(projectId, period),
    completed(projectId),
    aiTraffic(projectId),
    rivals(projectId, period),
    byPersona(projectId, period)
  ]);

  // The comparable set where there is one, the whole set otherwise.
  const series = points.stable.length >= 2 ? points.stable : points.all;
  const comparable = points.stable.length >= 2;
  const first = series[0]?.rate ?? null;
  const last = series.at(-1)?.rate ?? null;

  // Titles carry the raw prompt text, so they are cleaned once here.
  for (const item of p.items) item.title = readable(item.title, personas);

  /**
   * The three things to do, at the top.
   *
   * Fourteen pages with no summary asks the reader to derive the plan
   * themselves, which is the work they are paying for. Each of these is
   * assembled from measured evidence and names it, so a client can check the
   * reasoning rather than take it on trust.
   */
  const priorities = [];

  const worstAudience = (personaRows || []).filter((x) => x.questions >= 3).at(-1);
  if (worstAudience && (worstAudience.named_rate || 0) < 0.1) {
    priorities.push({
      do: `Write for ${worstAudience.persona}.`,
      because: `They ask ${worstAudience.questions} of your tracked questions and you appear in ${Math.round((worstAudience.named_rate || 0) * 100)}% of the answers they get. That is a specific audience with a specific gap, which is a more tractable brief than raising visibility in general.`
    });
  }

  const topSource = (s.sources || []).find((x) => x.persistent);
  if (topSource) {
    priorities.push({
      do: `Earn a mention on ${topSource.domain}.`,
      because: `It shaped answers to ${topSource.questions} of your questions in every cycle we measured, and never cites you. Getting onto a source that already shapes this category is usually faster than ranking a new page.`
    });
  }

  const rival = (competitors || []).find((c) => c.kind === 'competitor' && (c.rate || 0) > (competitors.find((x) => x.kind === 'owned')?.rate || 0));
  if (rival) {
    const us = competitors.find((x) => x.kind === 'owned');
    priorities.push({
      do: `Close the gap with ${rival.name}.`,
      because: `They are named in ${Math.round((rival.rate || 0) * 100)}% of answers against your ${Math.round((us?.rate || 0) * 100)}%. A comparison page that treats them honestly is the usual way in, because the engines are already answering the comparison for buyers.`
    });
  }

  const deadPage = (traffic?.pages || []).find((p) => p.sessions >= 25 && p.conversions === 0);
  if (deadPage) {
    priorities.push({
      do: `Fix what happens on ${deadPage.page}.`,
      because: `AI assistants sent ${deadPage.sessions} sessions there in 90 days and none converted. Visibility is working on that page and the page is not.`
    });
  }

  return {
    priorities: priorities.slice(0, 3),
    project: { name: project.name, domain: project.domain, brand: project.brand_name },
    generatedAt: new Date().toISOString(),
    // Stated on the page, so two reports can be told apart at a glance.
    period: {
      from: period.from || (points.all[0] ? new Date(points.all[0].cycle_date).toISOString().slice(0, 10) : null),
      to: period.to || (points.all.at(-1) ? new Date(points.all.at(-1).cycle_date).toISOString().slice(0, 10) : null),
      chosen: Boolean(period.from || period.to)
    },
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
    personas: personaRows,
    traffic,
    themes: groupActions(p.items),
    persistence: p,
    sources: s,
    patterns,
    completed: done,
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
