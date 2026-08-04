import 'dotenv/config';
import { pool } from '../src/db/index.js';
import { refreshAll, SECTORS } from '../src/lib/sectors.js';

/**
 * Refresh the public visibility index.
 *
 *   npm run index            every sector
 *   npm run index -- banking telecoms
 *
 * Cheap enough to run weekly: a full pass is a few cents.
 */
const only = process.argv.slice(2).filter(Boolean);
if (only.length) {
  const unknown = only.filter((s) => !SECTORS.some((x) => x.slug === s));
  if (unknown.length) {
    console.error(`Unknown sector(s): ${unknown.join(', ')}`);
    console.error(`Available: ${SECTORS.map((s) => s.slug).join(', ')}`);
    process.exit(1);
  }
}

console.log(`Refreshing ${only.length || SECTORS.length} sector(s)`);
const result = await refreshAll({ only: only.length ? only : null });
const failed = result.sectors.filter((s) => s.error).length;
console.log(`\nDone. $${result.spend.toFixed(4)} spent${failed ? `, ${failed} sector(s) failed` : ''}.`);
await pool.end();
