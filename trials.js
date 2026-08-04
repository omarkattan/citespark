import 'dotenv/config';
import { many, pool } from '../src/db/index.js';

/**
 * Who has tried the public demo. npm run trials [days]
 *
 * Every domain someone checks is a warm lead: they cared enough to type it in
 * and wait for an answer. Worth reading weekly.
 */
const days = Number(process.argv[2]) || 30;

const rows = await many(
  `SELECT domain,
          COALESCE(MAX(brand_name), '') AS brand,
          COUNT(*)::int AS attempts,
          COUNT(DISTINCT ip_hash)::int AS people,
          MAX(source) AS source,
          MAX(created_at) AS last_seen,
          MAX((result->>'rate')::float) AS best_rate
   FROM demo_runs
   WHERE created_at > now() - ($1 || ' days')::interval
   GROUP BY domain
   ORDER BY MAX(created_at) DESC`,
  [String(days)]
);

if (!rows.length) {
  console.log(`No demo runs in the last ${days} days.`);
} else {
  console.log(`${rows.length} domain(s) tried in the last ${days} days\n`);
  console.log('domain                              visibility  tries  from      last seen');
  for (const r of rows) {
    const vis = r.best_rate === null ? '   -' : `${Math.round(r.best_rate * 100)}%`.padStart(4);
    console.log(
      `  ${r.domain.slice(0, 34).padEnd(34)} ${vis.padStart(9)}  ${String(r.attempts).padStart(5)}  ` +
        `${String(r.source || '-').padEnd(8)}  ${new Date(r.last_seen).toLocaleDateString()}`
    );
  }

  const zero = rows.filter((r) => r.best_rate === 0);
  if (zero.length) {
    console.log(`\n${zero.length} scored zero visibility. Those are the easiest conversations to start:`);
    for (const r of zero.slice(0, 10)) console.log(`  ${r.domain}${r.brand ? ` (${r.brand})` : ''}`);
  }

  const bySource = rows.reduce((a, r) => ({ ...a, [r.source || 'unknown']: (a[r.source || 'unknown'] || 0) + 1 }), {});
  console.log(`\nby source: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
await pool.end();
