import 'dotenv/config';
import { pool, many, query } from '../src/db/index.js';
import { isWrapper, resolveUrl } from '../src/lib/resolve.js';
import { isSourceUrl, isLocalListing } from '../src/lib/dataforseo.js';

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
const clean = process.argv.includes('--clean');
const show = process.argv.find((a) => a.startsWith('--show='))?.slice(7);

/**
 * What a domain's stored URLs actually look like.
 *
 *   npm run sources -- --show=google.com
 *
 * 7,759 citations for google.com is not a finding about Google, it is a
 * question about what got stored, and the answer is in the URLs.
 */
if (show) {
  const rows = await many(
    `SELECT url, COUNT(*)::int AS n FROM citations WHERE domain = $1 GROUP BY url ORDER BY n DESC LIMIT 12`,
    [show]
  );
  console.log(`\nstored URLs for ${show}\n`);
  for (const r of rows) {
    const verdict = !isSourceUrl(r.url) ? '  <- not a source' : isWrapper(r.url) ? '  <- redirect wrapper' : '';
    console.log(`  ${String(r.n).padStart(5)}  ${r.url.slice(0, 96)}${verdict}`);
  }
  console.log('');
  await pool.end();
  process.exit(0);
}

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
/**
 * Remove what should never have been stored.
 *
 * The collector walks the response for any key containing "url", which sweeps
 * up the API's own envelope, image CDNs and search pages alongside the real
 * citations. Those inflate source counts and produce actions about domains
 * nobody could ever approach.
 */
if (clean) {
  const junk = await many(
    `SELECT c.id, c.url FROM citations c ${id ? 'JOIN runs r ON r.id = c.run_id WHERE r.project_id = $1' : ''}`,
    id ? [id] : []
  );
  const remove = junk.filter((c) => !isSourceUrl(c.url)).map((c) => c.id);

  if (!remove.length) {
    console.log('Nothing stored that is not a source.\n');
  } else {
    // In batches, since this can be tens of thousands of rows.
    for (let i = 0; i < remove.length; i += 2000) {
      await query('DELETE FROM citations WHERE id = ANY($1::int[])', [remove.slice(i, i + 2000)]);
    }
    console.log(`Removed ${remove.length} citations that were never sources.`);
    console.log('Rebuild the action lists so they reflect it:  npm run rebuild -- --all\n');
  }
} else {
  const junk = await many(
    `SELECT c.url FROM citations c ${id ? 'JOIN runs r ON r.id = c.run_id WHERE r.project_id = $1' : ''}`,
    id ? [id] : []
  );
  const bad = junk.filter((c) => !isSourceUrl(c.url)).length;
  if (bad) {
    console.log(`${bad} stored citations are not sources at all: our own API, image CDNs, search pages.`);
    console.log('Remove them:  npm run sources -- --clean\n');
  }
}

console.log('');
await pool.end();
