import 'dotenv/config';
import { pool, many, one } from '../src/db/index.js';
import { isTransient } from '../src/lib/dataforseo.js';

/**
 * Why does one engine return fewer answers than the rest?
 *
 *   npm run failures -- 7
 *   npm run failures -- 7 gemini        just that engine, with examples
 *
 * Free. Reads stored runs, calls nothing.
 *
 * One project's Gemini returned 8 answers in a cycle where every other engine
 * returned 268, and 507 over its life against 965. The overview counted only
 * the answers that came back, so the shortfall never appeared as a failure:
 * it appeared as a low score, which is the opposite conclusion.
 *
 * The useful split is not how many failed but whether the failures were the
 * kind we retry. A transient error that keeps recurring means the backoff is
 * too shallow or the limit is tighter than it can absorb. A permanent one
 * means every retry was wasted and the request itself is wrong.
 */

const args = process.argv.slice(2);
const id = Number(args.find((a) => /^\d+$/.test(a)));
const only = args.find((a) => !/^\d+$/.test(a) && !a.startsWith('--')) || null;

if (!id) {
  const rows = await many('SELECT id, name FROM projects ORDER BY id');
  console.log('Give a project id:\n' + rows.map((r) => `  ${r.id}  ${r.name}`).join('\n'));
  await pool.end();
  process.exit(0);
}

const project = await one('SELECT name FROM projects WHERE id = $1', [id]);
if (!project) { console.error(`No project ${id}.`); await pool.end(); process.exit(1); }

console.log(`\n${project.name}  (project ${id})\n`);

/* ---------------- how much each engine actually delivered ---------------- */

const totals = await many(
  `SELECT engine,
          COUNT(*)::int                              AS attempted,
          COUNT(*) FILTER (WHERE ok)::int            AS answered,
          COUNT(*) FILTER (WHERE NOT ok)::int        AS failed
   FROM runs WHERE project_id = $1
   GROUP BY engine ORDER BY engine`,
  [id]
);

const busiest = Math.max(...totals.map((t) => t.attempted));
console.log('Answers delivered, all cycles');
console.log('An engine asked as often as the others but answering far less is a');
console.log('broken engine, not a low score.\n');
for (const t of totals) {
  const rate = t.attempted ? Math.round((t.answered / t.attempted) * 100) : 0;
  const asked = busiest ? Math.round((t.attempted / busiest) * 100) : 0;
  console.log(
    `  ${t.engine.padEnd(12)} answered ${String(rate).padStart(3)}%  ` +
    `(${String(t.answered).padStart(5)} of ${String(t.attempted).padStart(5)} asked)` +
    `${asked < 90 ? `   asked only ${asked}% as often as the busiest` : ''}` +
    `${rate < 70 ? '   <-- failing' : ''}`
  );
}

/* ---------------- what the failures actually say ---------------- */

const engines = only ? [only] : totals.filter((t) => t.failed > 0).map((t) => t.engine);

for (const engine of engines) {
  const rows = await many(
    `SELECT error, cycle_date FROM runs
     WHERE project_id = $1 AND engine = $2 AND NOT ok AND error IS NOT NULL`,
    [id, engine]
  );
  if (!rows.length) continue;

  console.log(`\n\n${engine}: ${rows.length} recorded failures`);

  /**
   * Ids, counts and timestamps inside a message would split one cause into
   * hundreds of rows, so the variable parts are flattened before grouping.
   */
  const shape = (e) =>
    String(e)
      .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<time>')
      .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
      .replace(/\b\d+\b/g, '<n>')
      .slice(0, 110);

  const groups = new Map();
  for (const r of rows) {
    const k = shape(r.error);
    const g = groups.get(k) || { n: 0, sample: r.error, cycles: new Set(), retried: isTransient({ error: r.error }) };
    g.n++;
    g.cycles.add(new Date(r.cycle_date).toISOString().slice(0, 10));
    groups.set(k, g);
  }

  console.log('  "retried" is whether our own classifier treats this as worth');
  console.log('  trying again. A permanent error means every retry was wasted.\n');

  for (const [, g] of [...groups].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
    console.log(`  ${String(g.n).padStart(5)}x  ${g.retried ? 'retried  ' : 'PERMANENT'}  across ${g.cycles.size} cycle${g.cycles.size === 1 ? '' : 's'}`);
    console.log(`         ${g.sample.slice(0, 150).replace(/\s+/g, ' ')}`);
  }

  /**
   * A failure spread evenly across cycles is a standing problem. One
   * concentrated in a single cycle is an incident, and worth a different fix.
   */
  const byCycle = await many(
    `SELECT cycle_date,
            COUNT(*) FILTER (WHERE ok)::int     AS answered,
            COUNT(*) FILTER (WHERE NOT ok)::int AS failed
     FROM runs WHERE project_id = $1 AND engine = $2
     GROUP BY cycle_date ORDER BY cycle_date`,
    [id, engine]
  );
  console.log('\n  By cycle:');
  for (const c of byCycle) {
    const total = c.answered + c.failed;
    const pct = total ? Math.round((c.answered / total) * 100) : 0;
    console.log(`    ${new Date(c.cycle_date).toISOString().slice(0, 10)}   ${String(pct).padStart(3)}% answered   (${c.answered} of ${total})`);
  }

  /**
   * A permanent cause is NOT retried, by design: isTransient returns false
   * and askEngine gives up immediately. An earlier version of this summary
   * said those failures wasted retries, which was backwards and would have
   * sent someone to fix the backoff when the request was the problem.
   */
  const transient = [...groups.values()].filter((g) => g.retried).reduce((n, g) => n + g.n, 0);
  const permanent = [...groups.values()].filter((g) => !g.retried).reduce((n, g) => n + g.n, 0);

  if (transient) {
    console.log(`\n  ${transient} failures were retried and still failed. The backoff is too shallow`);
    console.log('  for this provider, or we are asking faster than it allows. Lower');
    console.log('  CONCURRENCY or stop asking after a run of refusals, rather than');
    console.log('  spending the whole cycle being turned away.');
  }
  if (permanent) {
    console.log(`\n  ${permanent} failures were not retried, correctly: the request itself was`);
    console.log('  wrong, so trying again could never have worked. Fix the request.');
  }
}

console.log('\nRead only. Nothing was written, and no engine was called.\n');
await pool.end();
