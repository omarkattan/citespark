import 'dotenv/config';
import { many, pool } from '../src/db/index.js';

/** Read what people have told you. npm run feedback [new|all] */
const filter = process.argv[2] === 'all' ? '' : "WHERE status = 'new'";
const rows = await many(
  `SELECT f.id, f.kind, f.message, f.user_email, f.context, f.created_at, o.name AS org
   FROM feedback f LEFT JOIN orgs o ON o.id = f.org_id
   ${filter} ORDER BY f.created_at DESC LIMIT 100`
);

if (!rows.length) {
  console.log('Nothing new.');
} else {
  for (const r of rows) {
    const when = new Date(r.created_at).toLocaleString();
    console.log(`\n#${r.id}  [${r.kind}]  ${when}`);
    console.log(`  from: ${r.user_email || 'anonymous'}${r.org ? ` (${r.org})` : ''}`);
    if (r.context?.view) console.log(`  on:   ${r.context.view}${r.context.projectId ? `, project ${r.context.projectId}` : ''}`);
    console.log(`  ${r.message.replace(/\n/g, '\n  ')}`);
  }
  console.log(`\n${rows.length} item(s). Mark one read:`);
  console.log(`  psql $DATABASE_URL -c "UPDATE feedback SET status='read' WHERE id=1;"`);
}
await pool.end();
