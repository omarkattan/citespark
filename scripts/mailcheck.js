import 'dotenv/config';
import { pool, many, one } from '../src/db/index.js';

/**
 * Why an email did or did not go out.
 *
 *   npm run mailcheck                    configuration and recent attempts
 *   npm run mailcheck -- you@example.com send a test to that address
 *
 * Assignment emails fail quietly by design: the event is always recorded even
 * when the send fails, so the task board keeps working. That is right, but it
 * means a broken sender is invisible until someone says "they never got it".
 */
const to = process.argv.find((a) => a.includes('@'));

const key = process.env.RESEND_API_KEY;
const from = process.env.NOTIFY_FROM || 'Cited <notifications@cited.ae>';

console.log('\nconfiguration\n');
console.log(`  RESEND_API_KEY   ${key ? `set, ${key.slice(0, 6)}…` : 'MISSING — nothing can send'}`);
console.log(`  NOTIFY_FROM      ${from}`);
console.log(`  NOTIFY_EMAIL     ${process.env.NOTIFY_EMAIL || 'not set (only affects our own alerts)'}`);

const recent = await many(
  `SELECT kind, title, emailed, email_error, created_at
   FROM notifications WHERE kind IN ('assignment','overdue')
   ORDER BY created_at DESC LIMIT 10`
);

console.log(`\nrecent assignment emails (${recent.length})\n`);
if (!recent.length) {
  console.log('  none recorded. If you have assigned a task, the assignee was probably');
  console.log('  not an email address: a plain name is stored as a label and never sent to.');
}
for (const r of recent) {
  const when = new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
  console.log(`  ${when}  ${r.emailed ? 'sent' : 'FAILED'}  ${r.title.slice(0, 46)}`);
  if (r.email_error) console.log(`      ${r.email_error.slice(0, 120)}`);
}

// A name in the assignee field is the other common cause, and it is silent.
const assignees = await many(
  `SELECT assignee, COUNT(*)::int AS n FROM recommendations
   WHERE assignee IS NOT NULL AND assignee <> '' GROUP BY assignee ORDER BY n DESC LIMIT 12`
);
if (assignees.length) {
  console.log('\nwho tasks are assigned to\n');
  for (const a of assignees) {
    const mailable = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.assignee);
    console.log(`  ${String(a.n).padStart(4)}  ${a.assignee.padEnd(34)} ${mailable ? '' : '<- not an address, so never emailed'}`);
  }
}

if (to) {
  console.log(`\nsending a test to ${to}\n`);
  if (!key) {
    console.log('  cannot: RESEND_API_KEY is not set.\n');
  } else {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'Cited: test',
        html: '<p>If this arrived, sending works and the problem is elsewhere.</p>'
      })
    });
    const body = await res.text();
    console.log(res.ok ? `  sent. ${body.slice(0, 120)}` : `  FAILED ${res.status}: ${body.slice(0, 240)}`);
    if (!res.ok && /domain/i.test(body)) {
      console.log('\n  Resend will only send from a domain you have verified.');
      console.log('  Add and verify cited.ae at resend.com/domains, or set NOTIFY_FROM to');
      console.log('  onboarding@resend.dev to test without a verified domain.');
    }
    console.log('');
  }
}

await pool.end();
