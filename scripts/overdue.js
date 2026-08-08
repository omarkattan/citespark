import 'dotenv/config';
import { pool, many, query } from '../src/db/index.js';
import { notifyOverdue, looksLikeEmail, canEmailOthers } from '../src/lib/notify.js';

/**
 * Chase overdue tasks. npm run overdue
 *
 * A due date that passes silently is the usual failure of task tools, so this
 * emails the assignee once when a task goes past its date. Once, not daily:
 * a nag every morning gets filtered and then everything else does too.
 */
const site = process.env.CANONICAL_HOST ? `https://${process.env.CANONICAL_HOST}` : 'https://cited.ae';

const rows = await many(
  `SELECT r.*, p.name AS project_name, p.domain AS project_domain, p.id AS pid,
          (CURRENT_DATE - r.due_date)::int AS days
   FROM recommendations r
   JOIN projects p ON p.id = r.project_id
   WHERE r.status IN ('open','doing')
     AND r.due_date IS NOT NULL
     AND r.due_date < CURRENT_DATE
     AND r.assignee IS NOT NULL
     AND r.overdue_notified_at IS NULL
   ORDER BY r.due_date`
);

if (!rows.length) {
  console.log('Nothing overdue that has not already been chased.');
} else {
  console.log(`${rows.length} overdue task(s)\n`);
  let sent = 0;
  let skipped = 0;

  for (const r of rows) {
    const can = looksLikeEmail(r.assignee) && canEmailOthers;
    console.log(
      `  ${String(r.days).padStart(3)}d  ${String(r.assignee).padEnd(32)} ${r.title.slice(0, 52)}` +
        (can ? '' : looksLikeEmail(r.assignee) ? '   [no email configured]' : '   [assignee is not an address]')
    );

    if (!can) {
      skipped++;
      continue;
    }
    notifyOverdue({
      to: r.assignee,
      site: r.project_name || r.project_domain,
      task: r,
      days: r.days,
      appUrl: `${site}/app?site=${r.pid}`
    });
    // Marked whether or not the send succeeds: the failure is recorded in the
    // notification log, and chasing the same task every morning is worse.
    await query('UPDATE recommendations SET overdue_notified_at = now() WHERE id = $1', [r.id]);
    sent++;
  }

  console.log(`\n${sent} chased${skipped ? `, ${skipped} could not be emailed` : ''}.`);
  if (sent) await new Promise((r) => setTimeout(r, 2500));
}
await pool.end();
