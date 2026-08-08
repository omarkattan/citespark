import 'dotenv/config';
import { pool, one, many, query } from '../src/db/index.js';
import { askEngine, ENGINES } from '../src/lib/dataforseo.js';
import { extractMentions, scoreRecommendations } from '../src/lib/extract.js';

/**
 * Run a study's prompt set and store the evidence.
 *
 *   npm run study:run                    the v1 set, once, for validation
 *   npm run study:run -- --runs 3        the real measurement
 *   npm run study:run -- --all           every prompt, not just v1
 *   npm run study:run -- --dry           show what would run and what it costs
 *
 * One run first, on purpose. The extraction layer decides whether any number
 * on the published page means anything, and it has to be read by a person
 * against real answers before it is trusted three times over.
 */
const args = process.argv.slice(2);

/**
 * Flags that take a value, so the value is not mistaken for the study slug.
 * "--engines ai_overview" previously made the runner look for a study called
 * "ai_overview" and give up.
 */
const VALUED = new Set(['--runs', '--engines', '--limit']);

const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};

const consumed = new Set();
for (const [i, a] of args.entries()) if (VALUED.has(a)) consumed.add(i + 1);

const dry = args.includes('--dry');
const all = args.includes('--all');
const runs = Number(flagValue('--runs')) || 1;
const limit = Number(flagValue('--limit')) || null;
const onlyEngines = flagValue('--engines')
  ? String(flagValue('--engines')).split(',').map((e) => e.trim()).filter(Boolean)
  : null;

const slug =
  args.find((a, i) => !a.startsWith('--') && !consumed.has(i)) || 'property-developers';

const study = await one('SELECT * FROM sector_studies WHERE slug = $1', [slug]);
if (!study) {
  console.error(`No study "${slug}". Run: npm run study:load`);
  await pool.end();
  process.exit(1);
}

/**
 * The seed names engines as Google does; the client uses its own ids. Mapping
 * here rather than editing the seed keeps the seed readable as a methodology
 * document, and an unmapped name stops the run instead of failing every call.
 */
const ENGINE_ALIASES = {
  google_ai_mode: 'ai_mode',
  google_ai_overview: 'ai_overview',
  google_ai_overviews: 'ai_overview',
  chatgpt: 'chatgpt',
  chat_gpt: 'chatgpt',
  gemini: 'gemini',
  claude: 'claude',
  perplexity: 'perplexity'
};

const engines = (study.config.engines || ['ai_mode', 'ai_overview', 'chatgpt']).map((e) => {
  const mapped = ENGINE_ALIASES[e] || e;
  if (!ENGINES[mapped]) {
    console.error(`Unknown engine "${e}" in the study config. Nothing run.`);
    process.exit(1);
  }
  return mapped;
}).filter((e) => !onlyEngines || onlyEngines.includes(e));

if (!engines.length) {
  console.error('No engines selected. Check --engines.');
  process.exit(1);
}
const prompts = await many(
  `SELECT * FROM sector_prompts WHERE study_id = $1 ${all ? '' : 'AND v1'} ORDER BY kind, key ${limit ? `LIMIT ${limit}` : ''}`,
  [study.id]
);
const companies = await many(
  'SELECT id, key, name, domain, aliases, project_aliases, notes FROM sector_companies WHERE study_id = $1 AND active',
  [study.id]
);

if (!companies.length) {
  console.error('No active companies. Domains must be verified before anything is measured.');
  await pool.end();
  process.exit(1);
}

const matchers = companies.map((c) => ({
  id: c.id,
  key: c.key,
  name: c.name,
  domain: c.domain,
  aliases: c.aliases,
  projectAliases: c.project_aliases || [],
  neverMatch: c.notes?.never_match || []
}));

const total = prompts.length * engines.length * runs;
console.log(`\n${study.name}`);
console.log(`  ${prompts.length} prompts x ${engines.length} engines x ${runs} run${runs === 1 ? '' : 's'} = ${total} answers`);
console.log(`  engines: ${engines.map((e) => ENGINES[e]?.label || e).join(', ')}`);
console.log(`  ${matchers.length} developers being matched\n`);

if (dry) {
  for (const p of prompts.slice(0, 8)) console.log(`  [${p.kind}] ${p.text.slice(0, 96)}`);
  if (prompts.length > 8) console.log(`  ...and ${prompts.length - 8} more`);
  await pool.end();
  process.exit(0);
}

const cycle = new Date().toISOString().slice(0, 10);

/**
 * Answers already stored for this cycle are skipped rather than re-asked.
 * Render drops idle shells, and without this every restart pays again for
 * everything it had already collected.
 *
 * Pass --redo to force a fresh answer for every prompt.
 */
const redo = args.includes('--redo');
const existing = new Set(
  redo
    ? []
    : (
        await many(
          `SELECT prompt_id, engine, run_index FROM sector_answers
           WHERE study_id = $1 AND cycle_date = $2 AND ok AND length(COALESCE(answer_text,'')) > 0`,
          [study.id, cycle]
        )
      ).map((r) => `${r.prompt_id}:${r.engine}:${r.run_index}`)
);

if (existing.size) {
  console.log(`  ${existing.size} answers already stored for today and will be skipped. Use --redo to re-ask.\n`);
}

let done = existing.size;
let asked = 0;
let spend = 0;
const failures = new Map();

for (const prompt of prompts) {
  for (const engine of engines) {
    for (let run = 0; run < runs; run++) {
      if (existing.has(`${prompt.id}:${engine}:${run}`)) continue;

      asked++;
      const answer = await askEngine({
        engine,
        prompt: prompt.text,
        market: study.market,
        maxTokens: 900
      });
      spend += answer.costUsd || 0;
      done++;

      if (!answer.ok) {
        failures.set(engine, (failures.get(engine) || 0) + 1);
      }

      // Store the evidence before extracting anything from it, so extraction
      // can be rerun and corrected without paying for the answers again.
      const stored = await one(
        `INSERT INTO sector_answers
           (study_id, prompt_id, cycle_date, engine, run_index, ok, error, answer_text,
            links, citations, model_version, country, language, browsing, cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (study_id, prompt_id, engine, cycle_date, run_index) DO UPDATE SET
           ok = EXCLUDED.ok, error = EXCLUDED.error, answer_text = EXCLUDED.answer_text,
           links = EXCLUDED.links, citations = EXCLUDED.citations, cost_usd = EXCLUDED.cost_usd
         RETURNING id`,
        [
          study.id, prompt.id, cycle, engine, run,
          answer.ok, answer.error || null, answer.text || null,
          JSON.stringify(answer.citations || []),
          JSON.stringify((answer.citations || []).map((c) => c.url || c)),
          answer.model || null,
          study.market,
          study.config.language || 'en',
          true,
          answer.costUsd || 0
        ]
      );

      if (answer.ok && answer.text) {
        const extraction = scoreRecommendations(
          answer.text,
          extractMentions(answer.text, matchers, answer.citations || [])
        );

        await query('DELETE FROM sector_mentions WHERE answer_id = $1', [stored.id]);
        for (const m of extraction.mentions) {
          await query(
            `INSERT INTO sector_mentions
               (answer_id, company_id, mentioned, ordinal, matched_alias, snippet, recommended, cited, citation_url, via_project)
             VALUES ($1,$2,true,$3,$4,$5,$6,$7,$8,$9)`,
            [stored.id, m.company.id, m.ordinal, m.matchedAlias, m.snippet, m.recommended, m.cited, m.citationUrl, m.viaProject]
          );
        }
      }

      if (asked % 10 === 0 || done === total) {
        process.stdout.write(`\r  ${done}/${total} answers, ${asked} asked this session, $${spend.toFixed(2)}   `);
      }
    }
  }
}

console.log('\n');
if (failures.size) {
  console.log('  failures:', [...failures].map(([e, n]) => `${e} x${n}`).join(', '));
}

const summary = await one(
  `SELECT COUNT(*)::int AS answers,
          COUNT(*) FILTER (WHERE ok)::int AS ok,
          (SELECT COUNT(*) FROM sector_mentions sm
             JOIN sector_answers sa ON sa.id = sm.answer_id
            WHERE sa.study_id = $1 AND sa.cycle_date = $2)::int AS mentions
   FROM sector_answers WHERE study_id = $1 AND cycle_date = $2`,
  [study.id, cycle]
);

console.log(`  ${summary.ok}/${summary.answers} usable answers, ${summary.mentions} developer mentions extracted`);
console.log(`  ${asked} asked this session, $${spend.toFixed(2)} spent\n`);
if (summary.answers < total) {
  console.log(`  ${total - summary.answers} still to collect. Run the same command again; stored answers are skipped.\n`);
}
console.log('  Next: npm run study:validate    read the answers before trusting the numbers\n');
await pool.end();
