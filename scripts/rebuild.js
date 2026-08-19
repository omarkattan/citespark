import 'dotenv/config';
import { pool, many, one } from '../src/db/index.js';
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

if (!id) {
  const rows = await many('SELECT id, name, domain FROM projects ORDER BY id');
  console.log('\nsites\n');
  for (const r of rows) console.log(`  ${String(r.id).padStart(3)}  ${r.name} (${r.domain})`);
  console.log('\nnpm run rebuild -- <id>\n');
  await pool.end();
  process.exit(0);
}

const project = await one('SELECT id, name FROM projects WHERE id = $1', [id]);
if (!project) {
  console.error(`No site with id ${id}.`);
  await pool.end();
  process.exit(1);
}

const before = (await one('SELECT COUNT(*)::int AS n FROM recommendations WHERE project_id = $1', [id])).n;
const recs = await buildRecommendations(id);
await persistRecommendations(id, recs);
const after = (await one('SELECT COUNT(*)::int AS n FROM recommendations WHERE project_id = $1', [id])).n;

console.log(`\n${project.name}: ${before} actions before, ${after} after.\n`);
await pool.end();
