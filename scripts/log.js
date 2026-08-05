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
await pool.end();
