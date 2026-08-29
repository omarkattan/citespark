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

    const cycle = String(run.cycle_date).slice(0, 10);
    if (!byCycle.has(cycle)) byCycle.set(cycle, { was: 0, now: 0 });
    if (r.entity_id === owned?.id) {
      const c = byCycle.get(cycle);
      if (old.mentioned) c.was++;
      if (r.mentioned) c.now++;
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
  console.log(`${owned.name}, named per cycle:\n`);
  for (const [cycle, c] of [...byCycle].sort()) {
    const delta = c.now - c.was;
    console.log(
      `  ${cycle}   was ${String(c.was).padStart(4)}   now ${String(c.now).padStart(4)}   ` +
      (delta === 0 ? 'unchanged' : `${delta > 0 ? '+' : ''}${delta}  (${Math.round((delta / Math.max(1, c.was)) * 100)}%)`)
    );
  }
  const totalWas = [...byCycle.values()].reduce((s, c) => s + c.was, 0);
  const totalNow = [...byCycle.values()].reduce((s, c) => s + c.now, 0);
  console.log(`\n  Across every cycle: ${totalWas} to ${totalNow}.`);
  console.log('  If the shape of the line survives, the trend was always real and only');
  console.log('  the level was wrong. If the shape changes, say so before showing it.');
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
