import 'dotenv/config';
import { pool, many } from '../src/db/index.js';
import { isWrapper } from '../src/lib/resolve.js';

/**
 * What domains are actually stored as citation sources.
 *
 *   npm run sources          across everything
 *   npm run sources -- 1     one site
 *
 * Written because "no citations are stored against a redirect wrapper"
 * contradicted what was on screen, and the useful next step was to look at
 * the data rather than reason about it.
 */
const id = Number(process.argv.find((a) => /^\d+$/.test(a)));

if (id) {
  const exists = await many('SELECT id FROM projects WHERE id = $1', [id]);
  if (!exists.length) {
    const rows = await many('SELECT id, name FROM projects ORDER BY id');
    console.error(`\nNo site with id ${id}. These exist:\n`);
    for (const r of rows) console.error(`  ${String(r.id).padStart(3)}  ${r.name}`);
    console.error('');
    await pool.end();
    process.exit(1);
  }
}

const rows = await many(
  `SELECT c.domain, COUNT(*)::int AS n, COUNT(DISTINCT c.url)::int AS urls, MAX(r.cycle_date) AS last_seen
   FROM citations c JOIN runs r ON r.id = c.run_id
   ${id ? 'WHERE r.project_id = $1' : ''}
   GROUP BY c.domain ORDER BY n DESC LIMIT 40`,
  id ? [id] : []
);

console.log(`\ncitation sources${id ? ` for site ${id}` : ' across every site'}\n`);
if (!rows.length) console.log('  none stored');
console.log('  citations  links  last seen    domain');
for (const r of rows) {
  const flag = isWrapper(`https://${r.domain}/`) ? '  <- redirect wrapper' : '';
  console.log(
    `  ${String(r.n).padStart(9)}  ${String(r.urls).padStart(5)}  ${new Date(r.last_seen).toISOString().slice(0, 10)}   ${r.domain}${flag}`
  );
}

// The action list is written during a cycle and then left alone, so it can
// disagree with the citations underneath it.
const stale = await many(
  `SELECT project_id, title FROM recommendations
   WHERE title ILIKE '%vertexaisearch%' OR title ILIKE '%grounding%' OR target_url ILIKE '%vertexaisearch%'`
);
if (stale.length) {
  console.log(`\n${stale.length} action(s) still name a redirect wrapper:`);
  for (const s of stale.slice(0, 6)) console.log(`  site ${s.project_id}: ${s.title.slice(0, 66)}`);
  console.log('\nThese were written by an earlier cycle. Rebuild all of them at once:');
  console.log('  npm run rebuild -- --stale');
}
console.log('');
await pool.end();
