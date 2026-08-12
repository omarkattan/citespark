import 'dotenv/config';
import { many, pool } from '../src/db/index.js';

/**
 * Read the notification log. npm run log [kind] [limit]
 *
 *   npm run log
 *   npm run log trial
 *   npm run log feedback 100
 *
 * Everything is here whether or not the email went out, so this is the record
 * rather than a copy of your inbox.
 */
const args = process.argv.slice(2);
const kind = args.find((a) => Number.isNaN(Number(a)));
const limit = Number(args.find((a) => !Number.isNaN(Number(a)))) || 50;

/**
 * Security events live in their own table because they arrive unauthenticated
 * and are kept whether or not they verify. Nobody reading a log should have to
 * know that, so they are shown here too.
 */
const security = await many(
  `SELECT id, verified, event_types, actions, error, created_at
   FROM security_events ORDER BY created_at DESC LIMIT $1`,
  [Math.min(limit, 20)]
).catch(() => []);

const rows = await many(
  `SELECT id, kind, title, detail, emailed, email_error, created_at
   FROM notifications ${kind ? 'WHERE kind = $1' : ''}
   ORDER BY created_at DESC LIMIT ${kind ? '$2' : '$1'}`,
  kind ? [kind, limit] : [limit]
);

if (!rows.length) {
  console.log(kind ? `Nothing logged of kind "${kind}".` : 'Nothing logged yet.');
} else {
  console.log(`\n${rows.length} event(s)${kind ? ` of kind "${kind}"` : ''}\n`);
  for (const r of rows) {
    const when = new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
    const mail = r.emailed ? '' : r.email_error ? `  [email failed: ${r.email_error.slice(0, 60)}]` : '  [not emailed]';
    console.log(`#${String(r.id).padEnd(5)} ${when}  [${r.kind}]  ${r.title}${mail}`);
    if (r.detail?.lead) console.log(`       ${r.detail.lead.slice(0, 140)}`);
    for (const [k, v] of r.detail?.rows || []) console.log(`       ${String(k).padEnd(14)} ${v}`);
  }

  const failed = rows.filter((r) => r.email_error).length;
  if (failed) console.log(`\n${failed} email(s) failed to send. The events themselves are safe here.`);
}

if (security.length) {
  console.log(`\nGoogle security events (${security.length})\n`);
  for (const s of security) {
    const when = new Date(s.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
    const types = (s.event_types || []).map((t) => t.split('/').pop()).join(', ') || 'unreadable';
    console.log(`  ${when}  ${s.verified ? 'verified' : 'REJECTED'}  ${types}`);
    for (const a of s.actions || []) console.log(`     ${a.action}${a.email ? ` (${a.email})` : ''}`);
    if (s.error) console.log(`     ${s.error.slice(0, 90)}`);
  }
  const rejected = security.filter((s) => !s.verified).length;
  if (rejected) {
    console.log(`\n  ${rejected} were rejected. Unsigned posts to a public endpoint are expected;`);
    console.log('  a lot of them at once is worth looking at.');
  }
} else {
  console.log('\nNo Google security events yet. If Cross-Account Protection was just registered,');
  console.log('the verification event usually arrives within a minute.');
}
await pool.end();
