import 'dotenv/config';
import { many, one, pool } from '../src/db/index.js';
import { fetchQueries } from '../src/lib/gsc.js';
import { demandByCluster, DEMAND_METHOD, DEMAND_WINDOW_DAYS } from '../src/lib/demand.js';

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

const table = await demandByCluster(id, rows);

console.log(`\nSearch demand vs AI visibility - ${project.name}\n`);
console.log('cluster'.padEnd(30) + 'impr'.padStart(9) + 'clicks'.padStart(8) + '   named in AI answers');
for (const r of table) {
  const rate = r.rate === null ? 'not measured' : `${Math.round(r.rate * 100)}% (${r.named} of ${r.measured})`;
  const impr = r.measurable ? String(r.impressions).padStart(9) : '        -';
  const clk = r.measurable ? String(r.clicks).padStart(8) : '       -';
  console.log((r.gap ? '* ' : '  ') + r.cluster.padEnd(28) + impr + clk + '   ' + rate);
}
console.log(`\n* = real demand, almost no AI presence. ${DEMAND_METHOD}`);
await pool.end();
