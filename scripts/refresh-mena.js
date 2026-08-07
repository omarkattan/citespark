import 'dotenv/config';
import { pool } from '../src/db/index.js';
import { refreshMena, MENA_SECTORS } from '../src/lib/mena.js';

/**
 * Refresh the MENA index.
 *
 *   npm run mena
 *   npm run mena -- banking fintech
 *
 * Each sector is measured once per country present in it, so this costs more
 * than the single-market UAE index: roughly $33 for a full pass.
 */
const only = process.argv.slice(2).filter(Boolean);
if (only.length) {
  const unknown = only.filter((s) => !MENA_SECTORS.some((x) => x.slug === s));
  if (unknown.length) {
    console.error(`Unknown sector(s): ${unknown.join(', ')}`);
    console.error(`Available: ${MENA_SECTORS.map((s) => s.slug).join(', ')}`);
    process.exit(1);
  }
}

const list = only.length ? only : MENA_SECTORS.map((s) => s.slug);
const pairs = MENA_SECTORS.filter((s) => list.includes(s.slug))
  .reduce((n, s) => n + new Set(s.members.map((m) => m.country)).size, 0);

console.log(`Refreshing ${list.length} sector(s) across ${pairs} sector-market pairs, about $${(pairs * 0.4).toFixed(2)}\n`);

const result = await refreshMena({ only: only.length ? only : null });
const failed = result.sectors.filter((s) => s.error).length;
console.log(`\nDone. $${result.spend.toFixed(4)} spent${failed ? `, ${failed} sector(s) failed` : ''}.`);
await pool.end();
