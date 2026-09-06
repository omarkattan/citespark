import 'dotenv/config';
import { many, one, pool } from '../src/db/index.js';
import { fetchQueries } from '../src/lib/gsc.js';

/**
 * Search demand beside AI visibility, per cluster: the gap table.
 *
 * GSC knows how often people ask in classic search; Cited knows how often
 * AI engines name the brand when asked the same things. Side by side, never
 * summed - impressions and answers are different denominators, and blending
 * them would manufacture a number with no referent. The sentence this table
 * exists to produce: "8,400 monthly impressions on pricing queries, and 0%
 * named in AI answers - that is the gap."
 *
 * Read-only, free (one GSC API call), no schema.
 *
 *   npm run demand -- 4
 */
const id = Number(process.argv[2]);
if (!id) { console.error('Name a project: npm run demand -- 4'); process.exit(1); }
const project = await one('SELECT * FROM projects WHERE id = $1', [id]);
if (!project) { console.error(`No project ${id}`); process.exit(1); }

const rows = await fetchQueries(project, { days: 90 }).catch((e) => {
  console.error(`GSC not readable for this project: ${e.message}`);
  process.exit(1);
});

// Match GSC queries to Cited clusters by the cluster's own keywords: every
// word of the cluster name must appear in the query. Crude and stated, so a
// client can check any row by hand - a fuzzier match would score better and
// be defensible never.
const clusters = await many(
  `SELECT p.cluster,
          COUNT(DISTINCT p.id)::int AS questions,
          COUNT(m.run_id) FILTER (WHERE r.cycle_date = (SELECT MAX(cycle_date) FROM runs WHERE project_id = $1 AND ok))::int AS measured,
          COUNT(*) FILTER (WHERE m.mentioned AND r.cycle_date = (SELECT MAX(cycle_date) FROM runs WHERE project_id = $1 AND ok))::int AS named
   FROM prompts p
   LEFT JOIN runs r ON r.prompt_id = p.id AND r.ok
   LEFT JOIN mentions m ON m.run_id = r.id AND m.entity_id = (SELECT id FROM entities WHERE project_id = $1 AND kind = 'owned' ORDER BY id LIMIT 1)
   WHERE p.project_id = $1 AND p.active
   GROUP BY p.cluster ORDER BY p.cluster`, [id]);

console.log(`\nSearch demand vs AI visibility - ${project.name}`);
console.log(`GSC: last 90 days, ${rows.length} queries. AI: latest cycle only.\n`);
console.log('cluster'.padEnd(28) + 'GSC impr'.padStart(10) + 'clicks'.padStart(8) + '   AI named rate');
for (const c of clusters) {
  const words = c.cluster.toLowerCase().split(/[_\s-]+/).filter((w) => w.length > 2);
  const hit = rows.filter((q) => words.every((w) => q.query.toLowerCase().includes(w)));
  const impr = hit.reduce((n, q) => n + (q.impressions || 0), 0);
  const clicks = hit.reduce((n, q) => n + (q.clicks || 0), 0);
  const rate = c.measured ? `${Math.round((c.named / c.measured) * 100)}% (${c.named} of ${c.measured})` : 'not measured';
  console.log(c.cluster.padEnd(28) + String(impr).padStart(10) + String(clicks).padStart(8) + '   ' + rate);
  if (impr > 500 && c.measured && c.named / c.measured < 0.1) {
    console.log(''.padEnd(28) + `^ GAP: real search demand, near-zero AI presence`);
  }
}
console.log('\nMatching rule: every word of the cluster name appears in the GSC query.');
console.log('Queries matching no cluster are not shown; this understates demand, never invents it.');
await pool.end();
