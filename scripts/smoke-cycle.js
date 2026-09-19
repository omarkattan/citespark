/**
 * scripts/smoke-cycle.js
 *
 * Smoke test: call runCycleForProject end-to-end against a throwaway Postgres
 * database, with MOCK_MODE so no real API money is spent.
 *
 * WHY THIS EXISTS
 * ---------------
 * The existing test suite covers pure functions and static analysis of source
 * files. Nothing runs runCycleForProject itself. That gap let a ReferenceError
 * (projectModels declared after first use) kill every cycle for three days
 * while 276 tests stayed green. This script closes that gap.
 *
 * HOW TO RUN
 * ----------
 *   SMOKE_DATABASE_URL=postgres://... node scripts/smoke-cycle.js --run
 *
 * Without --run the script prints its plan and exits 0 (safe to call in CI
 * without a throwaway DB configured).
 *
 * SMOKE_DATABASE_URL must be a separate, empty Postgres instance. This script
 * will CREATE TABLE ... DROP SCHEMA on it. It refuses to touch DATABASE_URL.
 *
 * On Render: provision a throwaway Postgres, set SMOKE_DATABASE_URL, and run
 * via the shell on srv-d9nin8m after a deploy to verify the new code.
 *
 * WHAT IT CHECKS
 * --------------
 * 1. runCycleForProject returns without throwing (the ReferenceError check).
 * 2. Return value has the expected shape: runs, spend, cycle, recommendations.
 * 3. spend is 0 (MOCK_MODE guarantee - a non-zero spend means a real call leaked).
 * 4. DB has run rows for the prompts (writes reached the DB).
 * 5. DB has mention rows (analyseRun ran and persisted results).
 * 6. DB has citation rows (citation path ran).
 * 7. A second call with only='unrun' returns nothingToDo (all prompts now have answers).
 * 8. A method_notes row is written when the question set grows by >=10%.
 *
 * SAFETY RULES
 * ------------
 * - Read-only / dry-run unless --run is passed.
 * - Prints every state change before making it.
 * - Uses a dedicated schema (smoke_<timestamp>) so concurrent runs do not clash.
 * - Always drops the schema in a finally block, even on assertion failure.
 * - Never imports DATABASE_URL; wires its own pool directly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

// ---- guard: dry run unless explicitly asked --------------------------------

const DRY = !process.argv.includes('--run');

if (DRY) {
  console.log('\nsmoke-cycle: DRY RUN (pass --run to execute)');
  console.log('');
  console.log('  Will do:');
  console.log('  1. Connect to SMOKE_DATABASE_URL (not DATABASE_URL)');
  console.log('  2. Create an isolated schema, apply schema.sql');
  console.log('  3. Seed: 1 org, 1 project (chatgpt engine), 1 entity, 2 prompts');
  console.log('  4. Run runCycleForProject with MOCK_MODE=true (no spend)');
  console.log('  5. Assert return shape, DB rows, zero spend');
  console.log('  6. Run again with only="unrun" - expect nothingToDo');
  console.log('  7. Seed a third prompt, run again - expect method_notes row for question growth');
  console.log('  8. Drop the schema (teardown)');
  console.log('');
  console.log('  Set SMOKE_DATABASE_URL to a separate empty Postgres instance,');
  console.log('  then pass --run to execute for real.');
  process.exit(0);
}

// ---- env check -------------------------------------------------------------

const SMOKE_URL = process.env.SMOKE_DATABASE_URL;
if (!SMOKE_URL) {
  console.error('\nFatal: SMOKE_DATABASE_URL is not set.');
  console.error('Point it at a separate, empty Postgres instance (not DATABASE_URL).\n');
  process.exit(1);
}

// Refuse loudly if both URLs are the same string. The test would still use
// the smoke schema, but production data in the same DB is too close a risk.
if (SMOKE_URL === process.env.DATABASE_URL) {
  console.error('\nFatal: SMOKE_DATABASE_URL and DATABASE_URL are identical.');
  console.error('Use a separate Postgres instance for the smoke test.\n');
  process.exit(1);
}

// ---- setup -----------------------------------------------------------------

process.env.MOCK_MODE = 'true';

// The smoke pool is wired directly so runCycle's import of src/db/index.js
// uses DATABASE_URL, while our seed/assert queries use this separate pool.
// They both point at SMOKE_DATABASE_URL for the duration of the test.
process.env.DATABASE_URL = SMOKE_URL;

const needsSsl = /render\.com|amazonaws|supabase|neon\.tech/.test(SMOKE_URL);
const smokePool = new Pool({
  connectionString: SMOKE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 3
});

const SCHEMA = `smoke_${Date.now()}`;

async function q(text, params) {
  const r = await smokePool.query(text, params);
  return r.rows;
}
async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

// ---- helpers ---------------------------------------------------------------

let pass = 0;
let fail = 0;

function ok(label) {
  console.log(`  ok  ${label}`);
  pass++;
}

function check(label, fn) {
  try {
    fn();
    ok(label);
  } catch (err) {
    console.error(`  FAIL ${label}`);
    console.error(`       ${err.message}`);
    fail++;
  }
}

// ---- main ------------------------------------------------------------------

console.log(`\nsmoke-cycle: running against ${SMOKE_URL.replace(/:\/\/[^@]+@/, '://<creds>@')}`);
console.log(`  schema: ${SCHEMA}`);

try {
  // 1. Create isolated schema and apply schema.sql inside it.
  console.log('\n[setup] creating schema and tables');
  await q(`CREATE SCHEMA ${SCHEMA}`);
  await q(`SET search_path TO ${SCHEMA}`);
  // Make every subsequent connection (including runCycle's own pool) default
  // to this schema. We restore public at teardown.
  const dbUser = new URL(SMOKE_URL).username;
  await q(`ALTER ROLE "${dbUser}" SET search_path TO ${SCHEMA}`);

  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf8');
  await q(schemaSql);
  console.log('  schema applied');

  // 2. Seed minimum data.
  // Org must be internal=true so billing.js skips the plan/verification gates.
  console.log('\n[seed] inserting org, project, entity, prompts');
  const [org] = await q(`INSERT INTO orgs (name, internal) VALUES ('Smoke Test Org', true) RETURNING id`);
  const orgId = org.id;

  const [proj] = await q(
    `INSERT INTO projects
       (org_id, name, domain, brand_name, engines, runs_per_cycle, market, location_name)
     VALUES ($1, 'Smoke Site', 'sandstormdigital.com', 'Sandstorm Digital',
             ARRAY['chatgpt'], 1, 'AE', 'Dubai,Dubai,United Arab Emirates')
     RETURNING id`,
    [orgId]
  );
  const projectId = proj.id;

  // Entity name must match a MOCK_BRANDS entry so mentions are guaranteed.
  await q(
    `INSERT INTO entities (project_id, name, domain, kind, aliases, ambiguous_name)
     VALUES ($1, 'Sandstorm Digital', 'sandstormdigital.com', 'owned', '{}', false)`,
    [projectId]
  );

  const [p1] = await q(
    `INSERT INTO prompts (project_id, text, cluster, intent, active)
     VALUES ($1, 'Which SEO agency should I use in Dubai?', 'general', 'commercial', true)
     RETURNING id`,
    [projectId]
  );
  const [p2] = await q(
    `INSERT INTO prompts (project_id, text, cluster, intent, active)
     VALUES ($1, 'Best digital marketing agency for ecommerce in UAE?', 'general', 'commercial', true)
     RETURNING id`,
    [projectId]
  );

  console.log(`  org=${orgId} project=${projectId} prompts=${p1.id},${p2.id}`);

  // 3. Run the cycle.
  console.log('\n[run] calling runCycleForProject (MOCK_MODE, 2 prompts x 1 engine x 1 run = 2 calls)');
  const { runCycleForProject } = await import('../src/jobs/runCycle.js');

  let summary;
  try {
    summary = await runCycleForProject(projectId, {});
  } catch (err) {
    console.error('\n  FATAL: runCycleForProject threw:');
    console.error(`  ${err.message}`);
    console.error(err.stack);
    fail++;
    throw err; // propagate to finally for teardown
  }

  console.log('\n[assert] checking return value');
  check('summary is an object', () => assert.equal(typeof summary, 'object'));
  check('summary.cycle is a date string', () => assert.match(summary.cycle, /^\d{4}-\d{2}-\d{2}$/));
  check('summary.runs is a number', () => assert.equal(typeof summary.runs, 'number'));
  check('summary.spend is present', () => assert.ok('spend' in summary));
  check('summary.recommendations is a number', () => assert.equal(typeof summary.recommendations, 'number'));
  check('spend is zero (MOCK_MODE must not spend)', () => assert.equal(summary.spend, 0));
  check('runs equals prompts x engines x runs_per_cycle (2)', () => assert.equal(summary.runs, 2));
  check('not blocked (internal org bypasses billing)', () => assert.ok(!summary.blocked, `blocked: ${summary.reason}`));

  console.log('\n[assert] checking DB writes');
  const runRows = await q(`SELECT id, engine, ok FROM runs WHERE project_id = $1`, [projectId]);
  check('runs table has 2 rows', () => assert.equal(runRows.length, 2));
  check('all runs succeeded', () => assert.ok(runRows.every((r) => r.ok), 'some runs are not ok'));
  check('engine is chatgpt', () => assert.ok(runRows.every((r) => r.engine === 'chatgpt')));

  const mentionRows = await q(
    `SELECT m.mentioned FROM mentions m JOIN runs r ON r.id = m.run_id WHERE r.project_id = $1`,
    [projectId]
  );
  check('mentions table has rows (analyseRun ran)', () => assert.ok(mentionRows.length > 0, 'no mention rows'));

  const citationRows = await q(
    `SELECT id FROM citations c JOIN runs r ON r.id = c.run_id WHERE r.project_id = $1`,
    [projectId]
  );
  check('citations table has rows (citation path ran)', () => assert.ok(citationRows.length > 0, 'no citation rows'));

  // 4. Second call with only='unrun' must report nothing to do.
  console.log('\n[run] second call with only="unrun"');
  const summary2 = await runCycleForProject(projectId, { only: 'unrun' });
  check('second call is nothingToDo', () => assert.ok(summary2.nothingToDo, `got: ${JSON.stringify(summary2)}`));
  check('second call runs=0', () => assert.equal(summary2.runs, 0));

  // 5. Add a third prompt (enough to cross the 10% growth threshold) then
  //    run a full cycle and check a method_notes row is written.
  //    2 -> 3 prompts = 50% growth, well above the 10% threshold.
  console.log('\n[seed] adding a third prompt to trigger method_notes');
  await q(
    `INSERT INTO prompts (project_id, text, cluster, intent, active)
     VALUES ($1, 'Top agencies for SEO in the Gulf region?', 'general', 'commercial', true)`,
    [projectId]
  );

  const summary3 = await runCycleForProject(projectId, {
    cycleDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10) // tomorrow, so it's a new cycle
  });
  check('third run completed without throwing', () => assert.equal(typeof summary3.cycle, 'string'));

  const noteRows = await q(
    `SELECT note FROM method_notes WHERE project_id = $1 AND note LIKE '%questions%'`,
    [projectId]
  );
  check('method_notes row written for question growth', () => assert.ok(noteRows.length > 0, 'no method_notes row'));

} finally {
  // Always tear down the schema, whether tests passed or failed.
  console.log(`\n[teardown] dropping schema ${SCHEMA}`);
  try {
    const dbUser = new URL(SMOKE_URL).username;
    await smokePool.query(`ALTER ROLE "${dbUser}" RESET search_path`);
    await smokePool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    console.log('  dropped');
  } catch (err) {
    console.error(`  could not drop schema: ${err.message}`);
  }
  await smokePool.end();
}

// ---- summary ---------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
