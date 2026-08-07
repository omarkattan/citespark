import 'dotenv/config';
import { pool } from '../src/db/index.js';
import { refreshMena, MENA_SECTORS } from '../src/lib/mena.js';
import { marketSupported } from '../src/lib/mentions.js';

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
// Only supported markets are called, so only those cost anything. Counting
// the rest overstated the estimate by about a third.
const chosen = MENA_SECTORS.filter((s) => list.includes(s.slug));
const pairs = chosen.reduce((n, s) => n + new Set(s.members.map((m) => m.country).filter(marketSupported)).size, 0);
const skipped = chosen.reduce((n, s) => n + new Set(s.members.map((m) => m.country).filter((c) => !marketSupported(c))).size, 0);

console.log(
  `Refreshing ${list.length} sector(s) across ${pairs} sector-market pairs, about $${(pairs * 0.4).toFixed(2)}` +
    (skipped ? `\n${skipped} sector-market pairs skipped: those markets are not in the dataset.` : '') +
    '\n'
);

const result = await refreshMena({ only: only.length ? only : null });
const failed = result.sectors.filter((s) => s.error).length;
console.log(`\nDone. $${result.spend.toFixed(4)} spent${failed ? `, ${failed} sector(s) failed` : ''}.`);
await pool.end();
