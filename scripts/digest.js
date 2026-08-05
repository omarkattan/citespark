import 'dotenv/config';
import { many, one, pool } from '../src/db/index.js';
import { notify, emailConfigured } from '../src/lib/notify.js';

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
  `SELECT o.name AS org, s.plan, s.interval FROM subscriptions s JOIN orgs o ON o.id = s.org_id
   WHERE s.plan <> 'free' AND s.updated_at > now() - ($1)::interval`,
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
    for (const t of trials) {
      const vis = t.rate === null ? '   -' : `${Math.round(t.rate * 100)}%`.padStart(4);
      console.log(`    ${vis}  ${t.domain.padEnd(32)} from ${t.source || 'unknown'}`);
    }
    if (hot.length) console.log(`\n  ${hot.length} scored zero. Worth a call: ${hot.map((h) => h.domain).join(', ')}`);
  }
  if (signups.length) {
    console.log(`\n  ${signups.length} new account(s)`);
    for (const s of signups) console.log(`    ${s.email}${s.org ? ` (${s.org})` : ''}`);
  }
  if (paid.length) {
    console.log(`\n  ${paid.length} subscription change(s)`);
    for (const p of paid) console.log(`    ${p.org}: ${p.plan}, ${p.interval}ly`);
  }
  if (feedback.length) {
    console.log(`\n  ${feedback.length} piece(s) of feedback`);
    for (const f of feedback) console.log(`    [${f.kind}] ${f.message.slice(0, 90)}`);
  }
}

console.log(`\n  Measurement: ${cycles.calls} calls across ${cycles.sites} site(s), $${cycles.spend.toFixed(2)}\n`);

/* ---------------- notification ---------------- */

if (!quiet) {
  notify({
    kind: 'digest',
    title: `${trials.length} trials, ${signups.length} signups, ${feedback.length} feedback`,
    subject: `Cited daily: ${trials.length} trials${hot.length ? `, ${hot.length} invisible` : ''}`,
    lead: hot.length
      ? `${hot.length} ${hot.length === 1 ? 'domain' : 'domains'} scored zero visibility: ${hot.map((h) => h.domain).join(', ')}`
      : null,
    rows: [
      trials.length
        ? ['Domains tried', trials.slice(0, 8).map((t) => `${t.domain} (${t.rate === null ? '?' : Math.round(t.rate * 100) + '%'})`).join(', ')]
        : null,
      signups.length ? ['New accounts', signups.map((s) => s.email).join(', ')] : null,
      paid.length ? ['Subscriptions', paid.map((p) => `${p.org}: ${p.plan}`).join(', ')] : null,
      feedback.length ? ['Feedback', feedback.map((f) => `[${f.kind}] ${f.message.slice(0, 70)}`).join(' / ')] : null,
      ['Measurement', `${cycles.calls} calls, $${cycles.spend.toFixed(2)}`]
    ].filter(Boolean)
  });
  // Give the fire-and-forget send a moment to land before the process exits.
  await new Promise((r) => setTimeout(r, 2500));
}

await pool.end();
