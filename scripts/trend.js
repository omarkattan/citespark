import 'dotenv/config';
import { pool, many, one } from '../src/db/index.js';

/**
 * Did visibility change, or did the measurement change?
 *
 *   npm run trend -- 7
 *   npm run trend -- 7 --engine chatgpt
 *
 * Free. Reads stored results only.
 *
 * Project 7 went from 209 measured answers in its first cycle to 1,309 in its
 * eighth. Across that, the number of times the brand was named rose from 39 to
 * 72, which was reported as growth. It is not: the count rose because six
 * times as many questions were being asked, while the rate fell.
 *
 * Neither figure settles anything on its own. A rate can fall simply because
 * newly added questions are harder, with no change in visibility at all. The
 * only comparison that means something is one made over the same questions on
 * the same engines in both cycles, which is what this prints.
 *
 * Everything outside that cohort is reported as unmeasured rather than folded
 * in, because a question that did not exist in the first cycle cannot tell
 * you anything about how the first cycle compares to now.
 */

const args = process.argv.slice(2);
const id = Number(args.find((a) => /^\d+$/.test(a)));
const ENGINE = (() => {
  const i = args.indexOf('--engine');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

if (!id) {
  const rows = await many('SELECT id, name FROM projects ORDER BY id');
  console.log('Give a project id:\n' + rows.map((r) => `  ${r.id}  ${r.name}`).join('\n'));
  await pool.end();
  process.exit(0);
}

const project = await one('SELECT * FROM projects WHERE id = $1', [id]);
const owned = await one("SELECT id, name FROM entities WHERE project_id = $1 AND kind = 'owned' ORDER BY id LIMIT 1", [id]);
if (!project || !owned) { console.error('No such project, or it has no owned brand.'); await pool.end(); process.exit(1); }

/**
 * One row per answer, carrying the pair that has to match across cycles: the
 * question and the engine it was asked on. A question measured on three
 * engines early and six later is not like-for-like either.
 */
const rows = await many(
  `SELECT r.cycle_date, r.prompt_id, r.engine, m.mentioned
   FROM runs r
   JOIN mentions m ON m.run_id = r.id AND m.entity_id = $1
   WHERE r.project_id = $2 AND r.ok
     ${ENGINE ? 'AND r.engine = $3' : ''}
   ORDER BY r.cycle_date`,
  ENGINE ? [owned.id, id, ENGINE] : [owned.id, id]
);

if (!rows.length) { console.error('No measured answers.'); await pool.end(); process.exit(1); }

const cycles = new Map(); // cycle -> Map(pairKey -> {asked, named})
for (const r of rows) {
  const cycle = new Date(r.cycle_date).toISOString().slice(0, 10);
  if (!cycles.has(cycle)) cycles.set(cycle, new Map());
  const key = `${r.prompt_id}:${r.engine}`;
  const cell = cycles.get(cycle).get(key) || { asked: 0, named: 0 };
  cell.asked++;
  if (r.mentioned) cell.named++;
  cycles.get(cycle).set(key, cell);
}

const ordered = [...cycles].sort((a, b) => a[0].localeCompare(b[0]));

console.log(`\n${project.name}  (project ${id})${ENGINE ? `  engine: ${ENGINE}` : ''}`);
console.log(`Brand: ${owned.name}\n`);

/* ---------------- everything, which is what is reported today ---------------- */

console.log('As currently measured, every question in each cycle');
console.log('The denominator moves, so these cycles are not comparable to each other.\n');
for (const [cycle, cells] of ordered) {
  const asked = [...cells.values()].reduce((s, c) => s + c.asked, 0);
  const named = [...cells.values()].reduce((s, c) => s + c.named, 0);
  console.log(`  ${cycle}   ${String(named).padStart(4)} of ${String(asked).padStart(5)}   ${((named / asked) * 100).toFixed(1)}%`);
}

/* ---------------- the cohort present in every cycle ---------------- */

const everywhere = [...ordered[0][1].keys()].filter((k) => ordered.every(([, cells]) => cells.has(k)));

console.log(`\n\nLike for like: the ${everywhere.length} question-and-engine pairs measured in all ${ordered.length} cycles`);

if (everywhere.length < 20) {
  console.log('\n  Too few pairs survive in every cycle for this to mean much. The question');
  console.log('  set changed too heavily. Compare adjacent cycles instead, below.');
} else {
  console.log('  This is the only line that can be read as a change in visibility.\n');
  const series = [];
  for (const [cycle, cells] of ordered) {
    let asked = 0;
    let named = 0;
    for (const k of everywhere) {
      const c = cells.get(k);
      asked += c.asked;
      named += c.named;
    }
    const rate = named / asked;
    series.push({ cycle, asked, named, rate });
    console.log(`  ${cycle}   ${String(named).padStart(4)} of ${String(asked).padStart(5)}   ${(rate * 100).toFixed(1)}%`);
  }

  const a = series[0];
  const b = series[series.length - 1];
  const change = (b.rate - a.rate) * 100;
  console.log(`\n  ${a.cycle} to ${b.cycle}: ${(a.rate * 100).toFixed(1)}% to ${(b.rate * 100).toFixed(1)}%, ` +
              `${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(1)} points.`);

  /**
   * A cohort this small carries real sampling noise, so a small move should
   * not be read as a change. Roughly two standard errors on the later rate.
   */
  const se = Math.sqrt((b.rate * (1 - b.rate)) / b.asked) * 100 * 2;
  console.log(`  Noise on ${b.asked} answers is about ${se.toFixed(1)} points either way.`);
  console.log(Math.abs(change) > se
    ? '  The move is larger than that, so it is a finding.'
    : '  The move is inside that, so it is not yet a finding. Say "no measurable change".');
}

/* ---------------- adjacent cycles, which keeps more of the data ---------------- */

console.log('\n\nCycle against the one before it, on whatever both had in common');
console.log('More pairs survive here than across all eight, so the comparison is\n' +
            'stronger, but it only tells you about one step at a time.\n');

for (let i = 1; i < ordered.length; i++) {
  const [prevCycle, prev] = ordered[i - 1];
  const [cycle, cur] = ordered[i];
  const shared = [...cur.keys()].filter((k) => prev.has(k));
  if (!shared.length) { console.log(`  ${prevCycle} -> ${cycle}   nothing in common`); continue; }

  let pa = 0, pn = 0, ca = 0, cn = 0;
  for (const k of shared) {
    pa += prev.get(k).asked; pn += prev.get(k).named;
    ca += cur.get(k).asked;  cn += cur.get(k).named;
  }
  const before = (pn / pa) * 100;
  const after = (cn / ca) * 100;
  const added = cur.size - shared.length;
  console.log(
    `  ${prevCycle} -> ${cycle}   ${String(shared.length).padStart(4)} pairs shared   ` +
    `${before.toFixed(1)}% -> ${after.toFixed(1)}%   ` +
    `${after - before >= 0 ? '+' : ''}${(after - before).toFixed(1)} pts` +
    (added > 0 ? `   (${added} new pairs excluded)` : '')
  );
}

/* ---------------- competitors, on a window they all share ---------------- */

/**
 * Share of voice is a comparison, and a competitor added in cycle six has no
 * mentions in cycles one to five. Ranking on all-time totals therefore ranks
 * partly by how long each name has been tracked, which is the same moving
 * denominator that made the brand's own count look like growth.
 *
 * There is no created_at on entities, so the first cycle carrying a mention
 * row for that entity is when tracking began. A row is written for every
 * tracked entity on every answer, mentioned or not, so its presence is the
 * record of being measured.
 */
const rivals = await many(
  `SELECT e.id, e.name, e.kind,
          MIN(r.cycle_date) AS first_cycle,
          COUNT(*)::int                                   AS measured,
          COUNT(*) FILTER (WHERE m.mentioned)::int        AS named
   FROM entities e
   JOIN mentions m ON m.entity_id = e.id
   JOIN runs r ON r.id = m.run_id AND r.ok
   WHERE e.project_id = $1
   GROUP BY e.id, e.name, e.kind
   ORDER BY named DESC`,
  [id]
);

const lastCycle = ordered[ordered.length - 1][0];

const latest = await many(
  `SELECT e.id,
          COUNT(*)::int                             AS measured,
          COUNT(*) FILTER (WHERE m.mentioned)::int  AS named
   FROM entities e
   JOIN mentions m ON m.entity_id = e.id
   JOIN runs r ON r.id = m.run_id AND r.ok AND r.cycle_date = $2
   WHERE e.project_id = $1
   GROUP BY e.id`,
  [id, lastCycle]
);
const latestById = new Map(latest.map((l) => [l.id, l]));

const projectStart = ordered[0][0];

console.log('\n\nEvery tracked name. All-time totals against the latest cycle alone.');
console.log('A name added late has no mentions in the cycles before it, so its all-time');
console.log(`total is not comparable. The latest cycle is, because every name still\ntracked was measured in it.\n`);
console.log('  tracked from   all-time      latest cycle     name');

for (const r of rivals) {
  const from = new Date(r.first_cycle).toISOString().slice(0, 10);
  const late = r.first_cycle && from > projectStart;
  const l = latestById.get(r.id);
  const allTime = r.measured ? `${((r.named / r.measured) * 100).toFixed(1)}%` : '   -  ';
  const now = l && l.measured ? `${((l.named / l.measured) * 100).toFixed(1)}%` : 'not measured';
  console.log(
    `  ${from}   ${String(r.named).padStart(4)}  ${allTime.padStart(6)}   ` +
    `${String(l?.named ?? 0).padStart(4)}  ${now.padStart(12)}   ` +
    `${r.kind === 'owned' ? '* ' : '  '}${r.name}${late ? '   <-- added late, all-time understates it' : ''}`
  );
}

const late = rivals.filter((r) => new Date(r.first_cycle).toISOString().slice(0, 10) > projectStart);
if (late.length) {
  console.log(`\n  ${late.length} of ${rivals.length} names were added after the first cycle. Rank on the`);
  console.log('  latest-cycle column, or on a window they all share, and never on the');
  console.log('  all-time totals.');
}

console.log('\nRead only. Nothing was written, and no engine was called.\n');
await pool.end();
