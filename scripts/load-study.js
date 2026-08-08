import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { pool, query, one, many } from '../src/db/index.js';
import { isAmbiguous } from '../src/lib/extract.js';

/**
 * Load a sector study from its seed files.
 *
 *   npm run study:load
 *   npm run study:load -- --force    load even with unverified domains
 *
 * The verification file gates this deliberately. A guessed domain
 * misattributes citations to the wrong company on a public page, and two of
 * the first four domains checked were wrong, so unverified developers are
 * loaded as inactive rather than silently trusted.
 */
const force = process.argv.includes('--force');

const base = JSON.parse(readFileSync(new URL('../data/property-developers-index.json', import.meta.url)));
const verified = JSON.parse(readFileSync(new URL('../data/developers-verified.json', import.meta.url)));

/* ---------------- merge ---------------- */

// The verified file supersedes the developers array in the index file.
const byId = new Map(verified.developers.map((d) => [d.id, d]));
const merged = base.developers.map((d) => {
  const v = byId.get(d.id);
  if (!v) return { ...d, verification_status: 'unverified', _missing_from_verified: true };
  return {
    ...d,
    ...v,
    // Keep the domain only when it has actually been confirmed.
    domain: v.verification_status === 'unverified' ? null : v.domain,
    candidate_domain: v.candidate || null
  };
});

const cohortsOf = (id) => base.cohorts.filter((c) => c.members.includes(id)).map((c) => c.id);

/* ---------------- validate ---------------- */

const problems = [];
const warnings = [];

for (const d of merged) {
  const ok = ['verified', 'verified_corrected'].includes(d.verification_status);
  if (!ok) problems.push(`${d.id}: domain unverified (candidate ${d.candidate_domain || 'none'})`);
  if (d._missing_from_verified) problems.push(`${d.id}: absent from the verification file entirely`);

  for (const key of ['alias_warning', 'cohort_warning', 'open_question', 'note']) {
    if (d[key]) warnings.push(`${d.id} [${key}] ${d[key]}`);
  }

  // Aliases that will fire on ordinary prose or on another company.
  for (const a of [d.name, ...(d.aliases || [])]) {
    if (isAmbiguous(a)) warnings.push(`${d.id} [alias] "${a}" is ambiguous and needs corroboration to count`);
  }
  if (!cohortsOf(d.id).length) problems.push(`${d.id}: belongs to no cohort, so it can never be scored`);
}

// Cohorts must not reference developers that do not exist.
const ids = new Set(merged.map((d) => d.id));
for (const c of base.cohorts) {
  for (const m of c.members) if (!ids.has(m)) problems.push(`cohort ${c.id}: unknown member "${m}"`);
}

// Prompts must not reference cohorts that do not exist.
const cohortIds = new Set(base.cohorts.map((c) => c.id));
for (const p of base.prompts.neutral) {
  for (const c of p.cohorts || []) if (!cohortIds.has(c)) problems.push(`prompt ${p.id}: unknown cohort "${c}"`);
}

/* ---------------- report ---------------- */

const verifiedCount = merged.filter((d) => ['verified', 'verified_corrected'].includes(d.verification_status)).length;

console.log(`\n${base.meta.title}\n`);
console.log(`  developers      ${merged.length}  (${verifiedCount} verified, ${merged.length - verifiedCount} not)`);
console.log(`  cohorts         ${base.cohorts.length}`);
console.log(`  neutral prompts ${base.prompts.neutral.length}  (${base.prompts.neutral.filter((p) => p.v1).length} in v1, ${base.prompts.neutral.filter((p) => p.excluded_from_public).length} withheld)`);
console.log(`  persona prompts ${base.prompts.persona.items.length}  (${base.prompts.persona.items.filter((p) => p.v1).length} in v1)`);
console.log(`  branded prompts ${base.prompts.branded.items.length}  (not in v1)`);

if (warnings.length) {
  console.log(`\n  ${warnings.length} warning(s), carried into the database for the matcher to respect:`);
  for (const w of warnings) console.log(`    ${w.slice(0, 150)}`);
}

if (problems.length) {
  console.log(`\n  ${problems.length} problem(s):`);
  for (const p of problems) console.log(`    ${p}`);
}

if (problems.length && !force) {
  console.log('\nNothing loaded. Unverified domains are not a formality: two of the first four');
  console.log('checked were wrong, and a wrong domain credits another company\'s citations to');
  console.log('this one on a public page.');
  console.log('\nVerify the domains, or run with --force to load them as inactive.\n');
  await pool.end();
  process.exit(1);
}

/* ---------------- load ---------------- */

const study = await one(
  `INSERT INTO sector_studies (slug, name, market, config) VALUES ($1,$2,$3,$4)
   ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config
   RETURNING id`,
  [base.meta.slug, base.meta.title, base.meta.market || 'AE', JSON.stringify({
    ...base.meta, scoring: base.scoring, cohorts: base.cohorts, run_rules: base.run_rules
  })]
);

for (const d of merged) {
  const active = ['verified', 'verified_corrected'].includes(d.verification_status);
  // The company's own name is always matchable. Dropping it when aliases
  // were declared made "Danube Properties" unmatchable, because that company
  // lists "Danube" and "Danube Group" as its aliases and not its own name.
  //
  // Collisions are handled by never_match, not by withholding the name: the
  // seed's warning about Alef is satisfied because its declared name is
  // "Alef Group", and bare "Alef" appears in neither the name nor the aliases.
  const aliases = [...new Set([d.name, ...(d.aliases || [])])].filter(Boolean);
  const projectAliases = [...new Set(d.project_aliases || [])].filter(Boolean);

  await query(
    `INSERT INTO sector_companies (study_id, key, name, domain, aliases, project_aliases, cohorts, verification_status, active, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (study_id, key) DO UPDATE SET
       name = EXCLUDED.name, domain = EXCLUDED.domain, aliases = EXCLUDED.aliases,
       project_aliases = EXCLUDED.project_aliases,
       cohorts = EXCLUDED.cohorts, verification_status = EXCLUDED.verification_status,
       active = EXCLUDED.active, notes = EXCLUDED.notes`,
    [study.id, d.id, d.name, d.domain, aliases, projectAliases, cohortsOf(d.id), d.verification_status, active,
     JSON.stringify({
       alias_warning: d.alias_warning || null,
       cohort_warning: d.cohort_warning || null,
       open_question: d.open_question || null,
       note: d.note || null,
       candidate_domain: d.candidate_domain || null,
       never_match: d.never_match || [],
       commercial_relationship: Boolean(d.commercial_relationship)
     })]
  );
}

const addPrompt = async (key, text, { geo, intent, cohorts, v1, kind, excluded, reason }) =>
  query(
    `INSERT INTO sector_prompts (study_id, key, text, geo, intent, kind, cohorts, v1, excluded_from_public, exclusion_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (study_id, key) DO UPDATE SET
       text = EXCLUDED.text, geo = EXCLUDED.geo, intent = EXCLUDED.intent, kind = EXCLUDED.kind,
       cohorts = EXCLUDED.cohorts, v1 = EXCLUDED.v1,
       excluded_from_public = EXCLUDED.excluded_from_public, exclusion_reason = EXCLUDED.exclusion_reason`,
    [study.id, key, text, geo, intent, kind, cohorts || [], Boolean(v1), Boolean(excluded), reason || null]
  );

for (const p of base.prompts.neutral) {
  await addPrompt(p.id, p.text, {
    geo: p.geo, intent: p.intent, cohorts: p.cohorts, v1: p.v1, kind: 'neutral',
    excluded: p.excluded_from_public, reason: p.exclusion_reason
  });
}

// Persona prompts are a template plus substitutions, so the stored text is
// the resolved question rather than the template.
const tpl = base.prompts.persona.template;
for (const p of base.prompts.persona.items) {
  const text = tpl
    .replace('{buyer_type}', p.buyer_type)
    .replace('{budget}', p.budget)
    .replace('{property_type}', p.property_type)
    .replace('{location}', p.location)
    .replace('{purpose}', p.purpose);
  await addPrompt(p.id, text, { geo: null, intent: 'persona', cohorts: [], v1: p.v1, kind: 'persona' });
}

const counts = await one(
  `SELECT
     (SELECT COUNT(*) FROM sector_companies WHERE study_id = $1)::int AS companies,
     (SELECT COUNT(*) FROM sector_companies WHERE study_id = $1 AND active)::int AS active,
     (SELECT COUNT(*) FROM sector_prompts WHERE study_id = $1)::int AS prompts,
     (SELECT COUNT(*) FROM sector_prompts WHERE study_id = $1 AND v1)::int AS v1,
     (SELECT COUNT(*) FROM sector_prompts WHERE study_id = $1 AND excluded_from_public)::int AS withheld`,
  [study.id]
);

console.log(`\nLoaded study #${study.id}`);
console.log(`  ${counts.active} of ${counts.companies} developers active`);
console.log(`  ${counts.prompts} prompts, ${counts.v1} in v1, ${counts.withheld} withheld from the public page`);
if (counts.active < counts.companies) {
  console.log(`\n  ${counts.companies - counts.active} developers are loaded but inactive. They will not be`);
  console.log('  measured, scored or rendered until their domains are verified.');
}
console.log();
await pool.end();
