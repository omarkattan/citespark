import 'dotenv/config';
import { pool, many, query } from '../src/db/index.js';
import { isWrapper, resolveUrl } from '../src/lib/resolve.js';
import { domainOf } from '../src/lib/dataforseo.js';

/**
 * Repoint citations stored against a redirect wrapper.
 *
 *   npm run resolve            show what is affected
 *   npm run resolve -- --fix   follow each one and repoint it
 *
 * Google's AI surfaces cite vertexaisearch.cloud.google.com rather than the
 * publisher. Every one of those was recorded as a citation for Google, which
 * invents a source with a huge count and hides every real one. New citations
 * are resolved as they are stored; this is for what is already in the table.
 */
const fix = process.argv.includes('--fix');
const one = process.argv.find((a) => a.startsWith('http'));

/**
 * Diagnose a single link, printing what actually happened.
 *
 *   npm run resolve -- https://vertexaisearch.cloud.google.com/...
 *
 * When a batch quietly resolves nothing, the useful question is what one
 * link does, and the answer was previously invisible.
 */
if (one) {
  const { isWrapper: wrap } = await import('../src/lib/resolve.js');
  console.log(`\n${one.slice(0, 90)}${one.length > 90 ? '…' : ''}`);
  console.log(`  recognised as a wrapper: ${wrap(one)}`);
  if (!wrap(one)) {
    console.log('  nothing to do: this is already a publisher URL.\n');
    await pool.end();
    process.exit(0);
  }
  const r = await resolveUrl(one, { retryFailures: true });
  console.log(`  followed to            : ${r.resolved ? r.url : 'nothing'}`);
  if (!r.resolved) console.log(`  why                    : ${r.reason || 'unknown'}`);
  console.log('');
  await pool.end();
  process.exit(0);
}

const rows = await many(
  `SELECT domain, COUNT(*)::int AS n, COUNT(DISTINCT url)::int AS urls
   FROM citations GROUP BY domain ORDER BY n DESC`
);

const wrapped = rows.filter((r) => isWrapper(`https://${r.domain}/`));

if (!wrapped.length) {
  console.log('\nNo citations are stored against a redirect wrapper.\n');
  await pool.end();
  process.exit(0);
}

console.log('\nCitations recorded against a redirect rather than a publisher:\n');
for (const w of wrapped) {
  console.log(`  ${w.domain.padEnd(38)} ${String(w.n).padStart(5)} citations across ${w.urls} links`);
}

if (!fix) {
  console.log('\nRun with --fix to follow each link and repoint it.\n');
  await pool.end();
  process.exit(0);
}

const links = await many(
  `SELECT DISTINCT url FROM citations WHERE domain = ANY($1::text[]) AND url IS NOT NULL`,
  [wrapped.map((w) => w.domain)]
);

console.log(`\nFollowing ${links.length} links. This talks to the redirector, so it is not instant.\n`);

let fixed = 0;
let failed = 0;
const reasons = new Map();

for (const [i, l] of links.entries()) {
  const r = await resolveUrl(l.url);
  if (!r.resolved) {
    failed++;
    // Aggregated rather than printed per link: fifty identical 403s tell you
    // one thing, and printing them fifty times hides it.
    const why = r.reason || 'unknown';
    reasons.set(why, (reasons.get(why) || 0) + 1);
    continue;
  }

  const domain = domainOf(r.url);
  if (!domain) {
    failed++;
    continue;
  }

  const res = await query('UPDATE citations SET url = $2, domain = $3 WHERE url = $1', [l.url, r.url, domain]);
  fixed += res.rowCount;

  if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${links.length}`);
}

console.log(`\n${fixed} citations repointed. ${failed} links could not be followed.`);
if (failed) {
  console.log('Those stay as they are: a wrong publisher would be worse than an honest wrapper.\n');
  console.log('Why they failed:');
  for (const [why, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${why}`);
  }
  console.log('\nTo see one in detail:  npm run resolve -- <the url>');
}

// The actions were built from the old attribution and are now wrong.
console.log('\nRebuild the action list so it reflects the real sources:');
console.log('  npm run rebuild <projectId>   or run a cycle\n');
await pool.end();
