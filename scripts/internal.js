import 'dotenv/config';
import { pool, many, one, query } from '../src/db/index.js';

/**
 * Mark an account as internal, which lifts the answer-check allowance.
 *
 *   npm run internal                       list who is internal
 *   npm run internal -- you@example.com    make that account internal
 *   npm run internal -- you@example.com --off
 *
 * The allowance exists to protect margin on a sold plan. There is no margin
 * to protect on our own account, so it goes. The spend cap stays, because
 * that one protects the provider balance from a bug rather than protecting
 * revenue, and a bug does not care whose account it is running on.
 */
const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
const off = args.includes('--off');

if (!email) {
  const rows = await many(
    `SELECT o.id, o.name, o.internal, (SELECT email FROM users WHERE org_id = o.id ORDER BY id LIMIT 1) AS owner
     FROM orgs o ORDER BY o.internal DESC, o.id`
  );
  console.log('\naccounts\n');
  for (const r of rows) {
    console.log(`  ${String(r.id).padStart(3)}  ${(r.owner || '-').padEnd(34)} ${r.name}${r.internal ? '   [internal]' : ''}`);
  }
  console.log(`\nInternal spend backstop: $${process.env.INTERNAL_MONTHLY_BUDGET || 250} a month.`);
  console.log('Raise it with INTERNAL_MONTHLY_BUDGET.\n');
  await pool.end();
  process.exit(0);
}

const user = await one('SELECT id, org_id, email FROM users WHERE lower(email) = lower($1)', [email]);
if (!user) {
  console.error(`No account for ${email}`);
  await pool.end();
  process.exit(1);
}

await query('UPDATE orgs SET internal = $2 WHERE id = $1', [user.org_id, !off]);

const org = await one('SELECT name, internal FROM orgs WHERE id = $1', [user.org_id]);
console.log(`\n${user.email} (${org.name}) is ${org.internal ? 'now internal' : 'no longer internal'}.`);
if (org.internal) {
  console.log(`Answer checks are unlimited. Spend is still capped at $${process.env.INTERNAL_MONTHLY_BUDGET || 250} a month`);
  console.log('so a runaway loop cannot drain the DataForSEO balance.\n');
} else {
  console.log('The plan allowance applies again.\n');
}
await pool.end();
