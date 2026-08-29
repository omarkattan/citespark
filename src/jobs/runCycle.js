import 'dotenv/config';
import { many, one, query, pool } from '../db/index.js';
import { askEngine, domainOf, MOCK } from '../lib/dataforseo.js';
import { analyseRun } from '../lib/analyze.js';
import { isWrapper, resolveAll } from '../lib/resolve.js';
import { buildRecommendations, persistRecommendations } from '../lib/recommend.js';
import { hasAnthropic } from '../lib/anthropic.js';
import { budgetForCycle, recordUsage } from '../lib/billing.js';

import { ENGINE_IDS } from '../lib/dataforseo.js';

/** Engines are chosen per project. The env var is only a fallback for old rows. */
function enginesFor(project) {
  const chosen = (project.engines?.length ? project.engines : (process.env.ENGINES || 'chatgpt').split(','))
    .map((e) => e.trim())
    .filter((e) => ENGINE_IDS.includes(e));
  return chosen.length ? chosen : ['chatgpt'];
}
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);

async function pooled(items, worker, limit = CONCURRENCY) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (err) {
        console.error('task failed:', err.message);
      }
    }
  });
  await Promise.all(workers);
}

/**
 * Run everything, or only the questions that have never been asked.
 *
 * "only" is for the common case of adding questions after a cycle: nobody
 * wants to pay to re-ask the sixty that already have answers.
 *
 * A partial run joins the most recent cycle rather than starting its own.
 * Its own cycle would produce a trend point measured over eight questions
 * where the one before it covered sixty, and that shows up as a collapse or
 * a spike that never happened.
 */
export async function runCycleForProject(projectId, { cycleDate, onProgress, only = null } = {}) {
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new Error(`No project ${projectId}`);

  const latest = (await one('SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok', [projectId]))?.d;

  const cycle =
    cycleDate ||
    (only === 'unrun' && latest
      ? new Date(latest).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10));

  const prompts =
    only === 'unrun'
      ? await many(
          `SELECT p.* FROM prompts p
           WHERE p.project_id = $1 AND p.active
             AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.prompt_id = p.id AND r.ok)
           ORDER BY p.id`,
          [projectId]
        )
      : await many('SELECT * FROM prompts WHERE project_id = $1 AND active', [projectId]);

  if (!prompts.length) {
    return {
      runs: 0,
      spend: 0,
      recommendations: 0,
      cycle,
      nothingToDo: true,
      reason: only === 'unrun' ? 'Every active question has already been asked.' : 'This site has no active questions.'
    };
  }
  const entities = await many('SELECT * FROM entities WHERE project_id = $1', [projectId]);

  /**
   * Record a material change in what is being measured, before measuring it.
   *
   * A trend is only a trend if the thing underneath it held still. One project
   * grew from 209 measured answers to 1,324 across eight cycles and its rate
   * halved, which read as a decline and was mostly the question set. Nothing
   * anywhere recorded that the set had changed, so there was no way to know
   * from the chart. Ten percent is the threshold: below that the wobble is
   * not worth a note, above it the reader needs to be told.
   */
  const priorCycle = await one(
    `SELECT COUNT(DISTINCT r.prompt_id)::int AS questions, MAX(r.run_index) + 1 AS runs
     FROM runs r
     WHERE r.project_id = $1 AND r.ok
       AND r.cycle_date = (SELECT MAX(cycle_date) FROM runs WHERE project_id = $1 AND ok)`,
    [projectId]
  );

  if (priorCycle?.questions) {
    const grew = Math.abs(prompts.length - priorCycle.questions) / priorCycle.questions;
    const runsChanged = priorCycle.runs && priorCycle.runs !== project.runs_per_cycle;
    const parts = [];
    if (grew >= 0.1) parts.push(`questions ${priorCycle.questions} to ${prompts.length}`);
    if (runsChanged) parts.push(`runs per question ${priorCycle.runs} to ${project.runs_per_cycle}`);
    if (parts.length) {
      await query(
        `INSERT INTO method_notes (project_id, note, detail) VALUES ($1,$2,$3)`,
        [
          projectId,
          `What is measured changed: ${parts.join(', ')}`,
          'Cycles either side of this point are not directly comparable on the full question set. ' +
            'The like-for-like figure covers only questions present in every cycle.'
        ]
      );
    }
  }

  // A plan is a call budget. Trim the cycle to fit rather than overspending,
  // and stop entirely when the month's allowance is gone.
  const budget = await budgetForCycle(project.org_id, {
    questions: prompts.length,
    engines: enginesFor(project),
    runs: project.runs_per_cycle
  });

  if (!budget.ok) {
    console.log(`Cycle skipped for ${project.brand_name}: ${budget.reason}`);
    return { runs: 0, spend: 0, recommendations: 0, cycle, blocked: true, reason: budget.reason };
  }

  const jobs = [];
  for (const prompt of prompts) {
    for (const engine of budget.engines) {
      for (let i = 0; i < budget.runs; i++) {
        jobs.push({ prompt, engine, runIndex: i });
      }
    }
  }
  if (jobs.length > budget.maxCalls) jobs.length = budget.maxCalls;

  console.log(
    `Cycle ${cycle} for ${project.brand_name}: ${prompts.length} prompts x ${budget.engines.length} engines x ${budget.runs} runs = ${jobs.length} calls` +
      (budget.trimmed ? ' (trimmed to the remaining monthly allowance)' : '') +
      (MOCK ? ' (MOCK MODE, no spend)' : '')
  );

  let spend = 0;
  let done = 0;
  let billable = 0;          // what we charge the customer's allowance for
  const failures = new Map(); // engine -> {n, error}
  /**
   * A cycle takes minutes. A bare counter gives someone no reason to believe
   * anything is happening, so the last few questions asked are reported and
   * shown as they land.
   */
  const ownedIds = new Set(entities.filter((e) => e.kind === 'owned').map((e) => e.id));

  const recent = [];
  const noteAsked = (entry) => {
    recent.unshift(entry);
    if (recent.length > 6) recent.pop();
  };

  const report = (extra = {}) =>
    onProgress?.({ done, total: jobs.length, spend, recent: [...recent], ...extra });
  report({ phase: 'asking' });

  /**
   * Stop asking an engine that will not answer.
   *
   * One cycle spent 260 calls on an engine returning rate_limit_exceeded to
   * every one, after retries and backoff had already been applied to each.
   * Nothing stopped it, so the cycle paid for 260 refusals, took far longer
   * than it should have, and produced an engine with 8 answers sitting beside
   * engines with 268 as though the comparison meant something.
   *
   * After this many consecutive refusals, the engine is left alone for the
   * rest of the cycle and recorded as not measured. Absent is not zero, and a
   * gap we can explain beats a number we cannot.
   */
  const GIVE_UP_AFTER = Number(process.env.ENGINE_GIVE_UP_AFTER || 12);
  const consecutive = new Map();
  const abandoned = new Map();

  await pooled(jobs, async ({ prompt, engine, runIndex }) => {
    if (abandoned.has(engine)) {
      abandoned.set(engine, abandoned.get(engine) + 1);
      return;
    }

    const asking = { question: prompt.text, engine, run: runIndex + 1, state: 'asking', at: Date.now() };
    noteAsked(asking);
    report({ phase: 'asking' });

    const answer = await askEngine({
      engine,
      prompt: prompt.text,
      market: project.market,
      locationName: project.location_name,
      maxTokens: Number(process.env.MAX_OUTPUT_TOKENS || 2000)
    });

    spend += answer.costUsd || 0;

    // A call only costs the customer an allowance check if it either produced
    // an answer or actually cost us money. Charging for a silent failure is
    // both unfair and hides the failure.
    if (answer.ok || (answer.costUsd || 0) > 0) billable++;
    if (!answer.ok) {
      const key = engine;
      const prev = failures.get(key) || { n: 0, error: answer.error };
      failures.set(key, { n: prev.n + 1, error: prev.error || answer.error });

      // A run of refusals with nothing in between is a provider saying no,
      // not a series of unlucky questions.
      const run = (consecutive.get(engine) || 0) + 1;
      consecutive.set(engine, run);
      if (run >= GIVE_UP_AFTER) {
        abandoned.set(engine, 0);
        console.log(`Stopped asking ${engine} after ${run} refusals in a row: ${answer.error}`);
      }
    } else {
      consecutive.set(engine, 0);
    }

    const run = await one(
      `INSERT INTO runs (prompt_id, project_id, engine, model, cycle_date, run_index, response_text, ok, error, cost_usd, fan_out_queries)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        prompt.id,
        projectId,
        engine,
        answer.model,
        cycle,
        runIndex,
        answer.text,
        answer.ok,
        answer.error,
        answer.costUsd || 0,
        answer.fanOut || []
      ]
    );

    if (!answer.ok) {
      // A failed call still finished. Returning without counting it left the
      // progress bar stuck and the feed showing a question that never resolved.
      done++;
      asking.state = 'failed';
      report({ phase: 'asking' });
      return;
    }

    const results = await analyseRun({
      text: answer.text,
      entities,
      useModel: hasAnthropic && runIndex === 0
    });

    for (const r of results) {
      await query(
        `INSERT INTO mentions (run_id, entity_id, mentioned, ordinal, sentiment, snippet)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id, entity_id) DO NOTHING`,
        [run.id, r.entity_id, r.mentioned, r.ordinal, r.sentiment, r.snippet]
      );
    }

    /**
     * Follow any redirect wrapper before storing.
     *
     * Google's AI surfaces cite vertexaisearch.cloud.google.com rather than
     * the publisher, so stored as-is every Google citation is attributed to
     * Google: one invented source with a huge count, and every real one
     * missing. Resolutions are cached, so the same link is followed once.
     */
    let cites = answer.citations;
    if (cites.some((c) => isWrapper(c.url))) {
      const resolved = await resolveAll(cites.map((c) => c.url));
      cites = cites.map((c) => {
        const r = resolved.get(c.url);
        // A link we could not follow keeps the honest wrapper. Guessing a
        // publisher would be worse than admitting we do not know.
        if (!r?.resolved) return c;
        return { ...c, url: r.url, domain: domainOf(r.url) || c.domain, via: c.domain };
      });
    }

    for (const c of cites) {
      await query('INSERT INTO citations (run_id, domain, url, position) VALUES ($1,$2,$3,$4)', [
        run.id,
        c.domain,
        c.url,
        c.position
      ]);
    }

    done++;
    // Mark the same entry answered, so the feed shows a result rather than a
    // list of questions that appear to hang. Whether the brand was named is
    // the interesting part while waiting.
    asking.state = 'answered';
    asking.named = results.some((r) => r.mentioned && ownedIds.has(r.entity_id));
    report({ phase: 'asking' });
    if (done % 20 === 0) console.log(`  ${done}/${jobs.length} runs complete`);
  });

  await recordUsage(project.org_id, billable, spend);

  /**
   * Read the pages that shaped this cycle's answers.
   *
   * Without this the report's "what cited pages have in common" section is
   * built from whatever someone clicked, which is a selection rather than a
   * sample. Five pages is a few cents and makes the section mean something.
   * Failure here must not fail the cycle: the measurement is already stored.
   */
  if (!only) {
    try {
      const { teardownTopCited } = await import('../lib/teardown.js');
      const td = await teardownTopCited(project.id, { limit: Number(process.env.TEARDOWN_PER_CYCLE || 5), cycle });
      if (td.torn) console.log(`  read ${td.torn} of the most cited pages`);
    } catch (err) {
      console.warn(`could not read cited pages: ${err.message}`);
    }
  }

  // A rejected field is a bug in our request. It should reach us directly
  // rather than waiting for a customer to report that an engine looks broken.
  const rejected = [...failures.entries()].filter(([, f]) => /invalid field/i.test(f.error || ''));
  if (rejected.length) {
    const { notify } = await import('../lib/notify.js');
    notify({
      kind: 'problem',
      title: `Engine request rejected: ${rejected.map(([e]) => e).join(', ')}`,
      subject: `Cited: ${rejected.map(([e]) => e).join(', ')} rejecting our requests`,
      lead: 'The provider rejected the request itself, so this is a bug on our side rather than an outage. Customers see the surface reporting nothing.',
      rows: rejected.map(([engine, f]) => [engine, `${f.count} failures: ${f.error}`]).concat([['Site', project.name]])
    });
  }

  const attemptsPerEngine = new Map();
  for (const j of jobs) attemptsPerEngine.set(j.engine, (attemptsPerEngine.get(j.engine) || 0) + 1);

  const failed = [...failures.entries()].map(([engine, f]) => {
    const tried = attemptsPerEngine.get(engine) || f.n;
    return {
      engine,
      count: f.n,
      attempted: tried,
      rate: tried ? f.n / tried : 0,
      error: f.error,
      // A surface failing most of the time is costing you nothing but is also
      // telling you nothing, and it should be switched off rather than endured.
      mostlyBroken: tried >= 5 && f.n / tried >= 0.6
    };
  });
  if (failed.length) {
    console.warn(
      'Failures this cycle: ' + failed.map((f) => `${f.engine} x${f.count} (${f.error})`).join(', ')
    );
  }

  /**
   * An engine we stopped asking is a change in what was measured, so it goes
   * on the record beside the numbers rather than into a log nobody reads. The
   * alternative is a chart where one surface quietly contributes nothing and
   * the reader has no way to know.
   */
  for (const [engine, skipped] of abandoned) {
    const f = failures.get(engine);
    await query('INSERT INTO method_notes (project_id, note, detail) VALUES ($1,$2,$3)', [
      projectId,
      `${engine} was not measured this cycle`,
      `It refused ${GIVE_UP_AFTER} requests in a row, so we stopped asking and skipped the remaining ` +
        `${skipped}. Its answers are missing from this cycle rather than counted as misses. ` +
        `Last error: ${f?.error || 'unknown'}.`
    ]);
    const { notify } = await import('../lib/notify.js');
    notify({
      kind: 'problem',
      title: `${engine} stopped answering during a cycle`,
      subject: `Cited: ${engine} refused ${GIVE_UP_AFTER} requests in a row`,
      lead: 'We stopped asking rather than spending the cycle being turned away. The surface is missing from this cycle, not scoring zero.',
      rows: [['Engine', engine], ['Skipped', String(skipped)], ['Error', f?.error || 'unknown'], ['Site', project.name]]
    });
  }

  report({ phase: 'thinking' });
  const recs = await buildRecommendations(projectId);
  await persistRecommendations(projectId, recs);

  const summary = await summarise(projectId, cycle, {
    runs: done, spend, recs, trimmed: budget.trimmed, estimated: budget.estimateUsd,
    attempted: jobs.length, billable, failed
  });
  console.log(
    `Done. ${done}/${jobs.length} usable runs (${billable} billed), $${spend.toFixed(4)} spent, ${recs.length} recommendations.`
  );
  report({ phase: 'done', summary });
  return summary;
}

/**
 * What actually changed this cycle, in the terms a person cares about:
 * did visibility move, what is new to do, and what did it cost.
 */
async function summarise(projectId, cycle, { runs, spend, recs, trimmed, estimated, attempted, billable, failed }) {
  const rate = async (cycleDate) => {
    if (!cycleDate) return null;
    const row = await one(
      `SELECT SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS r
       FROM runs cr
       JOIN mentions m ON m.run_id = cr.id
       JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
       WHERE cr.project_id = $1 AND cr.cycle_date = $2 AND cr.ok`,
      [projectId, cycleDate]
    );
    return row?.r === null || row?.r === undefined ? null : Number(row.r);
  };

  const prev = await one(
    'SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok AND cycle_date < $2',
    [projectId, cycle]
  );

  const now = await rate(cycle);
  const before = await rate(prev?.d);

  const topSources = await many(
    `SELECT c.domain, COUNT(*)::int AS n
     FROM citations c JOIN runs r ON r.id = c.run_id
     WHERE r.project_id = $1 AND r.cycle_date = $2
     GROUP BY c.domain ORDER BY n DESC LIMIT 3`,
    [projectId, cycle]
  );

  const rivals = await many(
    `SELECT e.name, SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS rate
     FROM runs r JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'competitor'
     WHERE r.project_id = $1 AND r.cycle_date = $2 AND r.ok
     GROUP BY e.id ORDER BY rate DESC LIMIT 1`,
    [projectId, cycle]
  );

  const openCount = await one(
    "SELECT COUNT(*)::int AS n FROM recommendations WHERE project_id = $1 AND status = 'open'",
    [projectId]
  );

  return {
    cycle,
    runs,
    spend: Math.round(spend * 1000) / 1000,
    estimated: estimated ?? null,
    attempted: attempted ?? runs,
    billable: billable ?? runs,
    failed: failed || [],
    trimmed,
    recommendations: recs.length,
    openActions: openCount.n,
    visibility: now,
    visibilityBefore: before,
    delta: now !== null && before !== null ? now - before : null,
    topActions: recs.slice(0, 3).map((r) => ({ type: r.type, title: r.title, priority: r.priority })),
    topSources,
    topRival: rivals[0] ? { name: rivals[0].name, rate: Number(rivals[0].rate) } : null
  };
}

// Allow: npm run cycle  (all projects)  or  npm run cycle -- 1
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2).filter(Boolean);
  const all = args.includes('--all');
  const id = args.find((a) => /^\d+$/.test(a));

  // Running every site costs real money, so it has to be asked for explicitly
  // rather than being what happens when the command is typed with no arguments.
  if (!id && !all) {
    console.error('Nothing run. Name a site, or pass --all to run every site with automatic cycles on.\n');
    console.error('  npm run cycle -- 3        one site');
    console.error('  npm run cycle -- --all    every site with auto_cycle on\n');
    const rows = await many('SELECT id, name, auto_cycle FROM projects ORDER BY id');
    for (const r of rows) console.log(`  ${String(r.id).padStart(3)}  ${r.name}${r.auto_cycle ? '' : '   (automatic cycles off)'}`);
    await pool.end();
    process.exit(1);
  }

  const ids = id
    ? [Number(id)]
    : (await many('SELECT id FROM projects WHERE auto_cycle')).map((r) => r.id);

  if (!id) console.log(`Running ${ids.length} site${ids.length === 1 ? '' : 's'} with automatic cycles on.`);
  for (const id of ids) await runCycleForProject(id);
  await pool.end();
}

/**
 * Ask one question again, now.
 *
 * For the case where a stored answer disagrees with what the engine plainly
 * says when you check it by hand. Two things could be true: the measurement
 * was broken, or the engine genuinely varies. Those want different treatment,
 * so this distinguishes them rather than quietly overwriting.
 *
 *   A run that was truncated or errored is a failed measurement, not a data
 *   point, and is replaced.
 *
 *   A run that completed and simply did not name the brand is evidence. It is
 *   kept, and the new answer is stored alongside it as another sample.
 */
export async function reaskPrompt(promptId, { engine = null } = {}) {
  const prompt = await one(
    `SELECT p.*, pr.id AS project_id FROM prompts p JOIN projects pr ON pr.id = p.project_id WHERE p.id = $1`,
    [promptId]
  );
  if (!prompt) throw new Error('Question not found');

  const project = await one('SELECT * FROM projects WHERE id = $1', [prompt.project_id]);
  // ambiguous_name must travel with the entity or a re-ask would be counted
  // by a different rule from the cycle it sits in.
  const entities = await many('SELECT id, name, aliases, domain, kind, ambiguous_name FROM entities WHERE project_id = $1', [project.id]);
  const ownedIds = new Set(entities.filter((e) => e.kind === 'owned').map((e) => e.id));

  const engines = engine ? [engine] : project.engines || [];
  if (!engines.length) throw new Error('No engines configured for this site');

  const cycle =
    (await one('SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok', [project.id]))?.d ||
    new Date().toISOString().slice(0, 10);
  const cycleDay = new Date(cycle).toISOString().slice(0, 10);

  const { looksTruncated } = await import('../lib/analyze.js');
  const ceiling = Number(process.env.MAX_OUTPUT_TOKENS || 2000);
  const results = [];
  let spend = 0;

  for (const eng of engines) {
    const existing = await many(
      'SELECT id, ok, response_text, run_index FROM runs WHERE prompt_id = $1 AND engine = $2 AND cycle_date = $3 ORDER BY run_index',
      [promptId, eng, cycleDay]
    );

    // A broken measurement is replaced; a completed one is kept as evidence.
    const broken = existing.filter((r) => !r.ok || looksTruncated(r.response_text, ceiling));
    const sound = existing.filter((r) => r.ok && !looksTruncated(r.response_text, ceiling));

    const answer = await askEngine({
      engine: eng,
      prompt: prompt.text,
      market: project.market,
      locationName: project.location_name,
      maxTokens: ceiling
    });
    spend += answer.costUsd || 0;

    if (!answer.ok) {
      results.push({ engine: eng, ok: false, error: answer.error });
      continue;
    }

    if (broken.length) {
      await query('DELETE FROM runs WHERE id = ANY($1::int[])', [broken.map((r) => r.id)]);
    }

    const runIndex = sound.length ? Math.max(...sound.map((r) => r.run_index)) + 1 : 0;

    const run = await one(
      `INSERT INTO runs (prompt_id, project_id, engine, model, cycle_date, run_index, response_text, ok, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8) RETURNING id`,
      [promptId, project.id, eng, answer.model || null, cycleDay, runIndex, answer.text, answer.costUsd || 0]
    );

    const analysed = await analyseRun({ text: answer.text, entities, useModel: hasAnthropic });
    for (const r of analysed) {
      await query(
        `INSERT INTO mentions (run_id, entity_id, mentioned, ordinal, sentiment, snippet)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id, entity_id) DO NOTHING`,
        [run.id, r.entity_id, r.mentioned, r.ordinal, r.sentiment, r.snippet]
      );
    }

    let cites = answer.citations || [];
    if (cites.some((c) => isWrapper(c.url))) {
      const resolved = await resolveAll(cites.map((c) => c.url));
      cites = cites.map((c) => {
        const r = resolved.get(c.url);
        return r?.resolved ? { ...c, url: r.url, domain: domainOf(r.url) || c.domain } : c;
      });
    }
    for (const c of cites) {
      await query('INSERT INTO citations (run_id, domain, url, position) VALUES ($1,$2,$3,$4)', [
        run.id,
        c.domain,
        c.url,
        c.position
      ]);
    }

    results.push({
      engine: eng,
      ok: true,
      named: analysed.some((r) => r.mentioned && ownedIds.has(r.entity_id)),
      replaced: broken.length,
      keptAlongside: sound.length,
      truncated: looksTruncated(answer.text, ceiling)
    });
  }

  await recordUsage(project.org_id, results.length, spend);
  return { prompt: prompt.text, cycle: cycleDay, spend: Math.round(spend * 10000) / 10000, results };
}
