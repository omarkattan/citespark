import { runCycleForProject } from '../src/jobs/runCycle.js';
import { pool } from '../src/db/index.js';

const [project, source, ...flags] = process.argv.slice(2);
if (!/^\d+$/.test(project || '') || !/^\d+$/.test(source || '') || flags.some(f => f !== '--apply')) {
  console.error('Usage: node scripts/recover-measurement.js <project-id> <failed-measurement-id> [--apply]');
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await runCycleForProject(Number(project), {
      recoverFrom: Number(source), previewRecovery: !flags.includes('--apply'),
      onProgress: p => { if (p.phase === 'done') console.log(JSON.stringify(p.summary)); }
    }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
await pool.end();
