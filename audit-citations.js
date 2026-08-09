import 'dotenv/config';
import { pool, many, one } from '../src/db/index.js';

/**
 * Why is a given developer top of the citation table?
 *
 *   npm run study:citations
 *
 * Raw citation counts follow the question mix. A developer that dominates a
 * cohort with few rivals will top a table built across every question, for a
 * reason that has nothing to do with its own visibility. This shows both the
 * raw count and the rate per mention, and where each citation came from.
 */
const study = await one("SELECT * FROM sector_studies WHERE slug = 'property-developers'");
const cycle = (await one('SELECT MAX(cycle_date) AS d FROM sector_answers WHERE study_id = $1', [study.id]))?.d;

const rows = await many(
  `SELECT c.key, c.name,
          COUNT(m.id) FILTER (WHERE m.mentioned AND NOT m.via_project)::int AS mentions,
          COUNT(m.id) FILTER (WHERE m.cited AND NOT m.via_project)::int AS citations
   FROM sector_companies c
   LEFT JOIN sector_mentions m ON m.company_id = c.id
   LEFT JOIN sector_answers a ON a.id = m.answer_id AND a.cycle_date = $2
   WHERE c.study_id = $1 AND c.active
   GROUP BY c.key, c.name
   HAVING COUNT(m.id) FILTER (WHERE m.cited) > 0
   ORDER BY citations DESC`,
  [study.id, cycle]
);

console.log(`\nCitations by developer, ${cycle}\n`);
console.log('  cited  mentions  rate   developer');
for (const r of rows) {
  const rate = r.mentions ? Math.round((r.citations / r.mentions) * 100) : 0;
  console.log(`  ${String(r.citations).padStart(5)}  ${String(r.mentions).padStart(8)}  ${String(rate).padStart(3)}%   ${r.name}`);
}

// Where those citations came from, which is where the distortion shows.
const byGeo = await many(
  `SELECT c.key, p.geo, COUNT(m.id)::int AS citations
   FROM sector_mentions m
   JOIN sector_companies c ON c.id = m.company_id
   JOIN sector_answers a ON a.id = m.answer_id
   JOIN sector_prompts p ON p.id = a.prompt_id
   WHERE a.study_id = $1 AND a.cycle_date = $2 AND m.cited AND NOT m.via_project
   GROUP BY c.key, p.geo ORDER BY c.key, citations DESC`,
  [study.id, cycle]
);

const grouped = new Map();
for (const r of byGeo) {
  if (!grouped.has(r.key)) grouped.set(r.key, []);
  grouped.get(r.key).push(`${r.geo || 'persona'} ${r.citations}`);
}
console.log('\nWhere each developer earned them:');
for (const [key, parts] of grouped) console.log(`  ${key.padEnd(18)} ${parts.join(', ')}`);

const mix = await many(
  `SELECT geo, COUNT(*)::int AS prompts FROM sector_prompts
   WHERE study_id = $1 AND v1 AND NOT excluded_from_public GROUP BY geo ORDER BY prompts DESC`,
  [study.id]
);
console.log('\nQuestion mix:', mix.map((m) => `${m.geo || 'persona'} ${m.prompts}`).join(', '));
console.log('\nA developer concentrated in a geo with few rivals will top the raw count.');
console.log('Compare the rate column, not the count.\n');
await pool.end();
