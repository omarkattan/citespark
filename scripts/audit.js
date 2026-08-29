import 'dotenv/config';
import { pool, many, one } from '../src/db/index.js';

/**
 * Do this project's numbers survive being checked?
 *
 *   npm run audit -- 7
 *   npm run audit -- 7 --show 10      more example snippets
 *
 * Free. Reads stored answers only, spends nothing and writes nothing.
 *
 * Two things this looks for, both found by accident while testing something
 * else, and both capable of moving a headline figure:
 *
 *   1. An engine that returns no citations at all. Not an error, so nothing
 *      reports it, but every source and every action derived from that engine
 *      is silently missing.
 *
 *   2. A brand name that is also an ordinary phrase. Detection is a
 *      case-insensitive word match, so a firm called The Family Office is
 *      credited whenever an answer says "the family office model". Nothing
 *      distinguishes the firm from the noun.
 *
 * Every count printed here comes with the rows behind it, so any line can be
 * disputed rather than taken on trust.
 */

const args = process.argv.slice(2);
const id = Number(args.find((a) => /^\d+$/.test(a)));
const SHOW = (() => {
  const i = args.indexOf('--show');
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : 5;
})();

if (!id) {
  const rows = await many('SELECT id, name FROM projects ORDER BY id');
  console.log('Give a project id:\n' + rows.map((r) => `  ${r.id}  ${r.name}`).join('\n'));
  await pool.end();
  process.exit(0);
}

const project = await one('SELECT * FROM projects WHERE id = $1', [id]);
if (!project) { console.error(`No project ${id}.`); await pool.end(); process.exit(1); }

const owned = await one(
  "SELECT id, name, domain, aliases FROM entities WHERE project_id = $1 AND kind = 'owned' ORDER BY id LIMIT 1",
  [id]
);

console.log(`\n${project.name}  (project ${id})`);
console.log(`Brand: ${owned?.name}${owned?.aliases?.length ? `, also ${owned.aliases.join(', ')}` : ''}\n`);

/* ---------------- 1. which engines actually cite anything ---------------- */

console.log('Citations by engine, all cycles');
console.log('An engine at 0% is not failing. It is answering without sources, which');
console.log('is invisible in every report because the answers themselves look fine.\n');

const byEngine = await many(
  `SELECT r.engine,
          COUNT(*)::int                                                   AS runs,
          COUNT(*) FILTER (WHERE c.run_id IS NOT NULL)::int               AS with_citations,
          COUNT(DISTINCT r.model)                                         AS models,
          MAX(r.model)                                                    AS example_model
   FROM runs r
   LEFT JOIN (SELECT DISTINCT run_id FROM citations) c ON c.run_id = r.id
   WHERE r.project_id = $1 AND r.ok
   GROUP BY r.engine ORDER BY r.engine`,
  [id]
);

for (const e of byEngine) {
  const pct = e.runs ? Math.round((e.with_citations / e.runs) * 100) : 0;
  const flag = pct === 0 ? '   <-- no sources at all' : pct < 25 ? '   <-- sparse' : '';
  console.log(
    `  ${e.engine.padEnd(12)} ${String(pct).padStart(3)}%  ` +
    `(${e.with_citations}/${e.runs} answers)  model: ${e.example_model || 'not recorded'}${flag}`
  );
}

const silent = byEngine.filter((e) => e.with_citations === 0 && e.runs > 0);
if (silent.length) {
  console.log(`\n  ${silent.map((s) => s.engine).join(', ')} contributed nothing to the sources table`);
  console.log('  or to any action built from it. If the model shown above is a small or');
  console.log('  "mini" variant, check scoreModel in src/lib/dataforseo.js: it adds points');
  console.log('  for those names, and a model can report web search support while citing');
  console.log('  nothing in practice.');
}

/* ---------------- 2. is the brand name also an ordinary phrase? ---------------- */

/**
 * The live matcher is case-insensitive, so the only signal available after
 * the fact is how the phrase was actually written in the answer. A firm is
 * named in title case. The noun is not.
 *
 * This does not re-run detection or change any stored value. It reads the
 * answers back and reports what the match was sitting on.
 */
console.log('\n\nHow the brand was written where it was counted as named');

if (!owned) {
  console.log('  No owned entity, nothing to check.');
} else {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = [owned.name, ...(owned.aliases || [])].filter(Boolean);
  const distinctive = [owned.domain, ...(owned.aliases || [])].filter(Boolean);

  const hits = await many(
    `SELECT r.id, r.engine, r.response_text, p.text AS question, p.intent
     FROM mentions m
     JOIN runs r ON r.id = m.run_id
     JOIN prompts p ON p.id = r.prompt_id
     WHERE m.entity_id = $1 AND m.mentioned AND r.ok AND r.response_text IS NOT NULL`,
    [owned.id]
  );

  let titled = 0;
  let lower = 0;
  const examples = [];

  for (const h of hits) {
    let matched = null;
    for (const n of names) {
      const re = new RegExp(`(^|[^a-z0-9])(${escape(n)})([^a-z0-9]|$)`, 'i');
      const m = re.exec(h.response_text);
      if (m) { matched = m[2]; break; }
    }
    if (!matched) continue;

    // Title case on every word of length 3 or more is how a firm is written.
    const looksLikeAName = matched
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .every((w) => /^[A-Z]/.test(w));

    // A nearby domain or distinctive alias settles it either way.
    const corroborated = distinctive.some((d) => d && h.response_text.toLowerCase().includes(d.toLowerCase()));

    if (looksLikeAName || corroborated) titled++;
    else {
      lower++;
      if (examples.length < SHOW) {
        const at = h.response_text.toLowerCase().indexOf(matched.toLowerCase());
        examples.push({
          engine: h.engine,
          intent: h.intent,
          question: h.question,
          snippet: h.response_text.slice(Math.max(0, at - 90), at + 110).replace(/\s+/g, ' ').trim()
        });
      }
    }
  }

  const total = titled + lower;
  if (!total) {
    console.log('  No stored answers to read back.');
  } else {
    const pct = Math.round((lower / total) * 100);
    console.log(`\n  Written as a name, or backed by the domain: ${titled} of ${total}`);
    console.log(`  Written in lower case with nothing to confirm it: ${lower} of ${total}  (${pct}%)`);

    if (lower) {
      console.log(`\n  Those ${lower} are the ones to look at. Read the snippets and decide:`);
      for (const e of examples) {
        console.log(`\n    ${e.engine} / ${e.intent}  "${e.question.slice(0, 66)}${e.question.length > 66 ? '...' : ''}"`);
        console.log(`      ...${e.snippet}...`);
      }
      console.log(`\n  If those read as the industry term rather than the firm, the headline`);
      console.log(`  count is high by up to ${pct}% and should be corrected before it is`);
      console.log('  published again. Nothing has been changed by running this.');
    } else {
      console.log('\n  Every counted mention was written as a name. Nothing to correct.');
    }
  }

  /**
   * Informational questions are where a generic name does most damage,
   * because the answer discusses the concept at length without naming a
   * single firm.
   */
  const byIntent = await many(
    `SELECT p.intent,
            COUNT(*)::int                                     AS runs,
            COUNT(*) FILTER (WHERE m.mentioned)::int          AS named
     FROM runs r
     JOIN prompts p ON p.id = r.prompt_id
     LEFT JOIN mentions m ON m.run_id = r.id AND m.entity_id = $1
     WHERE r.project_id = $2 AND r.ok
     GROUP BY p.intent ORDER BY named DESC`,
    [owned.id, id]
  );

  console.log('\n\nNamed rate by question intent');
  console.log('A rate on informational questions at or above the commercial ones is');
  console.log('the signature of a name being matched as a phrase.\n');
  for (const b of byIntent) {
    const pct = b.runs ? Math.round((b.named / b.runs) * 100) : 0;
    console.log(`  ${String(b.intent).padEnd(16)} ${String(pct).padStart(3)}%  (${b.named}/${b.runs})`);
  }
}

console.log('\nRead only. Nothing was written, and no engine was called.\n');
await pool.end();
