import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/index.js';
import { applySchema } from '../src/db/migrate.js';
import { schemaUpgrades } from '../src/db/upgrades.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

try {
  await applySchema(pool,sql,{upgrades:schemaUpgrades});

  // An optional one-time operator grant for a verified, single-user account.
  // The database stores the grant so web and scheduled workers read the same setting.
  const grantEmail = process.env.CITED_GRANT_UNMETERED_EMAIL?.trim().toLowerCase();
  if (grantEmail) {
    const { rows } = await pool.query(
      `UPDATE users u SET unmetered_usage = true
       FROM orgs o WHERE u.id = (SELECT id FROM users WHERE lower(email) = $1)
         AND o.id = u.org_id AND NOT o.internal
         AND u.email_verified_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM users other WHERE other.org_id = u.org_id AND other.id <> u.id)
       RETURNING u.id, u.org_id`, [grantEmail]
    );
    if (rows.length !== 1) throw new Error('Usage grant requires a verified, single-user account without admin access.');
    const { budgetForCycle } = await import('../src/lib/billing.js');
    const preview = await budgetForCycle(rows[0].org_id, {questions: 1, engines: ['chatgpt'], runs: 1});
    const access = preview.entitlements;
    if (!preview.ok || access.internal || !access.advanced || access.usage.limit !== null ||
        access.usage.budget !== null || access.cycleSpendCap !== null) {
      throw new Error('Usage-only entitlement verification failed.');
    }
    console.log('Verified usage-only grant for user %s: scans enabled, no check or spend cap, admin off.', rows[0].id);
  }
} finally {
  await pool.end();
}
