import 'dotenv/config';
import { many, one, pool } from '../src/db/index.js';
import { notify, emailConfigured } from '../src/lib/notify.js';
import {processConversionFollowups,expireConversionContext} from '../src/lib/conversion-worker.js';

/**
 * The daily summary. npm run digest [hours]
 *
 * Prints to the console either way, and sends a notification if one is
 * configured. Designed for a morning cron: everything worth knowing about
 * yesterday, in the order you would want to act on it.
 */
const hours = Number(process.argv[2]) || 24;
const since = `${hours} hours`;

const trials = await many(
  `SELECT domain, MAX(brand_name) AS brand, MAX(source) AS source,
          MAX((result->>'rate')::float) AS rate, COUNT(*)::int AS tries
   FROM demo_runs WHERE created_at > now() - ($1)::interval
   GROUP BY domain ORDER BY MAX(created_at) DESC`,
  [since]
);

const signups = await many(
  `SELECT u.email, o.name AS org FROM users u JOIN orgs o ON o.id = u.org_id
   WHERE u.created_at > now() - ($1)::interval ORDER BY u.created_at DESC`,
  [since]
);

const feedback = await many(
  `SELECT kind, message, user_email FROM feedback
   WHERE created_at > now() - ($1)::interval ORDER BY created_at DESC`,
  [since]
);

const cycles = await one(
  `SELECT COUNT(DISTINCT project_id)::int AS sites, COUNT(*)::int AS calls,
          COALESCE(SUM(cost_usd),0)::float AS spend
   FROM runs WHERE created_at > now() - ($1)::interval`,
  [since]
);

const paid = await many(
  `SELECT o.name AS org, p.billing_reason AS plan, p.currency, p.amount_paid FROM conversion_payments p JOIN orgs o ON o.id=p.org_id
   WHERE p.livemode AND NOT o.internal AND NOT o.conversion_test AND p.created_at > now() - ($1)::interval`,
  [since]
);

const hot = trials.filter((t) => t.rate === 0);
const quiet = !trials.length && !signups.length && !feedback.length && !paid.length;

/* ---------------- console ---------------- */

console.log(`\nCited, last ${hours} hours\n`);

if (quiet) {
  console.log('  Nothing happened. No trials, signups or feedback.');
} else {
  if (trials.length) {
    console.log(`  ${trials.length} domain(s) tried the demo`);
    console.log('  Demo samples only, not overall visibility or identified contacts.');
  }
  if (signups.length) {
    console.log(`\n  ${signups.length} new account(s)`);

  }
  if (paid.length) {
    console.log(`\n  ${paid.length} confirmed subscription payment(s)`);
  }
  if (feedback.length) {
    console.log(`\n  ${feedback.length} piece(s) of feedback`);

  }
}

console.log(`\n  Measurement: ${cycles.calls} calls across ${cycles.sites} site(s), $${cycles.spend.toFixed(2)}\n`);

/* ---------------- notification ---------------- */

if (!quiet) {
  notify({
    kind: 'digest',
    title: `${trials.length} trials, ${signups.length} signups, ${feedback.length} feedback`,
    subject: `Cited daily: ${trials.length} trials${hot.length ? `, ${hot.length} not named in sample` : ''}`,
    lead: hot.length
      ? `${hot.length} ${hot.length === 1 ? 'domain' : 'domains'} were not named in their limited demo samples: ${hot.map((h) => h.domain).join(', ')}`
      : null,
    rows: [
      trials.length
        ? ['Domains tried', trials.slice(0, 8).map((t) => `${t.domain} (${t.rate === null ? '?' : Math.round(t.rate * 100) + '%'})`).join(', ')]
        : null,
      signups.length ? ['New accounts', signups.map((s) => s.email).join(', ')] : null,
      paid.length ? ['Confirmed payments', paid.map((p) => `${p.org}: ${p.plan}`).join(', ')] : null,
      feedback.length ? ['Feedback', feedback.map((f) => `[${f.kind}] ${f.message.slice(0, 70)}`).join(' / ')] : null,
      ['Measurement', `${cycles.calls} calls, $${cycles.spend.toFixed(2)}`]
    ].filter(Boolean)
  });
  // Give the fire-and-forget send a moment to land before the process exits.
  await new Promise((r) => setTimeout(r, 2500));
}

// Reuse the existing daily job. Preview is the default and sends nothing to prospects.
try {
  await expireConversionContext(pool);
  console.log('Conversion follow-ups:',JSON.stringify(await processConversionFollowups({db:pool,send:process.env.CONVERSION_EMAIL_MODE==='live'})));
} catch { console.error('Conversion follow-up job unavailable; no automatic retry of deliveries'); }
await pool.end();
