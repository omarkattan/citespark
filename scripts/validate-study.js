import 'dotenv/config';
import { pool, one, many } from '../src/db/index.js';

/**
 * Read the answers and check the extraction by eye.
 *
 *   npm run study:validate            20 answers, mixed
 *   npm run study:validate -- 40
 *   npm run study:validate -- --ambiguous   only answers with an ambiguous match
 *   npm run study:validate -- --empty       answers where nobody was found
 *
 * This is the step that decides whether the published numbers mean anything.
 * Every ambiguous match shows the reason it was accepted, so a wrong one is
 * visible rather than buried in an aggregate.
 */
const args = process.argv.slice(2);
const limit = Number(args.find((a) => /^\d+$/.test(a))) || 20;
const onlyAmbiguous = args.includes('--ambiguous');
const onlyEmpty = args.includes('--empty');

const study = await one("SELECT * FROM sector_studies WHERE slug = 'property-developers'");
const cycle = (await one('SELECT MAX(cycle_date) AS d FROM sector_answers WHERE study_id = $1', [study.id]))?.d;
if (!cycle) {
  console.error('Nothing measured yet. Run: npm run study:run');
  await pool.end();
  process.exit(1);
}

const rows = await many(
  `SELECT a.id, a.engine, a.answer_text, a.ok, a.error, p.key AS prompt_key, p.text AS prompt, p.kind,
          (SELECT COUNT(*)::int FROM sector_mentions m WHERE m.answer_id = a.id) AS n
   FROM sector_answers a JOIN sector_prompts p ON p.id = a.prompt_id
   WHERE a.study_id = $1 AND a.cycle_date = $2 AND a.ok
     AND a.answer_text IS NOT NULL AND length(a.answer_text) > 0
   ORDER BY random() LIMIT $3`,
  [study.id, cycle, onlyEmpty ? 200 : limit]
);

const shown = onlyEmpty ? rows.filter((r) => r.n === 0).slice(0, limit) : rows;

console.log(`\n${study.name}, ${cycle}\n`);

for (const r of shown) {
  const mentions = await many(
    `SELECT c.key, c.name, m.ordinal, m.matched_alias, m.recommended, m.cited, m.citation_url
     FROM sector_mentions m JOIN sector_companies c ON c.id = m.company_id
     WHERE m.answer_id = $1 ORDER BY m.ordinal`,
    [r.id]
  );

  if (onlyAmbiguous && !mentions.some((m) => m.matched_alias.split(' ').length === 1)) continue;

  console.log('─'.repeat(78));
  console.log(`[${r.engine}] ${r.prompt_key}: ${r.prompt.slice(0, 100)}`);
  console.log();
  console.log((r.answer_text || '').slice(0, 700).replace(/\n{2,}/g, '\n').split('\n').map((l) => '  ' + l).join('\n'));
  if ((r.answer_text || '').length > 700) console.log('  …');
  console.log();

  if (!mentions.length) {
    console.log('  EXTRACTED: nobody. Check whether that is right.');
  } else {
    console.log('  EXTRACTED:');
    for (const m of mentions) {
      console.log(
        `    ${String(m.ordinal).padStart(2)}. ${m.name.padEnd(26)} matched "${m.matched_alias}"` +
          `${m.via_project ? '  [PROJECT NAME, not corporate]' : ''}` +
          `${m.recommended ? '  recommended' : ''}${m.cited ? `  cited ${m.citation_url?.slice(0, 46)}` : ''}`
      );
    }
  }
  console.log();
}

const stats = await one(
  `SELECT COUNT(DISTINCT a.id)::int AS answers,
          COUNT(m.id)::int AS mentions,
          COUNT(DISTINCT a.id) FILTER (WHERE m.id IS NULL)::int AS empty_answers,
          COUNT(m.id) FILTER (WHERE m.cited)::int AS cited,
          COUNT(m.id) FILTER (WHERE m.recommended)::int AS recommended,
          COUNT(m.id) FILTER (WHERE m.via_project)::int AS via_project
   FROM sector_answers a LEFT JOIN sector_mentions m ON m.answer_id = a.id
   WHERE a.study_id = $1 AND a.cycle_date = $2 AND a.ok`,
  [study.id, cycle]
);

// Engine-level health first: a surface that returned nothing for most prompts
// is not a finding about developers, it is a gap in the measurement.
const health = await many(
  `SELECT engine,
          COUNT(*)::int AS attempted,
          COUNT(*) FILTER (WHERE ok AND length(COALESCE(answer_text,'')) > 0)::int AS with_text,
          COUNT(*) FILTER (WHERE ok AND COALESCE(answer_text,'') = '')::int AS empty,
          COUNT(*) FILTER (WHERE NOT ok)::int AS failed,
          MIN(error) AS sample_error
   FROM sector_answers WHERE study_id = $1 AND cycle_date = $2
   GROUP BY engine ORDER BY engine`,
  [study.id, cycle]
);

console.log('─'.repeat(78));
console.log('engine health');
for (const h of health) {
  console.log(
    `  ${h.engine.padEnd(13)} ${h.with_text}/${h.attempted} answered` +
      `${h.empty ? `, ${h.empty} returned nothing` : ''}` +
      `${h.failed ? `, ${h.failed} failed (${(h.sample_error || '').slice(0, 44)})` : ''}`
  );
}
// A surface that answered nothing is a measurement gap, not a finding about
// developers, and must not silently become part of a published denominator.
const dead = health.filter((h) => h.with_text === 0 && h.attempted > 0);
if (dead.length) {
  console.log();
  for (const h of dead) {
    console.log(`  ${h.engine} returned no usable answer at all. Either fix it or drop it from the`);
    console.log('  run and say so on the page. Scoring it as zero would report a gap in our');
    console.log('  measurement as an absence of the developers.');
  }
}
console.log();
console.log(`across the whole run: ${stats.answers} answers, ${stats.mentions} mentions`);
console.log(`  ${stats.empty_answers} answers named no developer at all`);
console.log(`  ${stats.cited} mentions came with a citation to that developer's own site`);
console.log(`  ${stats.recommended} mentions were phrased as a recommendation`);
console.log('\nWhat to look for: a developer named in the text but missing above, anything');
console.log('matched that is not that company, and ordinals that do not match reading order.\n');
await pool.end();
