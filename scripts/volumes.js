import 'dotenv/config';
import { pool, many, query, one } from '../src/db/index.js';
import { aiKeywordVolume } from '../src/lib/dataforseo.js';

/**
 * Replace estimated question volumes with measured ones.
 *
 *   npm run volumes -- 7          show what would change
 *   npm run volumes -- 7 --fix    write the measured figures
 *
 * Volume drives the priority ordering of every recommendation, and it has
 * been a language model's guess at a number between 0 and 5000. DataForSEO
 * measures it. A guess that ranks the work is worth replacing.
 */
const id = Number(process.argv.find((a) => /^\d+$/.test(a)));
const fix = process.argv.includes('--fix');

if (!id) {
  const rows = await many('SELECT id, name, domain FROM projects ORDER BY id');
  console.log('\nsites\n');
  for (const r of rows) console.log(`  ${String(r.id).padStart(3)}  ${r.name} (${r.domain})`);
  console.log('\nnpm run volumes -- <id> [--fix]\n');
  await pool.end();
  process.exit(0);
}

const project = await one('SELECT id, name, market, language FROM projects WHERE id = $1', [id]);
if (!project) {
  console.error(`No site with id ${id}.`);
  await pool.end();
  process.exit(1);
}

const prompts = await many(
  'SELECT id, text, ai_search_volume FROM prompts WHERE project_id = $1 AND active ORDER BY id',
  [id]
);

if (!prompts.length) {
  console.log('\nNo active questions on that site.\n');
  await pool.end();
  process.exit(0);
}

console.log(`\n${project.name}: measuring ${prompts.length} questions in ${project.market}\n`);

let measured;
try {
  measured = await aiKeywordVolume(
    prompts.map((p) => p.text),
    { market: project.market, language: project.language || 'en' }
  );
} catch (err) {
  console.error(`\nCould not reach the AI keyword data endpoint: ${err.message}`);
  console.error('Nothing was changed.\n');
  await pool.end();
  process.exit(1);
}

let changed = 0;
let missing = 0;

console.log('  estimated  measured   question');
for (const p of prompts) {
  const hit = measured.get(p.text.trim().toLowerCase());

  // No figure is not zero demand. Overwriting an estimate with a zero would
  // push a question to the bottom of the list on the strength of an absence.
  if (!hit || hit.volume === null) {
    missing++;
    continue;
  }

  if (hit.volume !== p.ai_search_volume) {
    changed++;
    console.log(
      `  ${String(p.ai_search_volume).padStart(9)}  ${String(hit.volume).padStart(8)}   ${p.text.slice(0, 62)}`
    );
    if (fix) await query('UPDATE prompts SET ai_search_volume = $2 WHERE id = $1', [p.id, hit.volume]);
  }
}

console.log(`\n${changed} of ${prompts.length} would change.`);
if (missing) console.log(`${missing} had no measured figure and were left as they are.`);

if (!fix && changed) {
  console.log('\nRun with --fix to write them, then rebuild so the priorities reflect it:');
  console.log(`  npm run volumes -- ${id} --fix && npm run rebuild -- ${id}\n`);
} else if (fix) {
  console.log(`\nWritten. Rebuild the actions so the ordering reflects it:  npm run rebuild -- ${id}\n`);
} else {
  console.log('');
}

await pool.end();
