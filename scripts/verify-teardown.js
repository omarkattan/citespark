import 'dotenv/config';
import { pool, many } from '../src/db/index.js';

/**
 * Check a claim in the report against the pages it was drawn from.
 *
 *   npm run verify -- 7
 *
 * The features table is the section most likely to drive work and the hardest
 * to sanity check, because a parsing failure and a real absence look
 * identical once they are both a zero. This prints what was found per page,
 * with the URLs, so any row can be opened and checked by eye.
 */
const id = Number(process.argv.find((a) => /^\d+$/.test(a)));
if (!id) {
  console.error('\nnpm run verify -- <projectId>\n');
  await pool.end();
  process.exit(1);
}

const rows = await many(
  `SELECT DISTINCT ON (t.url) t.url, t.result
   FROM page_teardowns t
   JOIN citations c ON lower(c.url) = lower(t.url)
   JOIN runs r ON r.id = c.run_id AND r.project_id = $1
   WHERE t.result IS NOT NULL
   ORDER BY t.url, t.created_at DESC`,
  [id]
);

if (!rows.length) {
  console.log('\nNo cited pages have been read for this site yet.\n');
  await pool.end();
  process.exit(0);
}

console.log(`\nRead from ${rows.length} cited pages\n`);
console.log('  faq  author  date  figures  heading  schema types');

let faq = 0;
const allTypes = new Map();

for (const { url, result } of rows) {
  const s = result?.structure || result || {};
  const types = s.schemaTypes || [];
  for (const t of types) allTypes.set(t, (allTypes.get(t) || 0) + 1);
  if (s.hasFaqSchema) faq++;

  const tick = (v) => (v ? ' yes ' : '  .  ');
  console.log(
    `  ${tick(s.hasFaqSchema)}${tick(s.hasAuthor)} ${tick(s.publishedOrUpdated)}${tick(s.statMentions)}${tick(
      s.headingsMatchingQuestion?.length
    )}  ${types.slice(0, 4).join(', ') || 'none'}`
  );
  console.log(`       ${url.slice(0, 100)}`);
}

console.log(`\nFAQ or QA schema: ${faq} of ${rows.length} pages`);

// The strongest signal that a zero is real rather than a parsing failure: if
// schema is being read at all, an absent type is an absence rather than a miss.
const withSchema = rows.filter((r) => ((r.result?.structure || r.result || {}).schemaTypes || []).length).length;
console.log(`Pages where any schema was read: ${withSchema} of ${rows.length}`);

if (faq === 0 && withSchema > 0) {
  console.log('\nSchema is being read successfully on those pages and FAQPage is not among the types found,');
  console.log('so the zero is a real absence rather than a parsing failure. Worth knowing: Google retired');
  console.log('FAQ rich results for most sites in 2023, and many publishers removed the markup afterwards.');
} else if (faq === 0) {
  console.log('\nNo schema was read on any page, so this zero cannot be trusted. Check the fetch is');
  console.log('returning rendered HTML rather than a block page.');
}

if (allTypes.size) {
  console.log('\nSchema types actually found:');
  for (const [t, n] of [...allTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(3)}  ${t}`);
  }
}
console.log('');
await pool.end();
