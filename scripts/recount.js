import 'dotenv/config';
import { pool, many, one, query } from '../src/db/index.js';
import { analyseRun } from '../src/lib/analyze.js';

/**
 * Re-read every stored answer and correct the counts.
 *
 *   npm run recount -- 7              show what would change, change nothing
 *   npm run recount -- 7 --apply      write the corrections
 *
 * Detection runs on text we already hold, so this calls no engine and spends
 * nothing. It exists because a counting rule changed and the old numbers were
 * produced by the old rule: leaving history alone would mean a trend line
 * whose early points and late points mean different things, which is worse
 * than a line that moves once for a stated reason.
 *
 * --apply also writes a method_notes row, so the correction appears next to
 * the numbers it changed instead of living in someone's memory.
 *
 * Sentiment is left exactly as it is. It was partly set by a model and cannot
 * be reproduced deterministically, so recomputing it would quietly replace
 * evidence with a fresh guess.
 */

const args = process.argv.slice(2);
const id = Number(args.find((a) => /^\d+$/.test(a)));
const APPLY = args.includes('--apply');

if (!id) {
  const rows = await many('SELECT id, name FROM projects ORDER BY id');
  console.log('Give a project id:\n' + rows.map((r) => `  ${r.id}  ${r.name}`).join('\n'));
  await pool.end();
  process.exit(0);
}

const project = await one('SELECT * FROM projects WHERE id = $1', [id]);
if (!project) { console.error(`No project ${id}.`); await pool.end(); process.exit(1); }

const entities = await many(
  'SELECT id, name, domain, kind, aliases, ambiguous_name FROM entities WHERE project_id = $1 ORDER BY id',
  [id]
);
if (!entities.length) { console.error('No entities on that project.'); await pool.end(); process.exit(1); }

const owned = entities.find((e) => e.kind === 'owned');
const flagged = entities.filter((e) => e.ambiguous_name);

console.log(`\n${project.name}  (project ${id})`);
console.log(`${entities.length} tracked, ${flagged.length} flagged as an ordinary phrase${flagged.length ? `: ${flagged.map((f) => f.name).join(', ')}` : ''}`);
if (!flagged.length) {
  console.log('\nNothing is flagged, so a recount would reproduce the existing numbers.');
  console.log('Set the flag in Settings on any brand whose name is also a common phrase first.');
  await pool.end();
  process.exit(0);
}
console.log(APPLY ? '\nAPPLYING changes.\n' : '\nDry run. Nothing will be written. Add --apply to commit.\n');

/**
 * Only answers we still hold the text for can be recounted. A run whose text
 * was never stored is left untouched rather than rewritten from nothing.
 */
const runs = await many(
  `SELECT id, engine, cycle_date, response_text
   FROM runs
   WHERE project_id = $1 AND ok AND response_text IS NOT NULL AND response_text <> ''
   ORDER BY cycle_date, id`,
  [id]
);

console.log(`Reading ${runs.length} stored answers`);

const before = new Map();
for (const m of await many(
  `SELECT m.run_id, m.entity_id, m.mentioned, m.ordinal
   FROM mentions m JOIN runs r ON r.id = m.run_id WHERE r.project_id = $1`,
  [id]
)) {
  before.set(`${m.run_id}:${m.entity_id}`, m);
}

const byCycle = new Map();
const changes = [];
let scanned = 0;

for (const run of runs) {
  const results = await analyseRun({ text: run.response_text, entities, useModel: false });
  scanned++;
  if (scanned % 500 === 0) process.stdout.write(`  ${scanned}/${runs.length}\r`);

  for (const r of results) {
    const key = `${run.id}:${r.entity_id}`;
    const old = before.get(key);
    if (!old) continue; // never measured; not this script's job to invent one

    // cycle_date arrives as a Date, and String() on it gives "Fri Aug 21 2026",
    // which then sorts alphabetically and scrambles the order of the cycles.
    const cycle = new Date(run.cycle_date).toISOString().slice(0, 10);
    if (!byCycle.has(cycle)) byCycle.set(cycle, { measured: 0, was: 0, now: 0, wasFirst: 0, nowFirst: 0 });
    if (r.entity_id === owned?.id) {
      const c = byCycle.get(cycle);
      // The denominator matters as much as the count. A rising count across
      // cycles means nothing if the question set grew underneath it.
      c.measured++;
      if (old.mentioned) c.was++;
      if (r.mentioned) c.now++;
      if (old.ordinal === 1) c.wasFirst++;
      if (r.ordinal === 1) c.nowFirst++;
    }

    if (old.mentioned !== r.mentioned || old.ordinal !== r.ordinal) {
      changes.push({ runId: run.id, entityId: r.entity_id, engine: run.engine, cycle, from: old.mentioned, to: r.mentioned, ordinal: r.ordinal });
    }
  }
}

const lost = changes.filter((c) => c.from && !c.to).length;
const gained = changes.filter((c) => !c.from && c.to).length;
const reordered = changes.length - lost - gained;

console.log(`\n\n${changes.length} rows change: ${lost} no longer counted, ${gained} newly counted, ${reordered} re-ordered\n`);

if (owned) {
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '   -  ');
  console.log(`${owned.name}, per cycle. "Of" is how many answers were measured that cycle.\n`);
  console.log('  cycle        measured    named was -> now        rate was -> now      named first');
  for (const [cycle, c] of [...byCycle].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(
      `  ${cycle}   ${String(c.measured).padStart(6)}    ` +
      `${String(c.was).padStart(4)} -> ${String(c.now).padStart(4)}   ` +
      `   ${pct(c.was, c.measured).padStart(7)} -> ${pct(c.now, c.measured).padStart(7)}   ` +
      `   ${String(c.wasFirst).padStart(3)} -> ${String(c.nowFirst).padStart(3)}`
    );
  }

  const sum = (k) => [...byCycle.values()].reduce((s, c) => s + c[k], 0);
  const cycles = [...byCycle].sort((a, b) => a[0].localeCompare(b[0]));
  const first = cycles[0]?.[1];
  const last = cycles[cycles.length - 1]?.[1];

  console.log(`\n  Across every cycle: ${sum('was')} named of ${sum('measured')} measured, now ${sum('now')}.`);

  if (first && last && cycles.length > 1) {
    const wasGrowth = first.was ? last.was / first.was : null;
    const nowGrowth = first.now ? last.now / first.now : null;
    const wasRate = first.measured && last.measured ? (last.was / last.measured) / (first.was / first.measured) : null;
    const nowRate = first.measured && last.measured ? (last.now / last.measured) / (first.now / first.measured) : null;

    console.log(`\n  First cycle to last, by count: ${wasGrowth ? wasGrowth.toFixed(2) : '?'}x before, ${nowGrowth ? nowGrowth.toFixed(2) : '?'}x after.`);
    console.log(`  First cycle to last, by rate:  ${wasRate ? wasRate.toFixed(2) : '?'}x before, ${nowRate ? nowRate.toFixed(2) : '?'}x after.`);
    console.log('\n  Use the rate. A count that rose because the question set grew is not');
    console.log('  a visibility improvement, and the two columns will disagree when that');
    console.log('  is what happened.');
  }

  console.log('\n  The correction is not uniform across cycles, so the shape moves a little');
  console.log('  as well as the level. Read the rate column before repeating any figure.');
}

/**
 * Share of voice is a comparison, so a correction that lands on one entity
 * and not the others changes the ranking as much as the counts. Every flagged
 * entity is listed, not just the owned one.
 */
if (flagged.length > 1 || changes.some((c) => c.entityId !== owned?.id)) {
  const perEntity = new Map();
  for (const c of changes) {
    const e = perEntity.get(c.entityId) || { lost: 0, gained: 0 };
    if (c.from && !c.to) e.lost++;
    if (!c.from && c.to) e.gained++;
    perEntity.set(c.entityId, e);
  }
  console.log('\nBy entity, so the comparison between them stays honest:\n');
  for (const [entityId, e] of [...perEntity].sort((a, b) => b[1].lost - a[1].lost)) {
    const ent = entities.find((x) => x.id === entityId);
    if (!ent || (!e.lost && !e.gained)) continue;
    console.log(`  ${String(ent.kind).padEnd(11)} ${ent.name.padEnd(34)} ${String(-e.lost).padStart(5)} removed`);
  }
  const untouched = entities.filter((e) => !e.ambiguous_name && e.kind === 'competitor');
  if (untouched.length) {
    console.log(`\n  ${untouched.length} competitors are not flagged and keep their old counts.`);
    console.log('  If any of their names is also an ordinary word, the comparison now');
    console.log('  runs in their favour. npm run audit ranks them by how often they were');
    console.log('  written in lower case.');
  }
}

if (!APPLY) {
  console.log('\nNothing was written. Re-run with --apply to commit.\n');
  await pool.end();
  process.exit(0);
}

for (const c of changes) {
  await query('UPDATE mentions SET mentioned = $3, ordinal = $4 WHERE run_id = $1 AND entity_id = $2', [
    c.runId, c.entityId, c.to, c.ordinal
  ]);
}

const note = `Counting corrected for ${flagged.map((f) => f.name).join(', ')}`;
const detail =
  `A brand name that is also an ordinary phrase was matched case-insensitively, so wording such as ` +
  `"the family office model" counted as a mention of the firm. The name now has to appear in title case; ` +
  `aliases and the domain are unaffected. ${runs.length} stored answers were re-read and ${changes.length} ` +
  `rows changed (${lost} removed, ${gained} added). No engine was called and no answer text was altered.`;

await query('INSERT INTO method_notes (project_id, note, detail) VALUES ($1,$2,$3)', [id, note, detail]);

console.log(`\nApplied. ${changes.length} rows updated and a methodology note recorded.`);
console.log('Every number derived from these counts will move. Tell the client before they notice.\n');
await pool.end();
