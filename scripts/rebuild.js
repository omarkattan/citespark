import 'dotenv/config';
import { pool, many, one, query } from '../src/db/index.js';
import { buildRecommendations, persistRecommendations } from '../src/lib/recommend.js';

/**
 * Rebuild a project's action list from the answers already stored.
 *
 *   npm run rebuild            list the sites
 *   npm run rebuild -- 1       rebuild that one
 *
 * Actions are written during a cycle and then left alone, so anything that
 * changes how stored answers are read, such as repointing citations away from
 * a redirect wrapper, leaves the list describing the old view until this runs.
 */
const id = Number(process.argv.find((a) => /^\d+$/.test(a)));
const all = process.argv.includes('--all');
const stale = process.argv.includes('--stale');

/**
 * Rebuild every site, or only the ones with an action the evidence no longer
 * supports. Doing this one id at a time is tedious when eight sites are
 * affected, and easy to get wrong when the ids are not contiguous.
 */
if (all || stale) {
  const targets = stale
    ? await many(
        `SELECT DISTINCT p.id, p.name FROM projects p
         JOIN recommendations r ON r.project_id = p.id
         WHERE r.title ILIKE '%vertexaisearch%' OR r.title ILIKE '%grounding-api%'
            OR r.target_url ILIKE '%vertexaisearch%'
         ORDER BY p.id`
      )
    : await many('SELECT id, name FROM projects ORDER BY id');

  if (!targets.length) {
    console.log(stale ? '\nNo site has a stale action.\n' : '\nNo sites.\n');
    await pool.end();
    process.exit(0);
  }

  console.log(`\nRebuilding ${targets.length} site(s)\n`);
  for (const t of targets) {
    const before = (await one('SELECT COUNT(*)::int AS n FROM recommendations WHERE project_id = $1', [t.id])).n;
    try {
      const recs = await buildRecommendations(t.id);
      await persistRecommendations(t.id, recs);

      /**
       * A site with no recent measurement produces no actions, and the
       * persist step then refuses to empty the board, which is right. But it
       * leaves a wrong action in place with no way to clear it, so remove the
       * ones naming a redirect wrapper explicitly. Those can never be correct.
       */
      const swept = await query(
        `DELETE FROM recommendations
         WHERE project_id = $1 AND status = 'open'
           AND (title ILIKE '%vertexaisearch%' OR title ILIKE '%grounding-api%' OR target_url ILIKE '%vertexaisearch%')`,
        [t.id]
      );

      const after = (await one('SELECT COUNT(*)::int AS n FROM recommendations WHERE project_id = $1', [t.id])).n;
      t.idle = recs.length === 0;
      console.log(
        `  ${String(t.id).padStart(3)}  ${t.name.padEnd(30)} ${before} -> ${after}` +
          (swept.rowCount ? `   (${swept.rowCount} wrapper action removed)` : '') +
          (t.idle ? '   [never measured]' : '')
      );
    } catch (err) {
      // One broken site must not stop the rest.
      console.log(`  ${String(t.id).padStart(3)}  ${t.name.padEnd(30)} failed: ${String(err.message).slice(0, 50)}`);
    }
  }
  const idle = targets.filter((t) => t.idle);
  if (idle.length) {
    console.log(`\n${idle.length} site(s) have never been measured, so there was nothing to rebuild.`);
    console.log('If they are duplicates or abandoned, deleting them from Setup keeps this list honest.');
  }
  console.log('');
  await pool.end();
  process.exit(0);
}

if (!id) {
  const rows = await many('SELECT id, name, domain FROM projects ORDER BY id');
  console.log('\nsites\n');
  for (const r of rows) console.log(`  ${String(r.id).padStart(3)}  ${r.name} (${r.domain})`);
  console.log('\n  npm run rebuild -- <id>       one site');
  console.log('  npm run rebuild -- --stale    only sites with an out-of-date action');
  console.log('  npm run rebuild -- --all      every site\n');
  await pool.end();
  process.exit(0);
}

const project = await one('SELECT id, name FROM projects WHERE id = $1', [id]);
if (!project) {
  // Ids are not contiguous once sites have been deleted, so say which exist
  // rather than leaving someone guessing.
  const rows = await many('SELECT id, name FROM projects ORDER BY id');
  console.error(`\nNo site with id ${id}. These exist:\n`);
  for (const r of rows) console.error(`  ${String(r.id).padStart(3)}  ${r.name}`);
  console.error('');
  await pool.end();
  process.exit(1);
}

const before = (await one('SELECT COUNT(*)::int AS n FROM recommendations WHERE project_id = $1', [id])).n;
const recs = await buildRecommendations(id);
await persistRecommendations(id, recs);
const after = (await one('SELECT COUNT(*)::int AS n FROM recommendations WHERE project_id = $1', [id])).n;

console.log(`\n${project.name}: ${before} actions before, ${after} after.\n`);
await pool.end();
