import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool, many, one } from '../src/db/index.js';
import { ENGINE_IDS } from '../src/lib/dataforseo.js';

/**
 * Export one site's measurement, row by row.
 *
 *   npm run export -- 7
 *   npm run export -- 7 --no-answers    leave out the full answer text
 *
 * One row per engine per prompt per run, misses included. A file filtered to
 * citations only would answer the easy question and hide the useful one, so
 * every attempt is present with cited FALSE where it failed.
 */
const id = Number(process.argv.find((a) => /^\d+$/.test(a)));
const withAnswers = !process.argv.includes('--no-answers');

if (!id) {
  const rows = await many('SELECT id, name, domain FROM projects ORDER BY id');
  console.log('\nsites\n');
  for (const r of rows) console.log(`  ${String(r.id).padStart(3)}  ${r.name} (${r.domain})`);
  console.log('\nnpm run export -- <id>\n');
  await pool.end();
  process.exit(0);
}

const project = await one('SELECT * FROM projects WHERE id = $1', [id]);
if (!project) {
  console.error(`No site with id ${id}.`);
  await pool.end();
  process.exit(1);
}

/** Engine ids are internal. These are the names people use. */
const ENGINE_LABEL = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  claude: 'Claude',
  ai_overview: 'Google AI Overviews',
  ai_mode: 'Google AI Mode'
};

const csv = (rows) =>
  rows
    .map((r) =>
      r
        .map((cell) => {
          if (cell === null || cell === undefined) return '';
          const s = String(cell);
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(',')
    )
    .join('\r\n');

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const own = String(project.domain).replace(/^www\./, '').toLowerCase();

const COMPETITORS = (
  await many("SELECT name, domain FROM entities WHERE project_id = $1 AND kind = 'competitor'", [id])
).filter((c) => c.name);

/* ---------- 1. the measurement, row per engine per prompt per run ---------- */

const runs = await many(
  `SELECT r.id AS run_id, r.cycle_date, r.engine, r.run_index, r.ok, r.response_text,
          p.id AS prompt_id, p.text AS prompt_text, p.intent, p.cluster,
          pe.name AS persona,
          m.mentioned, m.ordinal
   FROM runs r
   JOIN prompts p ON p.id = r.prompt_id
   LEFT JOIN personas pe ON pe.id = p.persona_id
   LEFT JOIN mentions m ON m.run_id = r.id
     AND m.entity_id = (SELECT id FROM entities WHERE project_id = $1 AND kind = 'owned' LIMIT 1)
   WHERE r.project_id = $1
   ORDER BY r.cycle_date, p.id, r.engine, r.run_index`,
  [id]
);

// Citations per run, so cited and mentioned stay separate measurements.
const citeRows = await many(
  `SELECT c.run_id, c.domain, c.url, c.position
   FROM citations c JOIN runs r ON r.id = c.run_id
   WHERE r.project_id = $1`,
  [id]
);

const byRun = new Map();
for (const c of citeRows) {
  if (!byRun.has(c.run_id)) byRun.set(c.run_id, []);
  byRun.get(c.run_id).push(c);
}

const header = [
  'run_date', 'prompt_id', 'prompt_text', 'persona', 'engine', 'country', 'language',
  'cited', 'cited_url', 'mentioned',
  'position_in_answer', 'total_sources_cited', 'competitor_cited', 'prompt_intent', 'run_index'
];
if (withAnswers) header.push('answer_text');

const out = [header];

for (const r of runs) {
  const cites = byRun.get(r.run_id) || [];
  const mine = cites.find((c) => String(c.domain).replace(/^www\./, '').toLowerCase() === own);

  // A competitor counts whether it was cited as a source or named in the text.
  const text = String(r.response_text || '');
  const rivals = COMPETITORS.filter(
    (c) =>
      (c.domain && cites.some((x) => String(x.domain).replace(/^www\./, '').toLowerCase() === String(c.domain).replace(/^www\./, '').toLowerCase())) ||
      new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
  ).map((c) => c.name);

  const row = [
    day(r.cycle_date),
    r.prompt_id,
    r.prompt_text,
    r.persona || '',
    ENGINE_LABEL[r.engine] || r.engine,
    project.market,
    (project.language || 'en').toUpperCase(),
    mine ? 'TRUE' : 'FALSE',
    mine?.url || '',
    r.mentioned ? 'TRUE' : 'FALSE',
    mine?.position ?? '',
    cites.length,
    rivals.join('; '),
    r.intent || '',
    r.run_index
  ];
  if (withAnswers) row.push(r.response_text || '');
  out.push(row);
}

/* ---------- 2. every prompt, including ones never run ---------- */

const prompts = await many(
  `SELECT p.id, p.text, p.cluster, p.intent, p.active, p.source, p.created_at,
          pe.name AS persona,
          (SELECT COUNT(*)::int FROM runs r WHERE r.prompt_id = p.id AND r.ok) AS runs_so_far,
          (SELECT MAX(cycle_date) FROM runs r WHERE r.prompt_id = p.id AND r.ok) AS last_run
   FROM prompts p LEFT JOIN personas pe ON pe.id = p.persona_id
   WHERE p.project_id = $1 ORDER BY p.id`,
  [id]
);

const promptCsv = [
  ['prompt_id', 'prompt_text', 'persona', 'country', 'language', 'prompt_intent', 'cluster', 'status', 'added_on', 'times_run', 'last_run'],
  ...prompts.map((p) => [
    p.id,
    p.text,
    p.persona || '',
    project.market,
    (project.language || 'en').toUpperCase(),
    p.intent,
    p.cluster,
    p.active ? 'active' : 'paused',
    day(p.created_at),
    p.runs_so_far,
    day(p.last_run)
  ])
];

/* ---------- 3. what changed, and when ---------- */

const events = await many(
  'SELECT event, text, previous, persona, at FROM prompt_events WHERE project_id = $1 ORDER BY at',
  [id]
);

const changeCsv = [
  ['date', 'event', 'prompt_text', 'previous_text', 'persona', 'evidence'],
  // Anything before event logging existed is inferred from when the row was
  // created, and says so rather than pretending to be a record.
  ...prompts.map((p) => [day(p.created_at), 'added', p.text, '', p.persona || '', 'inferred from created_at']),
  ...events.map((e) => [day(e.at), e.event, e.text, e.previous || '', e.persona || '', 'logged'])
].sort((a, b) => (a[0] === 'date' ? -1 : String(a[0]).localeCompare(String(b[0]))));

/* ---------- write ---------- */

const dir = new URL('../out/', import.meta.url);
mkdirSync(dir, { recursive: true });
const slug = String(project.domain).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const stamp = new Date().toISOString().slice(0, 10);

const files = [
  [`${slug}-runs-${stamp}.csv`, csv(out)],
  [`${slug}-prompts-${stamp}.csv`, csv(promptCsv)],
  [`${slug}-changes-${stamp}.csv`, csv(changeCsv)]
];

for (const [name, body] of files) {
  // BOM so Excel opens Arabic prompt text correctly rather than as mojibake.
  writeFileSync(new URL(name, dir), '\ufeff' + body, 'utf8');
}

/* ---------- what a reader needs to know ---------- */

const engines = project.engines || [];
const cycles = await many(
  'SELECT DISTINCT cycle_date FROM runs WHERE project_id = $1 AND ok ORDER BY cycle_date',
  [id]
);

const gaps = cycles.slice(1).map((c, i) => (new Date(c.cycle_date) - new Date(cycles[i].cycle_date)) / 86400000);
const cadence = gaps.length
  ? `${Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)} days between runs on average, ranging ${Math.min(...gaps)} to ${Math.max(...gaps)}`
  : 'only one cycle so far, so there is no cadence to report';

const notes = `${project.name} (${project.domain})
Exported ${stamp}

WHAT IS IN THE FILES
  ${slug}-runs-${stamp}.csv       ${out.length - 1} rows, one per engine per prompt per run, misses included
  ${slug}-prompts-${stamp}.csv    ${prompts.length} prompts, including any never run
  ${slug}-changes-${stamp}.csv    ${changeCsv.length - 1} entries

ENGINES LIVE FOR THIS SITE TODAY
  ${engines.map((e) => ENGINE_LABEL[e] || e).join(', ') || 'none configured'}

  Copilot and Grok are not covered. We do not query them at all, so their
  absence from the file is not a nil return, it is no measurement. Nothing in
  this export overlaps with Bing Webmaster Tools AI Performance, which reports
  Bing and Copilot surfaces we do not touch. The two datasets are
  complementary rather than comparable.

HOW OFTEN EACH PROMPT IS RE-RUN
  Runs are triggered manually rather than scheduled. ${cadence}.
  Each prompt is asked ${project.runs_per_cycle} time${project.runs_per_cycle === 1 ? '' : 's'} per engine per cycle.

WHAT THE COLUMNS MEAN
  cited      tfoco.com appeared as a linked source in that answer
  mentioned  the brand was named in the answer text
  These are separate measurements and are never merged. An answer can name
  the brand without linking to it, which is the more common case.

LIMITS YOU SHOULD KNOW
  prompt_id is stable while a prompt exists, but the product has no edit: a
  reworded prompt is a delete and an add, so it gets a new id. The change log
  shows both events, but the ids will not carry across.

  Change events were only logged from the date this feature shipped. Earlier
  entries in the change log are marked "inferred from created_at" and cover
  additions only. Removals before that date left no trace and are not
  recoverable.

  Run dates are actual dates, not bucketed into weeks. Where a week is missing
  it is because nothing was run, not because the data was dropped.
`;

writeFileSync(new URL(`${slug}-notes-${stamp}.txt`, dir), notes, 'utf8');

console.log(`\n${notes}`);
console.log(`Written to out/\n`);
for (const [name] of files) console.log(`  ${name}`);
console.log(`  ${slug}-notes-${stamp}.txt\n`);
await pool.end();
