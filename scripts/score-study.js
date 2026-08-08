import 'dotenv/config';
import { pool } from '../src/db/index.js';
import { scoreStudy, COMPOSITE_WEIGHTS } from '../src/lib/score.js';

/** npm run study:score */
const result = await scoreStudy(process.argv[2] || 'property-developers');
const pct = (n) => `${(n * 100).toFixed(0)}%`.padStart(4);

console.log(`\n${result.study.name}, ${new Date(result.cycle).toDateString()}\n`);

console.log('engine coverage');
for (const e of result.engines) {
  console.log(
    `  ${e.engine.padEnd(13)} ${e.answered}/${e.attempted} answered (${pct(e.answer_rate)})` +
      `${e.thin ? '   <- too thin to score on its own' : ''}`
  );
}

for (const c of result.cohorts) {
  if (!c.companies.length) continue;
  console.log(`\n${c.label}  (${c.companies.length} developers, scored within this cohort only)`);
  console.log('  composite  named  top3  recd  cited   spread on named   developer');
  for (const co of c.companies) {
    const s = co.spread.mention_rate;
    const spread = co.runs > 1 ? `${pct(s.min)}-${pct(s.max)}` : '   single run';
    console.log(
      `  ${co.composite.toFixed(3).padStart(9)}  ${pct(co.mention_rate)}  ${pct(co.top_three_rate)}  ` +
        `${pct(co.recommendation_rate)}  ${pct(co.citation_rate)}   ${spread.padStart(14)}   ${co.name}` +
        `${co.project_mentions ? `  (+${co.project_mentions} project mentions, excluded)` : ''}`
    );
  }
}

console.log('\nweights:', Object.entries(COMPOSITE_WEIGHTS).map(([k, v]) => `${k} ${v}`).join(', '));
for (const c of Object.values(result.caveats)) console.log(`  ${c}`);
console.log();
await pool.end();
