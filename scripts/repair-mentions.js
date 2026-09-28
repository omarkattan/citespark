import 'dotenv/config';
import { pool } from '../src/db/index.js';
import { repairMentions } from '../src/lib/repair-mentions.js';

// node scripts/repair-mentions.js 27          preview, no writes or API spend
// node scripts/repair-mentions.js 27 --apply  correct retained stored evidence
// --all can replace the id to review/correct every project with the same rule.
const args = process.argv.slice(2);
const all = args.includes('--all');
const apply = args.includes('--apply');
const ids = args.filter(a => /^\d+$/.test(a));
if (args.some(a => !['--all', '--apply'].includes(a) && !/^\d+$/.test(a)) ||
    ids.length > 1 || (all && ids.length) || (!all && (!ids.length || Number(ids[0]) < 1))) {
  console.error('Usage: node scripts/repair-mentions.js <project-id|--all> [--apply]');
  await pool.end(); process.exit(1);
}
const db = await pool.connect();
try {
  const targets = all ? (await db.query('SELECT id FROM projects ORDER BY id')).rows : [{ id: Number(ids[0]) }];
  console.log(apply ? 'Applying stored-answer corrections. No engine calls.' : 'Preview only. Nothing will be written.');
  for (const { id } of targets) {
    const s = await repairMentions(db, id, { apply });
    console.log(`${s.name} (${id}): ${s.ownedBefore} -> ${s.ownedAfter} brand namings / ${s.ownedMeasured} measured answers. ` +
      `${s.changed} rows ${apply ? 'updated' : 'would change'}, ${s.removed} matches removed across all tracked entities.`);
    if (apply) console.log(`Rebuild the current action list next: npm run rebuild -- ${id}`);
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { db.release(); await pool.end(); }
