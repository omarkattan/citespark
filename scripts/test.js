/**
 * No-database sanity checks for the parts that decide product quality:
 * mention detection, the engine client, and every recommendation rule.
 * Run with: node scripts/test.js
 */
import assert from 'node:assert/strict';
import { analyseRun } from '../src/lib/analyze.js';
import { askEngine, domainOf } from '../src/lib/dataforseo.js';
import { evaluateRules } from '../src/lib/recommend.js';
import { generatePrompts } from '../src/lib/prompts.js';
import { readSignals, normaliseDomain } from '../src/lib/discover.js';
import { PLANS, PLAN_ORDER, planFor, estimateCycle, clampToPlan, WORST_CASE_CALL, COGS_SHARE } from '../src/lib/plans.js';
import { ENGINES, ENGINE_IDS, LOCATIONS } from '../src/lib/dataforseo.js';

let pass = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

const entities = [
  { id: 1, name: 'Sandstorm Digital', domain: 'sandstormdigital.com', kind: 'owned', aliases: ['Sandstorm'] },
  { id: 2, name: 'Impression', domain: 'impression.co.uk', kind: 'competitor', aliases: [] },
  { id: 3, name: 'Aira', domain: 'aira.net', kind: 'competitor', aliases: [] }
];

console.log('\nsector scoring');

await test('the withheld prompt never reaches a published number', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/lib/score.js', import.meta.url), 'utf8');

  // A ranked reputational claim about named companies, from unverified model
  // output, is a defamation risk. It must be excluded from every query that
  // feeds the page, not merely hidden at the rendering layer.
  const queries = src.match(/`[\s\S]*?`/g).filter((q) => /sector_prompts/.test(q));
  assert.ok(queries.length >= 2, 'expected several queries over prompts');
  for (const q of queries) {
    assert.ok(
      /excluded_from_public/.test(q),
      `a query reads prompts without excluding the withheld one:\n${q.slice(0, 200)}`
    );
  }
});

await test('a project mention never enters a corporate rate', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/lib/score.js', import.meta.url), 'utf8');

  // Every component of the composite counts mentions; each must exclude the
  // ones matched only via a project name.
  for (const metric of ['mentions', 'top_three', 'recommendations', 'citations']) {
    const line = src.split('\n').find((l) => l.includes(`AS ${metric}`));
    assert.ok(line, `no line computing ${metric}`);
    assert.ok(/NOT m\.via_project/.test(line), `${metric} counts project mentions: ${line.trim()}`);
  }
});



const sc = await import('../src/lib/score.js');

await test('the composite matches the published weights exactly', () => {
  assert.deepEqual(sc.COMPOSITE_WEIGHTS, {
    mention_rate: 0.35, top_three_rate: 0.25, recommendation_rate: 0.2, citation_rate: 0.2
  });
  assert.equal(Object.values(sc.COMPOSITE_WEIGHTS).reduce((a, b) => a + b, 0), 1);

  // A developer named in everything, first every time, always recommended
  // and always cited scores 1. Nothing scores above it.
  assert.equal(sc.composite({ mention_rate: 1, top_three_rate: 1, recommendation_rate: 1, citation_rate: 1 }), 1);
  assert.equal(sc.composite({ mention_rate: 0, top_three_rate: 0, recommendation_rate: 0, citation_rate: 0 }), 0);

  // Mention rate carries the most weight, so it must move the score most.
  const base = { mention_rate: 0, top_three_rate: 0, recommendation_rate: 0, citation_rate: 0 };
  assert.ok(sc.composite({ ...base, mention_rate: 1 }) > sc.composite({ ...base, top_three_rate: 1 }));
  assert.ok(sc.composite({ ...base, top_three_rate: 1 }) > sc.composite({ ...base, citation_rate: 1 }));
});

console.log('\nsector study seed');

await test('every developer has a verified domain', async () => {
  const { readFileSync } = await import('node:fs');
  const ver = JSON.parse(readFileSync(new URL('../data/developers-verified.json', import.meta.url)));

  // A guessed domain credits another company's citations to this one on a
  // public page. Two of the original twenty-two were wrong, which is the
  // whole reason this gate exists.
  for (const d of ver.developers) {
    assert.ok(
      ['verified', 'verified_corrected'].includes(d.verification_status),
      `${d.id} is ${d.verification_status} and must not be published`
    );
    assert.ok(d.domain && d.domain !== 'UNVERIFIED', `${d.id} has no confirmed domain`);
    assert.ok(!/^https?:/.test(d.domain), `${d.id}: domain should be a bare hostname`);
    assert.ok(!d.candidate, `${d.id} still carries an unresolved candidate domain`);
  }
});

await test('the seed files are internally consistent', async () => {
  const { readFileSync } = await import('node:fs');
  const base = JSON.parse(readFileSync(new URL('../data/property-developers-index.json', import.meta.url)));
  const ver = JSON.parse(readFileSync(new URL('../data/developers-verified.json', import.meta.url)));

  const ids = new Set(base.developers.map((d) => d.id));
  // A cohort naming a developer that does not exist would silently shrink
  // that cohort's denominator and inflate everyone else's score.
  for (const c of base.cohorts) {
    for (const m of c.members) assert.ok(ids.has(m), `cohort ${c.id} names unknown developer "${m}"`);
  }
  const cohortIds = new Set(base.cohorts.map((c) => c.id));
  for (const p of base.prompts.neutral) {
    for (const c of p.cohorts || []) assert.ok(cohortIds.has(c), `prompt ${p.id} names unknown cohort "${c}"`);
  }
  for (const d of base.developers) {
    assert.ok(base.cohorts.some((c) => c.members.includes(d.id)), `${d.id} is in no cohort and can never be scored`);
  }

  // The verification file supersedes the developers array, so it must cover it.
  const verIds = new Set(ver.developers.map((d) => d.id));
  for (const d of base.developers) assert.ok(verIds.has(d.id), `${d.id} missing from the verification file`);
});

await test('the composite uses machine-verifiable components only', async () => {
  const { readFileSync } = await import('node:fs');
  const base = JSON.parse(readFileSync(new URL('../data/property-developers-index.json', import.meta.url)));
  const w = base.scoring.published_composite.weights;

  assert.equal(Object.values(w).reduce((a, b) => a + b, 0), 1, 'weights must sum to 1');

  // Accuracy, sentiment and hallucination cannot be reproduced monthly across
  // 22 developers, so they cannot be defended and must stay out of the score.
  for (const k of base.scoring.annotated_only) {
    assert.ok(!(k in w), `${k} is annotated, it must not enter the composite`);
  }
  assert.deepEqual(Object.keys(w).sort(), ['citation_rate', 'mention_rate', 'recommendation_rate', 'top_three_rate']);
});

await test('the reputational prompt is withheld with its reason intact', async () => {
  const { readFileSync } = await import('node:fs');
  const base = JSON.parse(readFileSync(new URL('../data/property-developers-index.json', import.meta.url)));
  const withheld = base.prompts.neutral.filter((p) => p.excluded_from_public);

  assert.equal(withheld.length, 1);
  assert.match(withheld[0].text, /complaints/i);
  assert.ok(withheld[0].exclusion_reason, 'the reason is part of the method and must be retained');
  assert.equal(withheld[0].v1, false, 'and it must not be in the v1 run');
});

console.log('\nsector extraction');

const ex = await import('../src/lib/extract.js');

const DEVS = [
  { key: 'emaar', name: 'Emaar Properties', domain: 'emaar.com', aliases: ['Emaar'] },
  { key: 'damac', name: 'DAMAC Properties', domain: 'damacproperties.com', aliases: ['DAMAC'] },
  { key: 'arada', name: 'Arada', domain: 'arada.com' },
  { key: 'nakheel', name: 'Nakheel', domain: 'nakheel.com' },
  { key: 'select', name: 'Select Group', domain: 'select-group.ae', aliases: ['Select'] },
  { key: 'nest', name: 'Nest', domain: 'nestdubai.ae' },
  { key: 'meraas', name: 'Meraas', domain: 'meraas.com' }
];

await test('an ordinary word is not a company mention', () => {
  // "select a developer" and "nest your savings" both produced false
  // positives when nearness to a qualifier was the test. A published score
  // built on those would be noise dressed as evidence.
  const text = 'Nest your savings carefully. Select a developer with a track record. The best option is Meraas.';
  const r = ex.extractMentions(text, DEVS);

  assert.deepEqual(r.mentions.map((m) => m.company.key), ['meraas']);
});

await test('an ambiguous alias counts only on hard evidence', () => {
  const suffix = ex.extractMentions('Select Group delivered Marina Gate. Nest Properties is smaller.', DEVS);
  assert.deepEqual(suffix.mentions.map((m) => m.company.key).sort(), ['nest', 'select']);
  // Both are accepted, for different reasons: "Select Group" on its
  // capitalisation, "Nest Properties" on the suffix that follows.
  const reasons = Object.fromEntries(suffix.mentions.map((m) => [m.company.key, m.matchReason]));
  assert.match(reasons.nest, /suffix/);
  assert.match(reasons.select, /capitalisation|suffix/);

  const entity = ex.extractMentions('The tower was developed by Nest, a boutique firm.', DEVS);
  assert.deepEqual(entity.mentions.map((m) => m.company.key), ['nest']);

  const linked = ex.extractMentions('A good option is Nest. See https://nestdubai.ae/projects.', DEVS);
  assert.deepEqual(linked.mentions.map((m) => m.company.key), ['nest']);
  assert.equal(linked.mentions[0].cited, true, 'the linked domain is also the citation');

  // Every accepted ambiguous match records why, so it can be audited.
  for (const r of [suffix, entity, linked]) {
    for (const m of r.mentions) if (m.ambiguousMatch) assert.ok(m.matchReason, 'ambiguous matches must say why');
  }
});

await test('a name shared with another company does not count as this one', () => {
  // Alef Group is a Sharjah developer. Alef Education is a UAE edtech firm
  // that appears in another of our own public indexes, so a collision would
  // be visible on two pages at once.
  const devs = [
    { key: 'alef', name: 'Alef Group', domain: 'alefgroup.ae',
      aliases: ['Alef Group', 'Alef Properties', 'Alef Real Estate'],
      neverMatch: ['Alef Education', 'alefeducation', 'Alef Aviation'] },
    { key: 'sobha', name: 'Sobha Realty', domain: 'sobharealty.com',
      aliases: ['Sobha Realty', 'Sobha'], neverMatch: ['Sobha Limited'] },
    { key: 'danube', name: 'Danube Properties', domain: 'danubeproperties.com',
      aliases: ['Danube Properties', 'Danube'], neverMatch: ['Danube Home', 'Danube River'] }
  ];
  const keys = (t) => ex.extractMentions(t, devs).mentions.map((m) => m.company.key);

  assert.deepEqual(keys('Alef Education provides digital learning across UAE schools.'), []);
  assert.deepEqual(keys('Alef Group is developing Hayyan in Sharjah.'), ['alef']);

  // Both companies in one answer: only the developer counts, and the presence
  // of the other must not suppress it.
  assert.deepEqual(keys('Alef Education runs the platform. Separately, Alef Properties is building in Sharjah.'), ['alef']);

  // An exclusion must fire only when the hit is inside the excluded phrase.
  // A window blocked "Alef Group is building Hayyan" because "Alef Education"
  // appeared in the next sentence, which is exactly backwards.
  assert.deepEqual(
    keys('Alef Group is building Hayyan.\nAlef Education is a separate edtech company.'),
    ['alef'],
    'the other company appearing nearby must not suppress a real mention'
  );
  assert.deepEqual(
    keys('Buy furniture at Danube Home, but Danube Properties is a developer.'),
    ['danube'],
    'the developer counts even with the retailer in the same sentence'
  );

  assert.deepEqual(keys('Sobha Limited is listed on the Indian exchanges.'), []);
  assert.deepEqual(keys('Sobha Realty is building Hartland II.'), ['sobha']);
  assert.deepEqual(keys('Furnish it from Danube Home in Al Quoz.'), []);
  assert.deepEqual(keys('Danube Properties offers a 1% monthly plan.'), ['danube']);
});

await test('the bare name is never an alias where the seed forbids it', async () => {
  const { readFileSync } = await import('node:fs');
  const ver = JSON.parse(readFileSync(new URL('../data/developers-verified.json', import.meta.url)));
  const alef = ver.developers.find((d) => d.id === 'alef');

  assert.ok(!alef.aliases.includes('Alef'), 'bare "Alef" must never be matchable');
  assert.ok(alef.aliases.every((a) => /^Alef (Group|Properties|Real Estate)$/.test(a)));
  assert.ok(alef.never_match.some((n) => /Alef Education/i.test(n)));

  // Every developer carrying an alias warning must also carry exclusions.
  for (const d of ver.developers) {
    if (d.alias_warning) {
      assert.ok(d.never_match?.length, `${d.id} has an alias warning but no never_match list`);
    }
  }
});

await test('ordinal is position among companies, not position in the text', () => {
  const text =
    'For families in Sharjah, Arada is strongest. In Dubai, Emaar Properties remains the benchmark ' +
    'and DAMAC Properties is worth considering. Nakheel built Palm Jumeirah.';
  const r = ex.extractMentions(text, DEVS);

  assert.deepEqual(r.mentions.map((m) => m.company.key), ['arada', 'emaar', 'damac', 'nakheel']);
  assert.deepEqual(r.mentions.map((m) => m.ordinal), [1, 2, 3, 4]);
});

await test('citations match a company to its own domain, tracking stripped', () => {
  const text = 'Arada is strongest, see https://www.arada.com/en/aljada/?utm_source=chatgpt.com. Emaar is also strong.';
  const r = ex.extractMentions(text, DEVS, ['https://emaar.com/en/?ref=x']);

  const arada = r.mentions.find((m) => m.company.key === 'arada');
  assert.equal(arada.cited, true);
  assert.equal(arada.citationUrl, 'https://www.arada.com/en/aljada/', 'utm parameters must be stripped');

  // Links supplied separately by the engine count as citations too.
  assert.equal(r.mentions.find((m) => m.company.key === 'emaar').cited, true);
  assert.ok(r.links.some((l) => l.source === 'engine'));
});

await test('recommendation is narrower than mention', () => {
  const text =
    'Emaar Properties is the one I would recommend. DAMAC Properties also builds here. ' +
    'I would avoid Nakheel for off-plan at the moment.';
  const r = ex.scoreRecommendations(text, ex.extractMentions(text, DEVS));
  const by = Object.fromEntries(r.mentions.map((m) => [m.company.key, m]));

  assert.equal(by.emaar.recommended, true);
  assert.equal(by.damac.recommended, false, 'merely present is not recommended');
  assert.equal(by.nakheel.recommended, false, 'negative context must not count as a recommendation');
});

await test('a multi-word name in its own capitalisation counts', () => {
  // "Select Group" is every-token-common and therefore ambiguous, but it can
  // still be matched: proper-noun capitalisation is the evidence. Without
  // this the company was unmatchable, which is a silent zero on a public page.
  const devs = [{ key: 'select', name: 'Select Group', domain: 'select-group.ae', aliases: ['Select Group', 'Select'] }];
  const keys = (t) => ex.extractMentions(t, devs).mentions.map((m) => m.company.key);

  assert.deepEqual(keys('Select Group delivered Marina Gate.'), ['select']);
  assert.deepEqual(keys('You should select a group of developers to compare.'), []);
  assert.deepEqual(keys('select group discounts are available.'), [], 'lower case is prose, not a name');
});

await test('a project name is not a corporate mention', () => {
  // The run rules state that corporate developer visibility and individual
  // project visibility are separate measurements. Crediting Sharjah Holding
  // for an answer that says "Al Zahia" conflates the two.
  const devs = [
    { key: 'sh', name: 'Sharjah Holding', domain: 'sharjahholding.ae',
      aliases: ['Sharjah Holding PJSC'], projectAliases: ['Al Zahia'] },
    { key: 'arada', name: 'Arada', domain: 'arada.com' }
  ];
  const find = (t) => ex.extractMentions(t, devs).mentions;

  const project = find('Al Zahia is a well regarded family community.');
  assert.equal(project[0].company.key, 'sh');
  assert.equal(project[0].viaProject, true, 'must be flagged, not counted as corporate');

  const corporate = find('Sharjah Holding PJSC develops in the emirate.');
  assert.equal(corporate[0].viaProject, false);

  // Named both ways in one answer: the corporate mention is the stronger
  // signal and must win regardless of which appears first.
  const both = find('Al Zahia, developed by Sharjah Holding PJSC, is popular.');
  assert.equal(both.length, 1);
  assert.equal(both[0].viaProject, false, 'a corporate mention outranks a project mention');
});

await test('project aliases are held apart in the seed', async () => {
  const { readFileSync } = await import('node:fs');
  const ver = JSON.parse(readFileSync(new URL('../data/developers-verified.json', import.meta.url)));

  for (const d of ver.developers) {
    for (const a of d.aliases || []) {
      assert.ok(
        !(d.project_aliases || []).includes(a),
        `${d.id}: "${a}" is in both the corporate and project alias lists`
      );
    }
  }
  const sh = ver.developers.find((d) => d.id === 'sharjah_holding');
  assert.deepEqual(sh.project_aliases, ['Al Zahia']);
  assert.ok(!sh.aliases.includes('Al Zahia'));
});

await test('being short does not make a name ambiguous', () => {
  // "Arada" is five letters and unmistakable. "Select" is six and not.
  assert.equal(ex.isAmbiguous('Arada'), false);
  assert.equal(ex.isAmbiguous('Emaar'), false);
  assert.equal(ex.isAmbiguous('Meraas'), false);
  assert.equal(ex.isAmbiguous('Select'), true);
  assert.equal(ex.isAmbiguous('Nest'), true);
  assert.equal(ex.isAmbiguous('One'), true);
  assert.equal(ex.isAmbiguous('Select Group'), true, 'every token is a common word');
});

console.log('\nmention detection');

await test('finds the brand and records order of appearance', async () => {
  const text = 'You could look at Impression first. Sandstorm Digital is also strong on technical work. Aira is another option.';
  const res = await analyseRun({ text, entities });
  const own = res.find((r) => r.entity_id === 1);
  assert.equal(own.mentioned, true);
  assert.equal(own.ordinal, 2, 'brand appears second');
  assert.equal(res.find((r) => r.entity_id === 2).ordinal, 1);
  assert.equal(res.find((r) => r.entity_id === 3).ordinal, 3);
});

await test('matches an alias', async () => {
  const res = await analyseRun({ text: 'Sandstorm did the migration work.', entities });
  assert.equal(res.find((r) => r.entity_id === 1).mentioned, true);
});

await test('does not match a substring inside another word', async () => {
  const res = await analyseRun({ text: 'The airastructure was rebuilt.', entities });
  assert.equal(res.find((r) => r.entity_id === 3).mentioned, false);
});

await test('reports absence rather than guessing', async () => {
  const res = await analyseRun({ text: 'Try a freelancer or an in-house hire.', entities });
  assert.equal(res.every((r) => r.mentioned === false), true);
  assert.equal(res.every((r) => r.ordinal === null), true);
});

await test('flags negative framing', async () => {
  const res = await analyseRun({ text: 'Sandstorm Digital has mixed reviews and some complaints about reporting.', entities });
  assert.equal(res.find((r) => r.entity_id === 1).sentiment, 'negative');
});

console.log('\nengine client');

await test('mock mode returns usable answers and citations', async () => {
  process.env.MOCK_MODE = 'true';
  const { askEngine: fresh } = await import('../src/lib/dataforseo.js?mock=1');
  const a = await fresh({ engine: 'chatgpt', prompt: 'best seo agency uk' });
  assert.equal(a.ok, true);
  assert.ok(a.text.length > 40, 'answer has body text');
  assert.ok(a.citations.length >= 1, 'answer carries citations');
  assert.ok(a.citations.every((c) => c.domain && !c.domain.startsWith('www.')));
});

await test('normalises citation domains', () => {
  assert.equal(domainOf('https://www.Clutch.co/uk/agencies?x=1'), 'clutch.co');
  assert.equal(domainOf('not a url'), null);
});

await test('rejects unknown engines instead of failing silently', async () => {
  const a = await askEngine({ engine: 'nope', prompt: 'x' });
  assert.equal(a.ok, false);
});

console.log('\nrecommendation rules');

await test('the rules engine runs with only the minimum inputs', () => {
  // Two variables were referenced before they existed, so every cycle threw
  // and produced no recommendations at all. Nothing caught it because every
  // other rule test passes a fully populated fixture.
  assert.doesNotThrow(() =>
    evaluateRules({
      project: { id: 1, brand_name: 'X', domain: 'x.com' },
      stats: [{
        prompt_id: 1, text: 'q', cluster: 'c', ai_search_volume: 100, engine: 'chatgpt',
        entity_id: 1, name: 'X', kind: 'owned', domain: 'x.com',
        runs: 3, hits: 2, avg_ordinal: 2, negatives: 0, snippet: null, sample_run: 1
      }]
    })
  );
  assert.doesNotThrow(() => evaluateRules({ project: { id: 1, brand_name: 'X', domain: 'x.com' }, stats: [] }));
});

await test('a competitor action says on which questions they win', () => {
  // "They beat you on 6 questions" is a claim until the six can be read,
  // with both rates side by side.
  const project = { id: 1, brand_name: 'Sandstorm Digital', domain: 'sandstormdigital.com' };
  const q = (i) => ({
    prompt_id: i, text: `Question ${i}?`, cluster: 'c', ai_search_volume: 500, engine: 'chatgpt',
    runs: 3, negatives: 0, snippet: null, sample_run: 1, avg_ordinal: 3
  });

  const stats = [];
  for (let i = 1; i <= 4; i++) {
    stats.push({ ...q(i), entity_id: 1, name: 'Sandstorm Digital', kind: 'owned', domain: 'sandstormdigital.com', hits: 1 });
    stats.push({ ...q(i), entity_id: 2, name: 'Digital Gravity', kind: 'competitor', domain: 'digitalgravity.ae', hits: 3 });
  }

  const rec = evaluateRules({ project, stats, ownCitedByPrompt: new Map() })
    .find((r) => r.type === 'competitor_comparison');

  assert.ok(rec, 'the rule must fire');
  assert.equal(rec.evidence.questions.length, 4, 'every question, not a sample');
  for (const item of rec.evidence.questions) {
    assert.ok(item.question, 'each row needs the question');
    assert.equal(typeof item.own_rate, 'number');
    assert.equal(typeof item.competitor_rate, 'number');
    assert.ok(item.competitor_rate > item.own_rate, 'these are the ones they win');
  }
});

await test('a source action carries every question it shapes', () => {
  // "keyspacerealty.com shapes 15 of your questions" is only actionable if
  // the fifteen can be read. One sample question was the least useful part
  // of an otherwise specific action.
  const project = { id: 1, brand_name: 'Sandstorm Digital', domain: 'sandstormdigital.com' };
  const stat = {
    prompt_id: 1, text: 'q', cluster: 'c', ai_search_volume: 100, engine: 'chatgpt',
    entity_id: 1, name: 'Sandstorm Digital', kind: 'owned', domain: 'sandstormdigital.com',
    runs: 3, hits: 1, avg_ordinal: 3, negatives: 0, snippet: null, sample_run: 1
  };

  const questions = Array.from({ length: 15 }, (_, i) => ({
    question: `Question number ${i + 1}?`,
    url: `https://keyspacerealty.com/page-${i + 1}`,
    hits: 3
  }));

  const recs = evaluateRules({
    project,
    stats: [stat],
    ownCitedByPrompt: new Map(),
    sourceRows: [
      { domain: 'keyspacerealty.com', n: 45, prompts: 15, sample_url: questions[0].url,
        sample_question: questions[0].question, questions }
    ]
  });

  const r = recs.find((x) => x.evidence.domain === 'keyspacerealty.com');
  assert.ok(r, 'the rule must fire');
  assert.equal(r.evidence.prompts, 15);
  assert.equal(r.evidence.questions.length, 15, 'the count and the list must agree');
  assert.ok(r.evidence.questions.every((q) => q.question && q.url), 'each needs a question and a page');
});

await test('the question list is capped so a row cannot grow unbounded', () => {
  const project = { id: 1, brand_name: 'X', domain: 'x.com' };
  const many = Array.from({ length: 80 }, (_, i) => ({ question: `q${i}`, url: `https://y.com/${i}`, hits: 1 }));

  const recs = evaluateRules({
    project,
    stats: [{
      prompt_id: 1, text: 'q', cluster: 'c', ai_search_volume: 100, engine: 'chatgpt',
      entity_id: 1, name: 'X', kind: 'owned', domain: 'x.com',
      runs: 3, hits: 1, avg_ordinal: 3, negatives: 0, snippet: null, sample_run: 1
    }],
    ownCitedByPrompt: new Map(),
    sourceRows: [{ domain: 'y.com', n: 80, prompts: 80, sample_url: 'https://y.com/0', sample_question: 'q0', questions: many }]
  });

  const r = recs.find((x) => x.evidence.domain === 'y.com');
  assert.equal(r.evidence.questions.length, 25);
  assert.equal(r.evidence.prompts, 80, 'the true count is still reported');
});

await test('named but not cited names who took the click', () => {
  const project = { id: 1, brand_name: 'Arada', domain: 'arada.com' };
  const q = 'Which area is best for families in Sharjah?';
  const stat = (o) => ({
    prompt_id: 1, text: q, cluster: 'area-guide', ai_search_volume: 2600, engine: 'chatgpt',
    entity_id: 1, name: 'Arada', kind: 'owned', domain: 'arada.com',
    runs: 3, hits: 2, avg_ordinal: 2, negatives: 0, snippet: null, sample_run: 1, ...o
  });

  const recs = evaluateRules({
    project,
    stats: [stat({}), stat({ entity_id: 2, name: 'Emaar', kind: 'competitor', domain: 'emaar.com', hits: 1 })],
    ownCitedByPrompt: new Map(),
    citedByPrompt: new Map([[1, [
      { domain: 'bayut.com', url: 'https://www.bayut.com/x', position: 1 },
      { domain: 'rhkproperties.com', url: 'https://rhkproperties.com/y', position: 2 }
    ]]])
  });

  const r = recs.find((x) => x.type === 'citable_asset');
  assert.ok(r, 'the rule must fire when named but never cited');
  assert.ok(/bayut\.com/.test(r.action), 'say who got the click');
  assert.deepEqual(r.evidence.took_the_citation.map((t) => t.domain), ['bayut.com', 'rhkproperties.com']);

  // A property portal is a portal, not an editorial site, and the advice
  // differs: claim the listing rather than pitch a contribution.
  assert.equal(r.evidence.took_the_citation[0].kind, 'directory');
  assert.ok(/listing there is accurate/i.test(r.action));

  // The split that makes this actionable rather than generic.
  assert.ok(/only you can verify/i.test(r.action));
  assert.ok(/never be trusted on/i.test(r.action));
});

const project = { id: 1, brand_name: 'Sandstorm Digital', domain: 'sandstormdigital.com' };

const stat = (o) => ({
  prompt_id: 1, text: 'Which SEO agency is best for a UK ecommerce brand?', cluster: 'best-of',
  ai_search_volume: 400, engine: 'chatgpt', entity_id: 1, name: 'Sandstorm Digital',
  kind: 'owned', domain: 'sandstormdigital.com', runs: 3, hits: 0, avg_ordinal: null,
  negatives: 0, snippet: null, sample_run: 10, ...o
});

await test('content_gap fires on zero visibility', () => {
  const recs = evaluateRules({ project, stats: [stat({ hits: 0 })] });
  const r = recs.find((x) => x.type === 'content_gap');
  assert.ok(r, 'rule fired');
  assert.ok(r.priority > 0);
  assert.equal(r.evidence.prompt_id, 1);
});

await test('citable_asset fires when named but never cited', () => {
  const recs = evaluateRules({ project, stats: [stat({ hits: 3 })] });
  assert.ok(recs.find((x) => x.type === 'citable_asset'));
  assert.equal(recs.find((x) => x.type === 'content_gap'), undefined, 'content_gap must not also fire');
});

await test('entity_authority fires when cited but not named', () => {
  const recs = evaluateRules({
    project,
    stats: [stat({ hits: 1 })],
    ownCitedByPrompt: new Map([[1, 4]])
  });
  assert.ok(recs.find((x) => x.type === 'entity_authority'));
});

await test('ordinal_push fires when buried down the list', () => {
  const recs = evaluateRules({ project, stats: [stat({ hits: 3, avg_ordinal: 4.2 })], ownCitedByPrompt: new Map([[1, 1]]) });
  const r = recs.find((x) => x.type === 'ordinal_push');
  assert.ok(r);
  assert.equal(r.evidence.avg_ordinal, 4.2);
});

await test('competitor_comparison fires on a clear lead', () => {
  const recs = evaluateRules({
    project,
    stats: [
      stat({ hits: 0 }),
      stat({ entity_id: 2, name: 'Impression', kind: 'competitor', domain: 'impression.co.uk', hits: 3 })
    ]
  });
  const r = recs.find((x) => x.type === 'competitor_comparison');
  assert.ok(r);
  assert.equal(r.evidence.competitor, 'Impression');
  assert.equal(r.evidence.competitor_rate, 100);
});

await test('one comparison action per rival, however many questions they win', () => {
  const stats = [];
  for (let i = 1; i <= 5; i++) {
    stats.push(stat({ prompt_id: i, text: `q${i}`, ai_search_volume: i * 100, hits: 0 }));
    stats.push(stat({ prompt_id: i, text: `q${i}`, ai_search_volume: i * 100, entity_id: 2, name: 'Impression', kind: 'competitor', hits: 3 }));
  }
  const recs = evaluateRules({ project, stats });
  const comps = recs.filter((x) => x.type === 'competitor_comparison');
  assert.equal(comps.length, 1, 'rolled up, not one per question');
  assert.equal(comps[0].evidence.questions.length, 5);
  assert.ok(comps[0].title.includes('5 questions'));
});

await test('priorities spread even when every volume estimate is high', () => {
  const stats = [];
  const volumes = [5000, 4800, 4600, 4400, 4200];
  volumes.forEach((v, i) => stats.push(stat({ prompt_id: i + 1, text: `q${i}`, ai_search_volume: v, hits: 0 })));
  const recs = evaluateRules({ project, stats });
  const priorities = new Set(recs.map((r) => r.priority));
  assert.ok(priorities.size >= 4, `expected a spread, got ${[...priorities].join(', ')}`);
  assert.ok(Math.max(...priorities) > Math.min(...priorities) * 2, 'top action clearly outranks the bottom');
});

await test('no more than two actions per question', () => {
  const stats = [
    stat({ hits: 1, avg_ordinal: 4.5, negatives: 1, snippet: 'mixed reviews' }),
    stat({ entity_id: 2, name: 'Impression', kind: 'competitor', hits: 3 })
  ];
  const recs = evaluateRules({
    project, stats,
    priorRates: new Map([[1, 0.9]]),
    fanOutByPrompt: new Map([[1, [{ query: 'test query', n: 3 }]]])
  });
  const forPrompt1 = recs.filter((r) => r.evidence.prompt_id === 1);
  assert.ok(forPrompt1.length <= 2, `got ${forPrompt1.length} actions for one question`);
});

await test('content gap absorbs the fan-out query instead of duplicating it', () => {
  const recs = evaluateRules({
    project,
    stats: [stat({ hits: 0 })],
    fanOutByPrompt: new Map([[1, [{ query: 'best seo agency dubai 2024', n: 3 }]]])
  });
  const gap = recs.find((x) => x.type === 'content_gap');
  assert.ok(gap.action.includes('best seo agency dubai 2024'), 'query folded into the gap action');
  assert.equal(recs.find((x) => x.type === 'fanout_target'), undefined, 'no separate duplicate action');
});

await test('engine_gap fires when one engine is blind to you', () => {
  const recs = evaluateRules({
    project,
    stats: [
      stat({ engine: 'chatgpt', hits: 3 }),
      stat({ engine: 'perplexity', hits: 0 })
    ],
    ownCitedByPrompt: new Map([[1, 1]])
  });
  const r = recs.find((x) => x.type === 'engine_gap');
  assert.ok(r);
  assert.equal(r.evidence.worst, 'perplexity');
  assert.ok(/PerplexityBot/i.test(r.action), 'gives the engine-specific fix');
});

await test('sentiment_correction carries the excerpt as evidence', () => {
  const recs = evaluateRules({
    project,
    stats: [stat({ hits: 2, negatives: 1, snippet: 'mixed reviews about reporting' })],
    ownCitedByPrompt: new Map([[1, 1]])
  });
  const r = recs.find((x) => x.type === 'sentiment_correction');
  assert.ok(r);
  assert.equal(r.evidence.snippet, 'mixed reviews about reporting');
});

await test('decline_alert fires on a real drop only', () => {
  const dropped = evaluateRules({ project, stats: [stat({ hits: 0 })], priorRates: new Map([[1, 0.9]]) });
  assert.ok(dropped.find((x) => x.type === 'decline_alert'));
  const steady = evaluateRules({ project, stats: [stat({ hits: 0 })], priorRates: new Map([[1, 0.05]]) });
  assert.equal(steady.find((x) => x.type === 'decline_alert'), undefined);
});

await test('source_gap names the domain and skips your own', () => {
  const recs = evaluateRules({
    project,
    stats: [stat({ hits: 3 })],
    sourceRows: [
      { domain: 'clutch.co', n: 9, prompts: 5, sample_url: 'https://clutch.co/uk' },
      { domain: 'sandstormdigital.com', n: 4, prompts: 3, sample_url: 'https://sandstormdigital.com' },
      { domain: 'oneoff.com', n: 1, prompts: 1, sample_url: 'https://oneoff.com' }
    ]
  });
  const gaps = recs.filter((x) => x.type === 'source_gap');
  assert.equal(gaps.length, 1, 'own domain and single-prompt sources excluded');
  assert.equal(gaps[0].evidence.domain, 'clutch.co');
  assert.ok(/claim/i.test(gaps[0].action), 'aggregators get the profile-claim action');
});

await test('replicate_winner fires on an above-average converting page', () => {
  const recs = evaluateRules({
    project,
    stats: [stat({ hits: 3 })],
    ownCitedByPrompt: new Map([[1, 1]]),
    ga4: [
      { landing_page: '/seo-audit', sessions: 100, conversions: 20, revenue: 8000 },
      { landing_page: '/blog/x', sessions: 400, conversions: 8, revenue: 0 }
    ]
  });
  const r = recs.find((x) => x.type === 'replicate_winner');
  assert.ok(r);
  assert.equal(r.target_url, '/seo-audit');
});

await test('output is sorted by priority and every rec is actionable', () => {
  const recs = evaluateRules({
    project,
    stats: [
      stat({ hits: 0 }),
      stat({ prompt_id: 2, text: 'q2', ai_search_volume: 20, hits: 0 }),
      stat({ entity_id: 2, name: 'Impression', kind: 'competitor', hits: 3 })
    ],
    sourceRows: [{ domain: 'reddit.com', n: 12, prompts: 6, sample_url: 'https://reddit.com/r/bigseo' }]
  });
  for (let i = 1; i < recs.length; i++) {
    assert.ok(recs[i - 1].priority >= recs[i].priority, 'sorted by priority');
  }
  for (const r of recs) {
    assert.ok(r.action.length > 80, `action is specific: ${r.type}`);
    assert.ok(r.effort >= 1 && r.effort <= 5);
    assert.ok(Number.isFinite(r.priority));
  }
  assert.ok(recs.find((x) => x.evidence.prompt_id === 1).priority > recs.find((x) => x.evidence.prompt_id === 2).priority,
    'higher volume question outranks lower volume one');
});

await test('fanout_target stands alone when partly visible', () => {
  const recs = evaluateRules({
    project,
    stats: [stat({ hits: 1 })],
    ownCitedByPrompt: new Map([[1, 2]]),
    fanOutByPrompt: new Map([[1, [{ query: 'best SEO agency for UK ecommerce brand 2024', n: 3 }]]])
  });
  const r = recs.find((x) => x.type === 'fanout_target');
  assert.ok(r, 'rule fired');
  assert.ok(r.action.includes('best SEO agency for UK ecommerce brand 2024'));
  assert.deepEqual(r.evidence.queries, ['best SEO agency for UK ecommerce brand 2024']);
});

await test('fanout_target stays quiet when visibility is already strong', () => {
  const recs = evaluateRules({
    project,
    stats: [stat({ hits: 3 })],
    ownCitedByPrompt: new Map([[1, 2]]),
    fanOutByPrompt: new Map([[1, [{ query: 'x y z', n: 3 }]]])
  });
  assert.equal(recs.find((x) => x.type === 'fanout_target'), undefined);
});

console.log('\nlive payload parsing');

await test('parses the verified ChatGPT payload shape', async () => {
  const fixture = {
    tasks: [{ status_code: 20000, cost: 0.029556, result: [{
      model_name: 'gpt-4.1-mini-2025-04-14',
      fan_out_queries: ['best SEO agency for UK ecommerce brand 2024'],
      items: [{ type: 'message', sections: [{ type: 'text',
        text: 'Try [ClickSlice](https://www.clickslice.co.uk/?utm_source=openai) or [NOVOS](https://thisisnovos.com/?utm_source=openai).',
        annotations: [
          { title: 'ClickSlice', url: 'https://www.clickslice.co.uk/?utm_source=openai', start_index: 4, end_index: 60 },
          { title: 'NOVOS', url: 'https://thisisnovos.com/?utm_source=openai', start_index: 65, end_index: 110 }
        ] }] }]
    }] }]
  };
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => fixture });
  process.env.MOCK_MODE = 'false';
  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  const { askEngine: live } = await import('../src/lib/dataforseo.js?live=1');
  const a = await live({ engine: 'chatgpt', prompt: 'test' });
  global.fetch = realFetch;

  assert.equal(a.ok, true);
  assert.equal(a.model, 'gpt-4.1-mini-2025-04-14', 'captures the exact model version');
  assert.equal(a.costUsd, 0.029556);
  assert.deepEqual(a.fanOut, ['best SEO agency for UK ecommerce brand 2024']);
  assert.equal(a.citations.length, 2);
  assert.equal(a.citations[0].url, 'https://www.clickslice.co.uk/', 'tracking params stripped');
  assert.equal(a.citations[0].domain, 'clickslice.co.uk');
  assert.equal(a.citations[0].position, 1, 'ordered by position in the answer');
  assert.ok(!a.text.includes('[ClickSlice](https'.repeat(2)), 'annotation text not duplicated into the body');
});

console.log('\nsite scanning');

const SAMPLE = `<html><head>
<title>Sandstorm Digital | SEO &amp; PPC Agency Manchester</title>
<meta name="description" content="Award-winning SEO agency helping UK ecommerce brands grow.">
<script type="application/ld+json">{"@type":"Organization","name":"Sandstorm Digital Ltd","address":{"addressLocality":"Manchester"},"sameAs":["https://linkedin.com/company/x"]}</script>
</head><body><nav>navigation junk</nav><h1>Organic growth for ecommerce</h1><h2>SEO &amp; PPC</h2>
<p>We work with UK retailers.</p><footer>footer junk</footer><script>var x=1;</script></body></html>`;

await test('normalises whatever domain form is pasted in', () => {
  assert.equal(normaliseDomain('https://www.Sandstormdigital.com/about?x=1'), 'sandstormdigital.com');
  assert.equal(normaliseDomain('SANDSTORMDIGITAL.COM'), 'sandstormdigital.com');
  assert.equal(normaliseDomain(''), '');
});

await test('pulls the stated facts off a homepage', () => {
  const s = readSignals(SAMPLE);
  assert.equal(s.schemaName, 'Sandstorm Digital Ltd');
  assert.equal(s.schemaType, 'Organization');
  assert.equal(s.address, 'Manchester');
  assert.equal(s.h1, 'Organic growth for ecommerce');
  assert.equal(s.sameAs.length, 1);
});

await test('decodes entities rather than leaving raw markup', () => {
  const s = readSignals(SAMPLE);
  assert.ok(s.title.includes('SEO & PPC'), `got: ${s.title}`);
  assert.ok(!s.title.includes('&amp;'));
  assert.equal(s.h2s[0], 'SEO & PPC');
});

await test('strips scripts, nav and footer from the body text', () => {
  const s = readSignals(SAMPLE);
  assert.ok(!/var x=1|navigation junk|footer junk/.test(s.body), `leaked: ${s.body}`);
  assert.ok(s.body.includes('UK retailers'));
});

await test('escalates to the renderer when a site blocks direct requests', async () => {
  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    if (String(url).includes('instant_pages')) {
      return { ok: true, json: async () => ({ tasks: [{ result: [{ items: [{
        url: 'https://blocked.com',
        meta: { title: 'Marina Smile Studio | Clear Aligners Dubai', description: 'Orthodontic clinic.',
                htags: { h1: ['Straighten your teeth'], h2: ['Pricing'] } }
      }] }] }] }) };
    }
    return { ok: false, status: 403 };
  };
  const { discoverSite } = await import('../src/lib/discover.js?blocked=1');
  const r = await discoverSite('blocked.com');
  global.fetch = realFetch;

  assert.equal(r.ok, true, 'a blocked site must still be readable');
  assert.equal(r.via, 'dataforseo');
  assert.ok(r.brandName.includes('Marina Smile'), `got ${r.brandName}`);
  assert.ok(seen.some((u) => String(u).includes('instant_pages')), 'the renderer must be tried');
});

await test('a site that cannot be read at all offers manual entry', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403 });
  const { discoverSite } = await import('../src/lib/discover.js?dead=1');
  const r = await discoverSite('impossible.com');
  global.fetch = realFetch;

  assert.equal(r.ok, false);
  assert.equal(r.manual, true, 'the caller needs to know it can fall back to a form');
  assert.ok(/by hand/i.test(r.error), 'the message must tell the person what to do next');
});

await test('survives malformed JSON-LD without throwing', () => {
  const s = readSignals('<html><script type="application/ld+json">{broken,,}</script><title>Fine</title></html>');
  assert.equal(s.title, 'Fine');
  assert.equal(s.schemaName, null);
});

console.log('\nsearch console diagnostics');

await test('each Google failure is diagnosed separately', async () => {
  process.env.GOOGLE_CLIENT_ID = 'x';
  process.env.GOOGLE_CLIENT_SECRET = 'y';
  process.env.GOOGLE_REFRESH_TOKEN = 'fake';
  const { listSites } = await import('../src/lib/gsc.js?diag=1');
  const realFetch = global.fetch;

  const run = async (status, message) => {
    global.fetch = async (url) => {
      if (String(url).includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'a' }) };
      return { ok: false, status, json: async () => ({ error: { message } }) };
    };
    try {
      await listSites({});
      return null;
    } catch (e) {
      return e;
    }
  };

  // A disabled API and a missing scope both come back as 403, and offering
  // "reconnect" for both is what sent people round in circles.
  const disabled = await run(403, 'Google Search Console API has not been used in project 123456789012 before or it is disabled.');
  assert.equal(disabled.fix, 'enable-api');
  assert.ok(disabled.link.includes('123456789012'), 'link straight to the right project');
  assert.ok(/not enabled/i.test(disabled.message));
  assert.ok(/Reconnecting will not help/i.test(disabled.message), 'must say what will not help');

  const scope = await run(403, 'Request had insufficient authentication scopes.');
  assert.equal(scope.fix, 'reconnect');
  assert.ok(/consent screen/i.test(scope.message), 'must mention registering the scope first');

  const expired = await run(401, 'Invalid Credentials');
  assert.equal(expired.fix, 'reconnect');

  const other = await run(500, 'Backend error');
  assert.equal(other.fix, undefined, 'unknown failures must not claim a fix');

  global.fetch = realFetch;
});

await test('a connection made before the scope existed is spotted without an API call', async () => {
  const { hasSearchConsoleScope } = await import('../src/lib/ga4.js?scopes=1');
  assert.equal(hasSearchConsoleScope({ google_scopes: 'openid email https://www.googleapis.com/auth/analytics.readonly' }), false);
  assert.equal(hasSearchConsoleScope({ google_scopes: 'https://www.googleapis.com/auth/webmasters.readonly' }), true);
  assert.equal(hasSearchConsoleScope({ google_scopes: null }), null, 'unknown means let the API decide');
});

console.log('\nsearch console import');

const gsc = await import('../src/lib/gsc.js');

const GSC_ROWS = [
  { query: 'clear aligners dubai', impressions: 2400, clicks: 88, position: 6.2 },
  { query: 'clear aligners dubai cost', impressions: 1800, clicks: 52, position: 8.1 },
  { query: 'how much do clear aligners cost in dubai', impressions: 1400, clicks: 61, position: 5.5 },
  { query: 'aligners dubai price', impressions: 900, clicks: 20, position: 9.4 },
  { query: 'best orthodontist dubai marina', impressions: 1100, clicks: 44, position: 7.0 },
  { query: 'which orthodontist is best in dubai marina', impressions: 300, clicks: 18, position: 6.0 },
  { query: 'invisible braces vs aligners', impressions: 700, clicks: 19, position: 12.0 },
  { query: 'marina smile studio', impressions: 1500, clicks: 600, position: 1.1 },
  { query: 'marina smile studio contact', impressions: 300, clicks: 180, position: 1.0 },
  { query: 'x', impressions: 2, clicks: 0, position: 40 }
];

await test('branded and negligible queries are excluded', () => {
  const clusters = gsc.cluster(GSC_ROWS, { brand: 'Marina Smile Studio' });
  const heads = clusters.map((c) => c.head);
  assert.ok(!heads.some((h) => /marina smile/i.test(h)), 'branded searches measure nothing here');
  assert.ok(!heads.includes('x'), 'a two-impression query is noise');
});

await test('variants of one intent become one cluster', () => {
  const clusters = gsc.cluster(GSC_ROWS, { brand: 'Marina Smile Studio' });
  const aligners = clusters.find((c) => /aligner/i.test(c.head));
  assert.ok(aligners.variants >= 3, 'the aligner queries belong together');
  assert.equal(aligners.impressions, 5600, 'cluster impressions sum the variants');
});

await test('the most conversational variant becomes the question', () => {
  const clusters = gsc.cluster(GSC_ROWS, { brand: 'Marina Smile Studio' });

  // "clear aligners dubai" has the most impressions, but it is a keyword.
  // The phrased question is what an assistant actually receives.
  assert.equal(clusters[0].head, 'how much do clear aligners cost in dubai');
  assert.equal(clusters[0].conversational, 2);

  const ortho = clusters.find((c) => /orthodontist/i.test(c.head));
  assert.equal(ortho.head, 'which orthodontist is best in dubai marina',
    'a 300-impression phrased question beats an 1,100-impression keyword');
});

await test('impressions carry through as the volume figure', async () => {
  const clusters = gsc.cluster(GSC_ROWS, { brand: 'Marina Smile Studio' });
  const proposed = await gsc.proposeFromClusters(clusters, { brand: 'Marina Smile Studio', market: 'AE' });

  assert.ok(proposed.length >= 3, 'should propose something without a model');
  for (const p of proposed) {
    assert.ok(p.impressions > 0, 'real demand, not an estimate');
    assert.ok(p.examples.length, 'the original queries must be shown');
    assert.ok(!/marina smile/i.test(p.text), 'never put the brand in the question');
  }
  assert.equal(proposed[0].impressions, 5600);
});

console.log('\nsource classification and teardown');

const td = await import('../src/lib/teardown.js');

await test('a source you cannot appear on is classified as such', () => {
  const ctx = { ownDomain: 'sandstormdigital.com', competitorDomains: ['digitalgravity.ae', 'nexa.ae'] };
  const k = (d) => td.classifySource(d, ctx);

  assert.equal(k('sandstormdigital.com').kind, 'own');
  assert.equal(k('www.digitalgravity.ae').kind, 'competitor');
  assert.equal(k('digitalgravity.ae').reachable, false, 'you can never get listed on a competitor site');
  assert.equal(k('clutch.co').kind, 'directory');
  assert.equal(k('reddit.com').kind, 'community');
  assert.equal(k('en.wikipedia.org').reachable, false);
  assert.equal(k('medium.com').kind, 'publisher');
  assert.equal(k('someblog.co.uk').kind, 'editorial');
});

await test('advice differs by source, and never says to pitch a competitor', () => {
  const project = { id: 1, brand_name: 'Sandstorm Digital', domain: 'sandstormdigital.com' };
  const q = 'Which SEO agency is best for an ecommerce brand in the UAE?';
  const base = { prompt_id: 1, text: q, cluster: 'best-of', ai_search_volume: 2400, engine: 'chatgpt',
    entity_id: 1, name: 'Sandstorm Digital', kind: 'owned', domain: 'sandstormdigital.com',
    runs: 3, hits: 1, avg_ordinal: 3, negatives: 0, snippet: null, sample_run: 1 };

  const recs = evaluateRules({
    project,
    stats: [base, { ...base, entity_id: 2, name: 'Digital Gravity', kind: 'competitor', domain: 'digitalgravity.ae', hits: 3 }],
    ownCitedByPrompt: new Map([[1, 1]]),
    sourceRows: [
      { domain: 'digitalgravity.ae', n: 9, prompts: 4, sample_url: 'https://digitalgravity.ae/seo', sample_question: q },
      { domain: 'clutch.co', n: 8, prompts: 4, sample_url: 'https://clutch.co/ae', sample_question: q },
      { domain: 'reddit.com', n: 6, prompts: 3, sample_url: 'https://reddit.com/r/dubai', sample_question: q }
    ]
  });

  const byDomain = Object.fromEntries(
    recs.filter((r) => r.evidence.domain).map((r) => [r.evidence.domain, r])
  );

  assert.equal(byDomain['digitalgravity.ae'].type, 'competitor_page');
  assert.ok(!/pitch|contribut|request inclusion|get listed on it\b/i.test(byDomain['digitalgravity.ae'].action.replace('there is no version of this where you get listed on it', '')),
    'must not suggest getting onto a competitor site');
  assert.ok(/teardown|why that page/i.test(byDomain['digitalgravity.ae'].action));

  assert.ok(/claim/i.test(byDomain['clutch.co'].action), 'a directory should say claim the profile');
  assert.ok(/downvoted|honestly|real account/i.test(byDomain['reddit.com'].action), 'community advice must warn against planting');

  // Things you can act on should outrank things you cannot.
  assert.ok(byDomain['clutch.co'].priority > byDomain['digitalgravity.ae'].priority);

  // Every source action carries what the teardown needs.
  for (const r of recs.filter((x) => x.evidence.domain)) {
    assert.ok(r.evidence.sourceKind, 'source kind must be recorded');
    assert.ok(r.evidence.url && r.evidence.question, 'the teardown needs a page and a question');
  }
});

await test('the structural read finds what plausibly earned a citation', () => {
  const html = `<html><head>
    <title>Best SEO Agencies in Dubai 2026</title>
    <script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"x"}]}</script>
    <meta property="article:modified_time" content="2026-07-28T10:00:00Z">
    </head><body>
    <h1>Best SEO Agencies in Dubai</h1>
    <h2>Which SEO agency is best for an ecommerce brand in the UAE?</h2>
    <p>For UAE ecommerce, look for Arabic capability and regional case studies.</p>
    <h2>How much does SEO cost in Dubai?</h2>
    <p>Retainers run AED 8,000 to AED 25,000, about 45% higher than 2024.</p>
    <table><tr><td>a</td></tr></table><ul><li>b</li></ul>
    <div rel="author">By Sara N</div></body></html>`;

  const st = td.readStructure(html, 'Which SEO agency is best for an ecommerce brand in the UAE?');
  assert.equal(st.headingsMatchingQuestion.length, 1, 'should spot the heading mirroring the question');
  assert.equal(st.hasFaqSchema, true);
  assert.equal(st.hasAuthor, true);
  assert.equal(st.tables, 1);
  assert.ok(st.statMentions >= 2, 'should count prices and percentages');
  assert.ok(st.publishedOrUpdated.startsWith('2026-07-28'));
});

await test('the explanation parser accepts whatever shape the model returns', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/lib/teardown.js', import.meta.url), 'utf8');
  const parse = new Function('raw', src.match(/function parseExplanation\(raw\)[\s\S]*?\n\}/)[0] + '; return parseExplanation(raw);');

  // A bare object is at least as common as an array, and demanding one shape
  // was throwing away valid answers.
  assert.ok(parse('[{"why":["a"],"actions":[{"do":"x"}]}]'), 'array');
  assert.ok(parse('{"why":["a"],"actions":[{"do":"x"}]}'), 'bare object');
  assert.ok(parse('```json\n{"why":["a"],"actions":[{"do":"x"}]}\n```'), 'fenced');
  assert.ok(parse('Here it is:\n{"why":["a"],"actions":[{"do":"x"}]}'), 'with preamble');

  const strings = parse('{"why":["a"],"actions":["do this"]}');
  assert.equal(strings.actions[0].do, 'do this', 'actions given as plain strings');

  const alt = parse('{"why":["a"],"actions":[{"action":"x","why":"y"}]}');
  assert.equal(alt.actions[0].do, 'x', 'alternative key names');

  assert.equal(parse('I could not analyse this page.'), null);
  assert.equal(parse(''), null);
});

await test('a teardown produces real advice with no model at all', async () => {
  const html = `<html><head><title>Best SEO Agencies in Dubai 2026</title>
    <script type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script>
    <meta property="article:modified_time" content="2026-07-28T10:00:00Z"></head><body>
    <h2>Which SEO agency is best for an ecommerce brand in the UAE?</h2>
    <p>Retainers run AED 8,000 to AED 25,000, 45% higher than 2024, with 30% charging more.</p>
    <table><tr><td>a</td></tr></table></body></html>`;
  const q = 'Which SEO agency is best for an ecommerce brand in the UAE?';

  const st = td.readStructure(html, q);
  const d = td.deterministicExplanation(st, 'competitor');

  assert.ok(d.why.length >= 3, 'must explain itself without a model');
  assert.ok(d.actions.length >= 3, 'must still give actions');
  assert.ok(d.why.some((w) => /heading/i.test(w)));
  assert.ok(d.actions.some((a) => /FAQPage schema/i.test(a.do)));
  assert.ok(d.actions.some((a) => /table/i.test(a.do)));

  // And a page with nothing notable must say so rather than invent a reason.
  const bare = td.readStructure('<html><head><title>Home</title></head><body><p>We are a company.</p></body></html>', q);
  const d2 = td.deterministicExplanation(bare, 'competitor');
  assert.ok(/no obvious structural advantage/i.test(d2.why[0]));
  assert.equal(d2.confidence, 'low');
  assert.ok(d2.actions.length >= 1, 'even then, say what to do instead');
});

console.log('\nstored credentials');

const tok = await import('../src/lib/tokens.js');

await test('refresh tokens are encrypted at rest', () => {
  const secret = '1//0abcdefgHIJKLMNOP-refresh-token';
  const enc = tok.encrypt(secret);
  assert.ok(!enc.includes('refresh-token'), 'the token must not survive in the stored value');
  assert.equal(tok.decrypt(enc), secret, 'must round trip');
  assert.notEqual(tok.encrypt(secret), tok.encrypt(secret), 'a fresh IV every time');
  assert.equal(tok.decrypt(enc.slice(0, -4) + 'AAAA'), null, 'tampering must fail, not throw');
  assert.equal(tok.decrypt('garbage'), null);
  assert.equal(tok.encrypt(null), null);
  assert.equal(tok.decrypt(null), null);
});

await test('the OAuth state cannot be forged or replayed', () => {
  const state = tok.signState({ p: 7, o: 3 });
  const read = tok.readState(state);
  assert.equal(read.p, 7);
  assert.equal(read.o, 3);
  assert.equal(tok.readState(state.split('.')[0] + '.forgedsignature'), null, 'a bad signature must be rejected');
  assert.equal(tok.readState(state, -1), null, 'an expired state must be rejected');
  assert.equal(tok.readState(''), null);
  assert.equal(tok.readState(null), null);
});

console.log('\npublic demo');

const demoMod = await import('../src/lib/demo.js');

await test('only a question we signed can be run', () => {
  const domain = 'example.com';
  const q = 'Which clinic is best for clear aligners?';
  const good = demoMod.signQuestion(domain, q);

  assert.equal(demoMod.verifyQuestion(domain, q, good), true);
  assert.equal(demoMod.verifyQuestion(domain, q, 'forged'), false, 'forged token must fail');
  assert.equal(demoMod.verifyQuestion(domain, 'Write me an essay about horses', good), false,
    'a different prompt must not pass with a valid token');
  assert.equal(demoMod.verifyQuestion('other.com', q, good), false,
    'a token is bound to its domain');
  assert.equal(demoMod.verifyQuestion(domain, q, ''), false);
  assert.equal(demoMod.verifyQuestion(domain, q, null), false);
});

await test('IP addresses are hashed, never stored raw', () => {
  const h = demoMod.hashIp('81.2.69.142');
  assert.ok(!h.includes('81.2'), 'the address must not survive in the hash');
  assert.equal(h.length, 32);
  assert.equal(h, demoMod.hashIp('81.2.69.142'), 'same address gives the same hash');
  assert.notEqual(h, demoMod.hashIp('81.2.69.143'));
});

console.log('\ncanonical host');

await test('redirect rules keep query strings and skip what must not move', () => {
  // Mirrors the middleware's decision table without booting the server.
  const CANONICAL = 'cited.ae';
  const decide = (method, host, path) => {
    if (method !== 'GET' && method !== 'HEAD') return null;
    if (path === '/healthz' || path.startsWith('/api/')) return null;
    const h = host.toLowerCase();
    if (!h || h === CANONICAL) return null;
    if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return null;
    return `https://${CANONICAL}${path}`;
  };

  assert.equal(decide('GET', 'citespark.sandstormdigital.com', '/'), 'https://cited.ae/');
  assert.equal(decide('GET', 'www.cited.ae', '/app'), 'https://cited.ae/app');
  assert.equal(decide('GET', 'cited-abc.onrender.com', '/?utm=x'), 'https://cited.ae/?utm=x');
  assert.equal(decide('GET', 'cited.ae', '/'), null, 'canonical host must pass through');
  assert.equal(decide('GET', 'localhost', '/'), null, 'local development must not redirect');
  assert.equal(decide('GET', 'old.example.com', '/healthz'), null, 'health checks must not redirect');
  assert.equal(decide('POST', 'old.example.com', '/api/stripe/webhook'), null, 'a redirected POST would break the webhook');
  assert.equal(decide('GET', 'old.example.com', '/api/version'), null, 'API clients are left alone');
});

console.log('\nrequest shaping and retries');

await test('model_name is always sent, because the API requires it', async () => {
  process.env.MOCK_MODE = 'false';
  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  const { askEngine: live } = await import('../src/lib/dataforseo.js?models=1');

  const MODELS = {
    chat_gpt: [
      { model_name: 'o4-mini', reasoning: true, web_search_supported: true },
      { model_name: 'gpt-4.1-nosearch', reasoning: false, web_search_supported: false },
      { model_name: 'gpt-4.1-mini', reasoning: false, web_search_supported: true }
    ],
    perplexity: [
      { model_name: 'sonar-reasoning-pro', reasoning: true, web_search_supported: true },
      { model_name: 'sonar', reasoning: false, web_search_supported: true }
    ]
  };

  const sent = {};
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const se = url.split('/ai_optimization/')[1].split('/')[0];
    if (url.endsWith('/models')) return { ok: true, json: async () => ({ tasks: [{ result: MODELS[se] }] }) };
    sent[se] = JSON.parse(opts.body)[0];
    return { ok: true, json: async () => ({ tasks: [{ status_code: 20000, result: [{ items: [{ sections: [{ text: 'ok' }] }] }] }] }) };
  };

  await live({ engine: 'chatgpt', prompt: 'test', market: 'AE' });
  await live({ engine: 'perplexity', prompt: 'test', market: 'AE' });
  global.fetch = realFetch;

  assert.ok(sent.chat_gpt.model_name, 'model_name must always be sent');
  assert.ok(sent.perplexity.model_name, 'model_name must always be sent');

  // A model without web search returns no citations, which is the product.
  assert.notEqual(sent.chat_gpt.model_name, 'gpt-4.1-nosearch');
  assert.equal(sent.chat_gpt.model_name, 'gpt-4.1-mini', 'prefer non-reasoning with web search');
  assert.equal(sent.perplexity.model_name, 'sonar');
});

await test('a broken models endpoint falls back rather than failing', async () => {
  process.env.MOCK_MODE = 'false';
  const { askEngine: live } = await import('../src/lib/dataforseo.js?fallback=1');
  let sent = null;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url.endsWith('/models')) return { ok: false, status: 500 };
    sent = JSON.parse(opts.body)[0];
    return { ok: true, json: async () => ({ tasks: [{ status_code: 20000, result: [{ items: [{ sections: [{ text: 'ok' }] }] }] }] }) };
  };
  const r = await live({ engine: 'chatgpt', prompt: 'test' });
  global.fetch = realFetch;

  assert.equal(r.ok, true, 'a listing failure must not break the call');
  assert.ok(sent.model_name, 'a fallback model must still be sent');
});

await test('sends only the fields each endpoint accepts', async () => {
  process.env.MOCK_MODE = 'false';
  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  const { askEngine: live } = await import('../src/lib/dataforseo.js?fields=1');
  const sent = {};
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    sent[url.split('/').slice(-3)[0]] = JSON.parse(opts.body)[0];
    return { ok: true, json: async () => ({ tasks: [{ status_code: 20000, result: [{ items: [{ sections: [{ text: 'ok' }] }] }] }] }) };
  };
  for (const e of ['chatgpt', 'gemini', 'claude', 'perplexity']) {
    await live({ engine: e, prompt: 'test', market: 'AE' });
  }
  global.fetch = realFetch;

  // Claude rejects this field outright, which silently killed a whole engine.
  assert.equal(sent.claude.web_search_country_iso_code, undefined,
    'claude must not be sent web_search_country_iso_code');
  assert.equal(sent.chat_gpt.web_search_country_iso_code, 'AE');

  // model_name is required on every call.
  for (const k of Object.keys(sent)) {
    assert.ok(sent[k].model_name, `${k} must send model_name`);
  }
});

await test('retries transient failures but not permanent ones', async () => {
  process.env.MOCK_MODE = 'false';
  process.env.ENGINE_RETRIES = '2';
  const { askEngine: live } = await import('../src/lib/dataforseo.js?retry=1');
  const realFetch = global.fetch;

  // Resolving the model list is a separate request, so count only the calls
  // to the endpoint under test.
  const run = async (responder) => {
    let calls = 0;
    global.fetch = async (url) => {
      if (String(url).endsWith('/models')) return { ok: false, status: 500 };
      calls++;
      return responder();
    };
    await live({ engine: 'chatgpt', prompt: 'x' });
    return calls;
  };

  const transient = await run(() => ({ ok: true, json: async () => ({ tasks: [{ status_code: 50000, status_message: 'Internal SE Server Error.' }] }) }));
  assert.equal(transient, 3, 'transient failures get 1 attempt plus 2 retries');

  const permanent = await run(() => ({ ok: true, json: async () => ({ tasks: [{ status_code: 40501, status_message: "Invalid Field: 'model_name'." }] }) }));
  assert.equal(permanent, 1, 'a rejected field will fail identically every time, so do not retry');

  const unauthorised = await run(() => ({ ok: false, status: 401 }));
  assert.equal(unauthorised, 1, 'bad credentials must not be retried');

  const serverError = await run(() => ({ ok: false, status: 503 }));
  assert.equal(serverError, 3, 'upstream 5xx is worth retrying');

  global.fetch = realFetch;
});

console.log('\nstudy page');

await test('the developers page is not published or linked', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../src/public/property-developers.html', import.meta.url), 'utf8');
  const robots = readFileSync(new URL('../src/public/robots.txt', import.meta.url), 'utf8');
  const sitemap = readFileSync(new URL('../src/public/sitemap.xml', import.meta.url), 'utf8');

  // Live at its URL, but not promoted: the numbers are not ready to be a
  // public claim about named companies.
  assert.ok(/noindex/.test(html), 'the page must not be indexed');
  assert.ok(/Disallow: \/uae\/property-developers/.test(robots));
  assert.ok(!sitemap.includes('property-developers'), 'and must not be in the sitemap');

  for (const f of ['landing', 'uae', 'mena']) {
    const page = readFileSync(new URL(`../src/public/${f}.html`, import.meta.url), 'utf8');
    assert.ok(!page.includes('/uae/property-developers'), `${f}.html still links to it`);
  }
});

await test('no headline names a single developer as best cited', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../src/public/study-page.js', import.meta.url), 'utf8');

  // Raw citation counts follow the question mix: a quarter of the questions
  // are Sharjah, where six developers compete rather than fifteen. Naming a
  // winner from that would be wrong, and worse when the leader is our client.
  assert.ok(!/Best-cited developer/.test(js), 'that figure was an artefact of the question mix');
  assert.ok(/Developers cited at all/.test(js), 'a count of who was cited at all is defensible');
  assert.ok(/question mix/i.test(js), 'and the caveat must appear on the sources table');
});

console.log('\ncross-account protection');

await test('only a properly signed Google token is acted upon', async () => {
  const { generateKeyPairSync, createSign } = await import('node:crypto');
  process.env.GOOGLE_CLIENT_ID = 'ours.apps.googleusercontent.com';

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  const risc = await import('../src/lib/risc.js?t=1');

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (claims, kid = 'k1') => {
    const h = b64({ alg: 'RS256', kid, typ: 'secevent+jwt' });
    const p = b64(claims);
    const sg = createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url');
    return `${h}.${p}.${sg}`;
  };

  const now = Math.floor(Date.now() / 1000);
  const base = {
    iss: 'https://accounts.google.com/',
    aud: 'ours.apps.googleusercontent.com',
    iat: now,
    jti: 'j1',
    events: { 'https://schemas.openid.net/secevent/risc/event-type/tokens-revoked': { subject: { email: 'a@b.com' } } }
  };
  const opts = { audience: 'ours.apps.googleusercontent.com' };

  // The endpoint is public, so the signature is the only authentication it
  // has. Each of these would otherwise let anyone disconnect a customer.
  await risc.verifyToken(sign(base), opts);

  const rejects = [
    ['wrong audience', sign({ ...base, aud: 'someone-else' })],
    ['wrong issuer', sign({ ...base, iss: 'https://evil.example/' })],
    ['unknown key', sign(base, 'not-a-key')],
    ['expired', sign({ ...base, exp: now - 600 })],
    ['not a jwt', 'garbage'],
    ['tampered', (() => { const t = sign(base).split('.'); t[1] = b64({ ...base, sub: 'attacker' }); return t.join('.'); })()]
  ];
  for (const [label, token] of rejects) {
    await assert.rejects(() => risc.verifyToken(token, opts), `${label} must be rejected`);
  }

  global.fetch = realFetch;
});

await test('the events that matter drop the credential', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/lib/risc.js', import.meta.url), 'utf8');

  // Losing a working connection is a smaller harm than holding a credential
  // for an account that has been taken over.
  for (const e of ['account-disabled', 'account-purged', 'sessions-revoked', 'tokens-revoked']) {
    assert.ok(src.includes(e), `${e} must be acted upon`);
  }
  const applied = src.slice(src.indexOf('export async function applyEvent'), src.indexOf('export async function logEvent'));
  assert.ok(/ga4_refresh_token = NULL/.test(applied), 'the stored token must be removed');
  assert.ok(/gsc_site_url = NULL/.test(applied), 'and the Search Console link with it');
});

console.log('\nbuyer personas');

const pers = await import('../src/lib/personas.js');

await test('a descriptor ending in a comma does not produce ",."', () => {
  const persona = {
    name: 'Alternative Investment Focused',
    descriptor: 'As an investor prioritizing private equity and alternative assets in the Gulf region,'
  };
  const out = pers.asPersona('How do I ensure confidentiality?', persona);

  // Stripping only full stops left "in the Gulf region,. How do I..." going
  // to the engines, which is what they were actually asked.
  assert.ok(!out.includes(',.'), 'the join must not leave a comma before the stop');
  assert.ok(out.includes('Gulf region. How do I'), 'and should read as a sentence');
});

await test('two buyer types asking the same thing are found', () => {
  const personas = [
    { name: 'A', descriptor: 'As an investor prioritizing private equity in the Gulf,' },
    { name: 'B', descriptor: 'As a specialist in private equity asset classes in the Gulf,' }
  ];
  const q = 'How do I ensure confidentiality with wealth advisors?';

  // Each version is stored with its descriptor prefixed, so the rows differ
  // and the uniqueness constraint never fires. The duplication is invisible
  // until somebody reads the list.
  const a = pers.asPersona(q, personas[0]);
  const b = pers.asPersona(q, personas[1]);
  assert.notEqual(a, b, 'the stored rows genuinely differ');
  assert.equal(pers.baseQuestion(a, personas), pers.baseQuestion(b, personas), 'but the question underneath is the same');
});

await test('near-identical buyer types are called out before they cost anything', () => {
  const a = { name: 'Alternative Investment Focused', descriptor: 'As an investor prioritizing private equity and alternative assets in the Gulf region,' };
  const b = { name: 'Asset Class Specialists', descriptor: 'As a specialist in private equity and alternative asset classes in the Gulf,' };
  const c = { name: 'Price-led buyer', descriptor: 'I run a small business and I am watching every dirham' };

  // Suggestion can produce near-synonyms that ask the same questions and get
  // the same answers, at twice the cost.
  assert.ok(pers.personaOverlap(a, b) >= 0.4, 'these two are the same buyer in different words');
  assert.ok(pers.personaOverlap(a, c) < 0.2, 'and a genuinely different one is not flagged');
});

await test('a persona prefixes the question rather than rewriting it', () => {
  const persona = { name: 'Price-led SME', descriptor: 'I run a five-person agency and I am watching every dirham.' };
  const q = 'Which SEO agencies are worth considering in the UAE?';
  const out = pers.asPersona(q, persona);

  // The measured question must stay comparable to the neutral one, or a
  // difference in the answer cannot be attributed to the persona rather
  // than to different wording.
  assert.ok(out.endsWith(q), 'the original question must survive intact');
  assert.ok(out.startsWith('I run a five-person agency'));
  assert.ok(!/\.\./.test(out), 'no doubled full stop where the descriptor already ended in one');
});

await test('a persona is only called different when the sample supports it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/lib/personas.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('export async function personaLift'));

  // These models are not deterministic, so two identical question sets
  // differ by chance. A fixed threshold called eight runs of pure noise a
  // finding, which is the failure this guards against.
  assert.ok(/Math\.sqrt\(runs\)/.test(block), 'the threshold must scale with the sample');
  assert.ok(/too few answers to tell yet/.test(block), 'and say so when the sample is too small');
  assert.ok(/not earning its cost/.test(block), 'and say plainly when a persona is useless');
});

await test('being linked without being named is not zero visibility', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // An AI Overview linked to the brand as its first source without naming it
  // in the sentence, and the question showed 0% visibility. The link is
  // usually the more valuable outcome of the two.
  const q = server.slice(server.indexOf("app.get('/api/projects/:id/prompts'"), server.indexOf('res.json(out)'));
  assert.ok(/AS cited/.test(q), 'the query must know whether our own site was cited');
  assert.ok(/citedRate/.test(q) && /seenRate/.test(q), 'and report it');

  // Kept as separate numbers: an answer can name you without linking, or
  // link without naming, and the fixes for those differ.
  assert.ok(/rate: p\.runs\.length \? p\.runs\.filter\(\(r\) => r\.mentioned\)/.test(q), 'named stays its own figure');
  assert.ok(/r\.mentioned \|\| r\.cited/.test(q), 'and seen counts either');

  // Three tick states, not two, or the middle case is invisible again.
  assert.ok(/r\.mentioned \? 'hit' : r\.cited \? 'cited' : 'miss'/.test(app));
  assert.ok(/linked as a source, but not named/.test(app), 'and says which it was');
});

await test('a question that has not run yet is still listed', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const block = server.slice(server.indexOf("app.get('/api/projects/:id/prompts'"), server.indexOf('res.json(out)'));

  // This joined on runs, so a question added since the last cycle was simply
  // absent: someone adds five for a buyer type, opens the tab, finds nothing.
  assert.ok(/LEFT JOIN runs/.test(block), 'questions must not be dropped for having no runs');
  assert.ok(/if \(row\.run_id\)/.test(block), 'and an empty run row must not be counted as a run');

  // Never asked is not the same as asked and not named. A rate of zero would
  // say the second, so it is null and the UI shows a dash.
  assert.ok(/rate: p\.runs\.length \? [\s\S]{0,60}: null/.test(block), 'an unmeasured question has no rate');
  assert.ok(/measured: p\.runs\.length > 0/.test(block));

  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.ok(/not asked yet/.test(app), 'and the UI must say so');
});

await test('a persona question shows which buyer type asked it', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  assert.ok(/LEFT JOIN personas pe/.test(server), 'the persona must come back with the question');
  assert.ok(/asked-as/.test(app), 'and be shown against it');

  // The descriptor is prefixed to the question text, which makes a list of
  // them unreadable. Strip it for display and show the buyer type instead.
  assert.ok(/p\.text\.startsWith\(p\.personaDescriptor/.test(app), 'the prefix must be stripped for reading');
  // The filter attribute was renamed when the toolbar became grouped, so this
  // checks the behaviour rather than the old attribute name.
  assert.ok(/chip\('persona', 'all'/.test(app), 'and the list must be filterable by buyer type');
  assert.ok(/qState\.persona/.test(app), 'with the choice feeding the same filter state');
});

await test('a persona card shows what it already has', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // The card looked identical whether a buyer type had no questions or
  // twenty, so the button always read "Add their questions" and the only
  // feedback was being told it was already done.
  const route = server.slice(
    server.indexOf("app.get('/api/projects/:id/personas'"),
    server.indexOf("app.delete('/api/personas/:personaId/questions")
  );
  assert.ok(/JOIN personas pe ON pe\.id = pr\.persona_id/.test(route), 'the questions must come back with the persona');

  const card = app.slice(app.indexOf('function personaCard'), app.indexOf('function loadPersonas'));
  assert.ok(/Add more questions/.test(card), 'the button must reflect what is already there');
  assert.ok(/question\$\{qs\.length === 1/.test(card) || /qs\.length/.test(card), 'and the count must be shown');
  assert.ok(/data-drop-pq/.test(card), 'and one question removable without removing the buyer type');
  assert.ok(/No questions yet for this buyer type/.test(card), 'and an empty one must say so');
});

await test('a persona shows its questions before adding them', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // Adding billable questions someone has not read is not a reasonable thing
  // to ask of one click, and the Search Console import already previews.
  assert.ok(/personas\/:personaId\/preview/.test(server), 'there must be a preview endpoint');
  assert.ok(/alreadyAdded/.test(server), 'and it must not offer the same question twice');

  // The customer chooses which, rather than taking whatever the top five are.
  assert.ok(/baseIds/.test(server), 'apply must accept an explicit list');
  assert.ok(/data-confirm-persona/.test(app), 'and the UI must confirm a chosen set');
  assert.ok(/more answer check/.test(app), 'with the cost of the choice visible while choosing');
});

await test('personas are never applied without the customer asking', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // Each persona multiplies the question count and therefore the bill.
  assert.ok(/personas\/:personaId\/apply/.test(server), 'applying must be its own explicit call');
  assert.ok(/more answer check/.test(app), 'and the cost must be visible before they agree');

  // A suggestion is a guess until someone who knows the business agrees.
  assert.ok(/data-suggested/.test(app), 'suggestions must be chosen, not saved automatically');
});

await test('suggestions are never empty', async () => {
  process.env.ANTHROPIC_API_KEY = '';
  const p = await import('../src/lib/personas.js?fb=1');
  const out = await p.suggestPersonas(
    { brand_name: 'X', domain: 'x.com', category: 'SEO agency', market: 'AE' },
    {}
  );

  // With no key, or a model that returns nothing usable, the panel rendered
  // empty checkboxes and looked broken. A plain set that says it is generic
  // is more honest and more useful than nothing.
  assert.ok(out.length >= 3, 'a fallback set must be offered');
  for (const x of out) {
    assert.ok(x.name && x.descriptor.length > 20, 'each needs a name and a descriptor');
    assert.equal(x.evidence.confidence, 'inferred', 'and must not claim evidence it does not have');
    assert.equal(x.evidence.fallback, true, 'and must be marked as the fallback');
  }
});

await test('the persona row uses a stated grid, not flex', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/public/styles.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('.persona.choose {'), css.indexOf('.plift {'));

  // Flex lost this twice: first the checkbox stretched to fill the row, then
  // the text column was pushed outside the panel and wrapped two words per
  // line. A stated grid cannot be pushed around by the surrounding layout.
  assert.ok(/display: grid/.test(block), 'the row must be a grid');
  assert.ok(/grid-template-columns: 18px minmax\(0, 1fr\)/.test(block), 'a fixed control column and a flexible text column');
  assert.ok(!/display: flex/.test(block), 'flex has failed here twice');

  // The control must not be able to grow, whatever else applies to inputs.
  assert.ok(/min-width: 18px/.test(block) && /min-height: 18px/.test(block), 'the checkbox needs floors');
  assert.ok(/overflow-wrap: anywhere/.test(block), 'a long unbroken word must not widen the column');
});

await test('the api helper encodes an object body', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const helper = app.slice(app.indexOf('async function api('), app.indexOf('/* ---------- signature element'));

  // Passing a plain object straight to fetch serialises it to
  // "[object Object]", so the server saw an empty body and the save failed
  // silently. Every caller passes objects, so the helper must encode them.
  assert.ok(/JSON\.stringify\(opts\.body\)/.test(helper), 'an object body must be encoded');
  assert.ok(/'Content-Type': 'application\/json'/.test(helper), 'and the content type set');
  assert.ok(/FormData/.test(helper), 'without breaking file uploads');
});

await test('a persona from no evidence is not presented as a finding', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/personas.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  assert.ok(/confidence: gscQueries\.length \|\| pageText \? p\.confidence \|\| 'inferred' : 'inferred'/.test(lib),
    'without evidence nothing can be evidence-backed, whatever the model claims');
  assert.ok(/These are guesses until Search Console is connected/.test(server),
    'and the customer must be told which they are looking at');
});

console.log('\nposter');

await test('a poster cannot be drawn from thin or absent data', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/poster.js', import.meta.url), 'utf8');

  // A shareable image outlives the page it came from, so it must not be
  // possible to produce one from two data points or from nothing.
  assert.ok(/ranked\.length < 3/.test(src), 'it must refuse fewer than three measured brands');
  assert.ok(/No stored data/.test(src), 'and refuse when the sector was never measured');

  // Logos are trademarks; a colour is not protectable in this use. Check the
  // template rather than the file, so the comment explaining this does not
  // trip its own test.
  const template = src.slice(src.indexOf('const html = `'), src.indexOf('mkdirSync'));
  assert.ok(!/<img/i.test(template), 'no third-party images in the poster');
  assert.ok(/BRAND\[r\.domain\]|r\.colour/.test(src), 'brands are shown by colour');

  // The method has to travel with the number.
  assert.ok(/Method\./.test(src));
  assert.ok(/Not a measure of market\s+share/.test(src), 'and say what it is not');
});

console.log('\nstructured data');

await test('the page can be found by what it is called', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../src/public/landing.html', import.meta.url), 'utf8');
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, '').toLowerCase();

  // Buyers and engines both call this an "AI visibility tool". The page never
  // used the phrase, which made it hard to find and hard to quote.
  assert.ok(/<title>[^<]*ai visibility tool/i.test(html), 'the title should say what this is');
  assert.ok(/name="description"[^>]*ai visibility tool/i.test(html), 'and the description');

  // A definitional answer is what an engine lifts when asked "what is an
  // AI visibility tool", so it has to stand alone without the page around it.
  assert.ok(/what is an ai visibility tool\?/i.test(visible), 'the definitional question must be asked');
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  const def = graph
    .find((n) => n['@type'] === 'FAQPage')
    .mainEntity.find((q) => /what is an ai visibility tool/i.test(q.name));
  assert.ok(def, 'and be in the structured data');
  assert.ok(def.acceptedAnswer.text.startsWith('An AI visibility tool'), 'the answer must open with the definition');
  assert.ok(def.acceptedAnswer.text.length > 200, 'and be substantial enough to be worth citing');

  // Repetition is not optimisation. Every use should be doing work.
  const uses = (visible.match(/ai visibility tool/g) || []).length;
  assert.ok(uses >= 3 && uses <= 12, `the phrase appears ${uses} times, which is either too few or stuffed`);
});

await test('the landing page publishes what it actually says', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../src/public/landing.html', import.meta.url), 'utf8');
  const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(block, 'the landing page has no structured data');

  const graph = JSON.parse(block[1])['@graph'];
  const types = graph.map((n) => n['@type']);
  for (const t of ['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage']) {
    assert.ok(types.includes(t), `missing ${t}`);
  }

  // A product that sells answer engine visibility cannot skip its own FAQ
  // markup, and the markup must match the questions on the page.
  const faq = graph.find((n) => n['@type'] === 'FAQPage');
  const onPage = [...html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].length;
  assert.equal(faq.mainEntity.length, onPage, 'every visible question must be in the markup');
  for (const q of faq.mainEntity) {
    assert.ok(q.name && q.acceptedAnswer.text.length > 30, `thin answer for "${q.name}"`);
    assert.ok(html.includes(q.name.replace(/&/g, '&amp;')), `"${q.name}" is not on the page`);
  }

  // Prices that disagree with the page are worse than no prices at all.
  const offers = graph.find((n) => n['@type'] === 'SoftwareApplication').offers;
  assert.equal(offers.offerCount, 4);
  assert.equal(offers.lowPrice, 0);
  assert.equal(offers.highPrice, 499);
  for (const o of offers.offers) {
    assert.ok(html.includes(`data-m="${o.price}"`), `${o.name} at $${o.price} is not the price on the page`);
  }
});

await test('the homepage explains buyer types and the FAQ backs it', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../src/public/landing.html', import.meta.url), 'utf8');

  assert.ok(html.includes('id="who-asks"'), 'the section must exist');
  assert.ok(/Search Console/.test(html.slice(html.indexOf('id="who-asks"'), html.indexOf('id="how"'))),
    'and say where the buyer types come from, since a made-up persona is not a feature');

  // The claim that a useless persona is called out is the honest half of
  // this, and the FAQ has to carry it or the page is only selling the good bit.
  const faq = html.slice(html.indexOf('id="faqs"'));
  assert.ok(/different types of buyer/i.test(faq), 'the FAQ must cover it');
  assert.ok(/tell you to remove it|changes nothing/i.test(faq), 'including when a buyer type is not worth keeping');

  // And it must reach the structured data, or it is invisible to the engines
  // this product measures.
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  const page = graph.find((n) => n['@type'] === 'FAQPage');
  assert.ok(page.mainEntity.some((q) => /buyer/i.test(q.name)), 'the buyer question must be in the FAQ markup');
});

await test('the legal pages are not left bare', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['privacy', 'terms']) {
    const html = readFileSync(new URL(`../src/public/${f}.html`, import.meta.url), 'utf8');
    const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
    const types = graph.map((n) => n['@type']);
    for (const t of ['Organization', 'WebSite', 'WebPage', 'BreadcrumbList']) {
      assert.ok(types.includes(t), `${f}.html is missing ${t}`);
    }
  }
});

await test('both indexes describe themselves as datasets', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['index-page', 'mena-page']) {
    const js = readFileSync(new URL(`../src/public/${f}.js`, import.meta.url), 'utf8');
    assert.ok(/'@graph'/.test(js), `${f}.js publishes a bare node rather than a graph`);
    assert.ok(/BreadcrumbList/.test(js), `${f}.js has no breadcrumb`);
    assert.ok(/isAccessibleForFree/.test(js), `${f}.js should say the data is free`);
    assert.ok(/license/.test(js), `${f}.js should carry a licence`);
  }
});

console.log('\nnavigation');

await test('Cited claims no registration it does not have', async () => {
  const { readFileSync } = await import('node:fs');
  const pages = ['landing', 'uae', 'mena', 'property-developers', 'privacy', 'terms'];

  for (const f of pages) {
    const html = readFileSync(new URL(`../src/public/${f}.html`, import.meta.url), 'utf8');

    // R asserts a registered trademark. Sandstorm Digital is registered and
    // keeps it; Cited is not, and claiming registration it does not have is
    // an offence in several jurisdictions and something a competitor could
    // raise.
    for (const m of html.matchAll(/Cit(ed)?[^<]{0,40}(&reg;|\u00ae)/gi)) {
      assert.fail(`${f}.html asserts registration for Cited: ${m[0]}`);
    }
    assert.ok(/Sandstorm Digital&reg;/.test(html), `${f}.html should keep the registered mark that is registered`);
    assert.ok(/wordmark-tm/.test(html), `${f}.html should mark Cited as an unregistered mark`);
  }
});

await test('every public page carries the same footer', async () => {
  const { readFileSync } = await import('node:fs');
  const pages = ['landing', 'uae', 'mena', 'property-developers', 'privacy', 'terms'];

  for (const f of pages) {
    const html = readFileSync(new URL(`../src/public/${f}.html`, import.meta.url), 'utf8');
    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));

    // Privacy and terms had a stub with one outbound link and no way back
    // into the site, which is where a reader lands from a consent screen.
    for (const link of ['/#try', '/uae', '/mena', '/privacy', '/terms']) {
      assert.ok(footer.includes(`href="${link}"`), `${f}.html footer is missing ${link}`);
    }
    for (const heading of ['Product', 'Research', 'Company']) {
      assert.ok(footer.includes(`>${heading}<`), `${f}.html footer is missing the ${heading} column`);
    }
    assert.ok(footer.includes('id="year"'), `${f}.html footer has no year`);
    // Feedback belongs among the links, not floating over them.
    assert.ok(footer.includes('data-open-feedback'), `${f}.html footer has no feedback link`);
    assert.ok(/Sandstorm Digital/.test(footer));
  }
});

await test('the production line uses the brand green and no decoration', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/public/landing.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('.production {'), css.indexOf('/* ---------- responsive'));

  // It was gold, which belongs to nothing else in the identity, and carried
  // a decorative rule that read as a stray dash.
  assert.ok(/\.production a \{ color: var\(--spark\)/.test(block), 'the link is spark green');
  assert.ok(!/--dune/.test(block), 'nothing here should be gold');
  assert.ok(!/\.production::before/.test(block), 'no decorative rule before the text');
});

await test('the floating feedback button steps aside for the footer', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../src/public/feedback.js', import.meta.url), 'utf8');

  // It is fixed to the corner, so it sits over the footer and reads as a
  // stray link among the real ones.
  assert.ok(/IntersectionObserver/.test(js), 'it must know when the footer is on screen');
  assert.ok(/is-tucked/.test(js));
  assert.ok(/data-open-feedback/.test(js), 'and the footer link must open the same dialog');
});

await test('every public page carries the same menu', async () => {
  const { readFileSync } = await import('node:fs');
  const pages = ['landing', 'uae', 'mena', 'property-developers', 'privacy', 'terms'];

  for (const f of pages) {
    const html = readFileSync(new URL(`../src/public/${f}.html`, import.meta.url), 'utf8');
    assert.ok(html.includes('id="navToggle"'), `${f}.html has no menu control`);
    assert.ok(html.includes('id="navMenu"'), `${f}.html has no menu`);
    assert.ok(html.includes('/nav.js'), `${f}.html does not load the menu script`);

    // The point of the change: a phone reaches the indexes without
    // scrolling to the footer to find them. The developers study is
    // deliberately absent, being live but unpublished.
    for (const link of ['/uae', '/mena', '/privacy', '/terms']) {
      assert.ok(html.includes(`href="${link}"`), `${f}.html menu is missing ${link}`);
    }
    // Accessible by default: closed, labelled, and announcing its state.
    assert.ok(/id="navMenu" hidden/.test(html), `${f}.html menu must start closed`);
    assert.ok(/aria-expanded="false"/.test(html), `${f}.html toggle must announce its state`);
  }
});

console.log('\ngoogle connection');

await test('disconnecting Google actually disconnects it', async () => {
  const { readFileSync } = await import('node:fs');
  const ga4 = readFileSync(new URL('../src/lib/ga4.js', import.meta.url), 'utf8');
  const fn = ga4.slice(ga4.indexOf('export async function disconnect'), ga4.indexOf('/** Every GA4 property'));

  // One credential covers both surfaces, so clearing the token while leaving
  // the Search Console property behind left a site pointing at something it
  // could no longer read, with nothing to click to fix it.
  const all = fn.slice(fn.lastIndexOf('await query('));
  assert.ok(/gsc_site_url = NULL/.test(all), 'the Search Console property must go too');
  assert.ok(/google_scopes = NULL/.test(all), 'and what was granted');
  assert.ok(/ga4_refresh_token = NULL/.test(all));

  // Choosing a different property is common and must not cost the connection.
  const gscOnly = fn.slice(fn.indexOf("if (what === 'gsc')"), fn.indexOf("if (what === 'ga4')"));
  assert.ok(/gsc_site_url = NULL/.test(gscOnly));
  assert.ok(!/refresh_token/.test(gscOnly), 'changing property must keep the credential');
});

await test('a button row does not stretch to match the text beside it', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/public/styles.css', import.meta.url), 'utf8');
  const rule = css.slice(css.indexOf('.inline-form {'), css.indexOf('.setup-grid {'));

  // Flex defaults to stretch, so a long note beside the buttons made every
  // button as tall as the note and squeezed the note into a column two words
  // wide.
  assert.ok(/align-items: center/.test(rule), 'the row must not stretch its children');
  assert.ok(/flex-wrap: wrap/.test(rule), 'and should wrap rather than crush');
  assert.ok(/\.inline-form \.hint \{ flex: 1 1/.test(rule), 'the explanation needs real width');
});

await test('the import limit is stated before anything is chosen', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // The cap was only reported after selecting and clicking, so the work of
  // choosing happened first and the refusal came second.
  assert.ok(/limit: \{ questions: e\.plan\.questions, active: active\.n \}/.test(server), 'the ceiling ships with the candidates');
  assert.ok(/function importRoom/.test(app), 'and is shown on the panel');
  assert.ok(/Room for \$\{room\} more/.test(app), 'with what is left');
  assert.ok(/at its limit of/.test(app), 'and what to do when there is none');
});

await test('the Search Console panel offers a way out', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // The only disconnect button lived on the Traffic tab, so there was
  // nothing to click from the panel someone was actually looking at.
  assert.ok(/id="gscDisconnect"/.test(app), 'disconnect must be reachable from Search Console');
  assert.ok(/id="gscSwitch"/.test(app), 'and changing property must not require disconnecting');

  // Both surfaces share a credential, so say that before taking it away.
  assert.ok(/Analytics goes with it, since they share one connection/.test(app), 'the consequence must be stated');
});

await test('connecting returns to whatever was being connected', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // The redirect assumed Analytics whatever had been asked for, so connecting
  // Search Console from Setup landed on Traffic and then failed listing
  // Analytics properties, which read as Search Console being broken.
  assert.ok(/state\.w === 'gsc' \? 'gsc' : 'ga4'/.test(server), 'the callback must carry what was requested');
  assert.ok(/connected=\$\{what\}/.test(server), 'and say so in the redirect');

  const fn = app.slice(app.indexOf('function handleGoogleReturn'), app.indexOf('async function boot'));
  assert.ok(/params\.get\('connected'\)/.test(fn));
  // A link already in flight during a deploy must not land nowhere.
  assert.ok(/params\.get\('ga4'\)/.test(fn), 'the older parameter is still understood');

  const boot = app.slice(app.indexOf('if (returned) {'), app.indexOf('if (returned) {') + 700);
  assert.ok(/'gsc' \? 'setup' : 'traffic'/.test(boot), 'each lands on its own tab');
  assert.ok(/setupError/.test(boot), 'and a failure is shown where it started');
});

await test('a 403 from Google says which 403 it was', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/lib/ga4.js', import.meta.url), 'utf8');
  const start = src.indexOf('  if (!res.ok) {\n    const body = await res.text()');
  const branch = src.slice(start, src.indexOf('const json = await res.json();', start));
  const fn = new Function('res', `return (async () => {${branch}})();`);

  const throws = async (status, message) => {
    try {
      await fn({ ok: false, status, text: async () => JSON.stringify({ error: { message } }) });
      return null;
    } catch (e) {
      return e.message;
    }
  };

  // Reporting only the status turned three different problems into one
  // number, and a 403 here is usually an API nobody switched on rather than
  // a permissions failure the customer could act on.
  assert.match(
    await throws(403, 'Google Analytics Admin API has not been used in project 12345 before or it is disabled.'),
    /not enabled on our Google Cloud project/
  );
  assert.match(await throws(403, 'The caller does not have permission'), /Google refused: The caller does not have permission/);
  assert.match(await throws(401, 'Invalid Credentials'), /connection has expired/);

  // Ours to fix must be said as ours to fix.
  assert.match(
    await throws(403, 'Analytics Admin API is disabled'),
    /That is ours to fix, not yours/
  );
});

await test('a dead end is never the answer to "connect Google"', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // No connection at all fell through to a generic error with no button, so
  // the one case where the fix is a single click had no way forward.
  const start = server.indexOf("app.get('/api/projects/:id/gsc/candidates'");
  const route = server.slice(start, start + 1400);
  assert.ok(/fix: 'connect'/.test(route), 'not connected must be its own case');
  assert.ok(/ga4_refresh_token/.test(route), 'and be detected before calling Google');

  // Every branch of this error must offer something to click.
  const fn = app.slice(app.indexOf('function gscError'), app.indexOf('async function loadGscCandidates'));
  for (const fix of ['connect', 'enable-api', 'reconnect']) {
    const branch = fn.slice(fn.indexOf(`d.fix === '${fix}'`));
    assert.ok(/<button|<a class="btn/.test(branch.slice(0, 700)), `the ${fix} branch has no way forward`);
  }
});

await test('a missing Search Console grant is not blamed on an old connection', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("app.get('/api/projects/:id/gsc/sites'"), src.indexOf('try {', src.indexOf("gsc/sites")));

  // Scopes are requested separately now, so every fresh connection reaches
  // this branch. Saying the connection predates support would be false and
  // would contradict the instruction shown underneath it.
  assert.ok(!/before Search Console was supported/.test(block), 'that message is no longer true');
  assert.ok(/has not been granted/.test(block));
  assert.ok(/fix: 'reconnect'/.test(block), 'and the panel must still offer the grant button');
});

await test('each connection asks only for the scope it needs', async () => {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'sec';
  const g = await import('../src/lib/ga4.js?scopes=1');

  const scopeFor = (what) =>
    new URL(g.authUrl({ redirectUri: 'https://cited.ae/cb', state: 's', what })).searchParams.get('scope');

  // Google's unbundled consent policy requires incremental authorisation,
  // and asking for Search Console to connect Analytics is a worse ask
  // besides.
  assert.ok(scopeFor('ga4').includes('analytics.readonly'));
  assert.ok(!scopeFor('ga4').includes('webmasters'), 'connecting Analytics must not demand Search Console');

  assert.ok(scopeFor('gsc').includes('webmasters.readonly'));
  assert.ok(!scopeFor('gsc').includes('analytics'), 'and the reverse');

  // A later grant must add to the first rather than replacing it.
  const url = new URL(g.authUrl({ redirectUri: 'x', state: 's', what: 'gsc' }));
  assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
  // The account picker still matters: an agency connecting a second client
  // must not silently reuse the browser's signed-in account.
  assert.match(url.searchParams.get('prompt'), /select_account/);
});



await test('an OAuth refusal is explained, not echoed as a code', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  // "access_denied" tells the person nothing. The usual cause is that the
  // app is still in Testing, which is ours to fix, not theirs.
  const map = src.slice(src.indexOf('const OAUTH_ERRORS'), src.indexOf('app.get(\'/api/ga4/callback\''));
  for (const code of ['access_denied', 'admin_policy_enforced', 'disallowed_useragent', 'invalid_client']) {
    assert.ok(map.includes(code), `${code} needs a plain explanation`);
  }
  assert.ok(/rather than you/i.test(map), 'and should not imply the customer did something wrong');

  // And we should hear about it without waiting for a support message.
  const handler = src.slice(src.indexOf('if (req.query.error)'), src.indexOf('const state = early'));
  assert.ok(/notify\(/.test(handler), 'a refused connection must reach us');
});

console.log('\nengine parameters');

await test('no engine is sent a field it rejects', async () => {
  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  process.env.MOCK_MODE = 'false';
  const df = await import('../src/lib/dataforseo.js?params2=1');
  const realFetch = global.fetch;
  const sent = {};
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body)[0];
    for (const e of ['chat_gpt', 'gemini', 'claude', 'perplexity']) if (url.includes(e)) sent[e] = body;
    return { ok: true, json: async () => ({ tasks: [{ status_code: 20000, result: [{ items: [{ type: 'ai_overview', text: 'x' }] }] }] }) };
  };

  for (const e of ['chatgpt', 'gemini', 'claude', 'perplexity']) {
    await df.askEngine({ engine: e, prompt: 'q', market: 'AE' });
  }
  global.fetch = realFetch;
  process.env.MOCK_MODE = 'true';

  // Gemini and Claude both reject web_search_country_iso_code. Sending it
  // failed 100% of Gemini's calls, and the customer was told the provider
  // was unreliable and to switch it off.
  assert.equal(sent.gemini.web_search_country_iso_code, undefined, 'Gemini rejects this field');
  assert.equal(sent.claude.web_search_country_iso_code, undefined, 'Claude rejects this field');
  assert.equal(sent.chat_gpt.web_search_country_iso_code, 'AE', 'ChatGPT needs it');
  assert.equal(sent.perplexity.web_search_country_iso_code, 'AE', 'Perplexity needs it');
});

await test('a rejected request is not blamed on the provider', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('function failureNote'), src.indexOf('function showReport'));

  assert.ok(/invalid field/i.test(block), 'our own rejections must be told apart from outages');
  assert.ok(/fault on our side/i.test(block), 'and named as ours');
  // The disable button is the thing that must not appear for our own bug.
  // Checking the wording is not enough: the honest copy says "not a reason to
  // switch it off", which contains the word either way.
  const ourBranch = block.slice(block.indexOf('const ourNote'), block.indexOf('const theirNote'));
  assert.ok(!/data-goto-setup/.test(ourBranch), 'do not offer to disable a working engine over our bug');
  assert.ok(/not a reason to switch/i.test(ourBranch), 'and say so plainly');

  const theirBranch = block.slice(block.indexOf('const theirNote'), block.indexOf('const advice'));
  assert.ok(/data-goto-setup/.test(theirBranch), 'a genuinely broken provider can still be switched off');
});

console.log('\ncycle progress');

await test('a failed answer still counts towards progress', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/jobs/runCycle.js', import.meta.url), 'utf8');

  // Returning early on failure left the counter stuck and the feed showing a
  // question that never resolved, which reads as the run having hung.
  const block = src.slice(src.indexOf('if (!answer.ok)'), src.indexOf('const results = await analyseRun'));
  assert.ok(/done\+\+/.test(block), 'a failed call must still increment the counter');
  assert.ok(/asking\.state = 'failed'/.test(block), 'and be marked failed in the feed');
  assert.ok(/report\(/.test(block), 'and report immediately');
});

await test('progress reports what is being asked, not just a count', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/jobs/runCycle.js', import.meta.url), 'utf8');

  assert.ok(/recent: \[\.\.\.recent\]/.test(src), 'the recent questions must be sent to the client');
  assert.ok(/noteAsked\(/.test(src), 'each question is recorded as it goes out');
  // Bounded, or a long cycle grows the status payload without limit.
  assert.ok(/recent\.length > \d+/.test(src), 'the feed must be capped');
});

console.log('\nassignment');

await test('a failed assignment email is not reported as sent', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // Sending is fire and forget so a mail outage cannot break the task board.
  // The cost is that a broken sender stays invisible until someone says they
  // never got it, which is what happened.
  assert.ok(/notifications\/last-assignment/.test(server), 'the result must be checkable');
  assert.ok(/email_error/.test(server));
  assert.ok(/email failed/.test(app), 'and a failure shown where the assignment was made');
  assert.ok(/>sending</.test(app), 'with an honest interim state rather than a premature success');
});

await test('an assignment email carries the notes and the right link', async () => {
  process.env.RESEND_API_KEY = 'test';
  const n = await import('../src/lib/notify.js?asg=1');
  const realFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, text: async () => '' }; };

  n.notifyAssignment({
    to: 'sara@example.com',
    site: 'Arada',
    task: {
      title: 'Claim your profile on clutch.co',
      action: 'clutch.co is cited across 4 of your questions.',
      notes: 'Start with the Dubai pages. Omar has the login.',
      type: 'source_gap'
    },
    // Their own list, not a dashboard they may not be able to open.
    appUrl: 'https://cited.ae/tasks?t=signed'
  });
  await new Promise((r) => setTimeout(r, 150));
  global.fetch = realFetch;

  const html = sent[0].html;
  assert.ok(/Start with the Dubai pages/.test(html), 'what the assigner wrote must be in the email');
  assert.ok(/>Notes</.test(html), 'and labelled');
  assert.ok(html.includes('https://cited.ae/tasks?t=signed'), 'the link goes to their own list');
  assert.ok(/See everything assigned to you/.test(html));
});

console.log('\nnotifications');

await test('an assignment email points at the page, not the domain', async () => {
  process.env.RESEND_API_KEY = 'test';
  const n = await import('../src/lib/notify.js?url=1');
  const realFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, text: async () => '' }; };

  const page = 'https://www.bhomes.com/en/blog/betterinformed/affordable-neighbourhoods-for-first-time-buyers-in-sharjah';
  n.notifyAssignment({
    to: 'sara@example.com',
    site: 'Arada',
    task: {
      title: 'bhomes.com shapes 3 of your questions',
      action: 'Cited across 3 tracked questions.',
      type: 'source_gap',
      target_url: page,
      evidence: { domain: 'bhomes.com', question: 'Which areas suit first-time buyers?' }
    },
    appUrl: 'https://cited.ae/app?site=5'
  });
  await new Promise((r) => setTimeout(r, 150));
  global.fetch = realFetch;

  const html = sent[0].html;
  // The whole point: the recipient opens the page being discussed, not a
  // home page and a hunt.
  assert.ok(html.includes(`href="${page}"`), 'the full URL must be the link target');
  assert.ok(!/>\s*bhomes\.com\s*</.test(html.replace(/href="[^"]*"/g, '')), 'the bare domain is not enough');
  assert.ok(/Question it came from/.test(html), 'say which question produced it');
});

await test('a plain value is escaped, a URL becomes a link', async () => {
  const { renderValue } = await import('../src/lib/notify.js?rv=1');

  assert.equal(renderValue('Arada'), 'Arada');
  assert.ok(renderValue('<script>x</script>').includes('&lt;script&gt;'), 'plain values stay escaped');

  const link = renderValue('https://x.com/a/b');
  assert.ok(link.startsWith('<a href="https://x.com/a/b"'), 'a URL becomes a link to itself');
  assert.ok(link.includes('>x.com/a/b<'), 'and reads without the scheme');

  // A long path is shortened for reading, never for linking.
  const long = `https://example.com/${'segment/'.repeat(20)}end`;
  const rendered = renderValue(long);
  assert.ok(rendered.includes(`href="${long}"`), 'the href keeps the whole URL');
  assert.ok(rendered.includes('…'), 'the label is truncated');
});

await test('an email failure never breaks the thing that triggered it', async () => {
  process.env.RESEND_API_KEY = 'test';
  process.env.NOTIFY_EMAIL = 'you@example.com';
  const n = await import('../src/lib/notify.js?fail=1');
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('resend is down'); };

  // notify() is deliberately not awaited by callers, so a rejected send must
  // be swallowed rather than becoming an unhandled rejection that takes the
  // request down with it.
  assert.doesNotThrow(() => n.notifyTrial({ domain: 'x.ae', rate: 0, runs: 3 }));
  await new Promise((r) => setTimeout(r, 120));
  global.fetch = realFetch;
});

await test('a zero-visibility trial is flagged as the lead it is', async () => {
  process.env.RESEND_API_KEY = 'test';
  process.env.NOTIFY_EMAIL = 'you@example.com';
  const n = await import('../src/lib/notify.js?trial=1');
  const realFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, text: async () => '' };
  };

  n.notifyTrial({ domain: 'bigbrand.ae', brandName: 'Big Brand', rate: 0, runs: 3, source: 'uae' });
  n.notifyTrial({ domain: 'acme.ae', rate: 0.33, runs: 3, source: 'landing' });
  await new Promise((r) => setTimeout(r, 200));
  global.fetch = realFetch;

  assert.ok(/scored 0% AI visibility/.test(sent[0].subject), 'the zero case says so in the subject line');
  assert.ok(/easiest conversation/i.test(sent[0].html), 'and explains why it matters');
  assert.ok(/33%/.test(sent[1].subject));
  assert.ok(!/easiest conversation/i.test(sent[1].html), 'a partial score is not the same lead');

  // The values must be escaped, since a domain is visitor-supplied.
  const evil = [];
  global.fetch = async (url, opts) => { evil.push(JSON.parse(opts.body)); return { ok: true, text: async () => '' }; };
  n.notifyTrial({ domain: '<script>alert(1)</script>.ae', rate: 0.5, runs: 2 });
  await new Promise((r) => setTimeout(r, 120));
  global.fetch = realFetch;
  assert.ok(!/<script>/.test(evil[0].html), 'visitor-supplied values must be escaped');
});

console.log('\nsector index');

const sec = await import('../src/lib/sectors.js');

await test('named in the answer and cited as a source are measured separately', async () => {
  const { countNames } = await import('../src/lib/mentions.js?names2=1');
  const re = sec.SECTORS.find((s) => s.slug === 'real-estate-development');

  const answers = [
    { question: 'Top developers?', answer: 'Emaar Properties, DAMAC and Aldar Properties lead. Nakheel built Palm Jumeirah.' },
    { question: 'Where to buy?', answer: 'Emaar and DAMAC dominate the market.' }
  ];
  const counts = countNames(answers, re.members);
  const { brands } = sec.mergeKnown(re.members, [{ domain: 'emaar.com', mentions: 14000 }], counts);

  const by = Object.fromEntries(brands.map((b) => [b.domain, b]));

  // The distinction that makes the page honest: recommended in the answer is
  // not the same as being the source the answer cited.
  assert.equal(by['emaar.com'].status, 'named-and-cited');
  assert.equal(by['damacproperties.com'].status, 'named-not-cited', 'named in prose, citation went elsewhere');
  assert.equal(by['arada.com'].status, 'absent', 'neither named nor cited');

  // A shortened form counts. "Emaar and DAMAC dominate" is a mention.
  assert.equal(by['emaar.com'].named, 2);
  assert.equal(by['damacproperties.com'].named, 2);
});

await test('a shortened name does not match a different company', async () => {
  const { countNames } = await import('../src/lib/mentions.js?names3=1');
  const members = [
    { name: 'Emirates NBD', domain: 'emiratesnbd.com' },
    { name: 'Emaar Properties', domain: 'emaar.com' }
  ];
  const counts = countNames([{ question: 'q', answer: 'Emirates is the flag carrier of Dubai.' }], members);

  // "Emirates NBD" must not be credited for a sentence about the airline.
  assert.equal(counts.get('emiratesnbd.com').named, 0);
  assert.equal(counts.get('emaar.com').named, 0);
});

await test('non-companies are kept out of the ranking', () => {
  const banking = sec.SECTORS.find((s) => s.slug === 'banking');

  // A news site or a portal in a "who AI recommends in Banking" list makes
  // the card read as broken even though the number behind it is correct.
  const measured = [
    { domain: 'emiratesnbd.com', name: 'Emirates NBD', mentions: 17229 },
    { domain: 'youtube.com', mentions: 13742 },
    { domain: 'gulfnews.com', mentions: 9000 },
    { domain: 'hsbc.ae', name: 'HSBC UAE', mentions: 7909 },
    { domain: 'centralbank.ae', mentions: 4000 }
  ];
  const { brands, others } = sec.mergeKnown(banking.members, measured);

  assert.equal(brands.length, banking.members.length, 'the ranking is exactly the sector list');
  for (const b of brands) assert.equal(b.known, true, `${b.name} should not be in the ranking`);
  assert.ok(!brands.some((b) => /youtube|gulfnews|centralbank/.test(b.domain)));

  // But they are not discarded: which sources shape a sector is useful.
  const kinds = Object.fromEntries(others.map((o) => [o.domain, o.kind]));
  assert.equal(kinds['youtube.com'], 'platform');
  assert.equal(kinds['gulfnews.com'], 'news');
  assert.equal(kinds['centralbank.ae'], 'government');

  // Anything that looks like a real company gets flagged for review rather
  // than silently ranked or silently dropped.
  assert.equal(kinds['hsbc.ae'], 'candidate');
});

await test('domains are classified into the right buckets', () => {
  const k = (d) => sec.classifyDomain(d).kind;
  assert.equal(k('gulfnews.com'), 'news');
  assert.equal(k('khaleejtimes.com'), 'news');
  assert.equal(k('bayut.com'), 'portal');
  assert.equal(k('propertyfinder.ae'), 'portal');
  assert.equal(k('talabat.com'), 'portal');
  assert.equal(k('youtube.com'), 'platform');
  assert.equal(k('en.wikipedia.org'), 'reference');
  assert.equal(k('u.ae'), 'government');
  assert.equal(k('centralbank.ae'), 'government');
  // Not obviously a publisher or platform, so it may be a company we missed.
  assert.equal(k('someuaefirm.ae'), 'candidate');
});

await test('every named company appears, measured or not', () => {
  const banking = sec.SECTORS.find((s) => s.slug === 'banking');
  assert.equal(banking.members.length, 5, 'the list is the floor');

  const measured = [
    { domain: 'www.emiratesnbd.com', name: 'Emirates NBD', mentions: 17229 },
    { domain: 'hsbc.ae', name: 'HSBC UAE', mentions: 7909 }
  ];
  const { brands, others } = sec.mergeKnown(banking.members, measured);

  // A household name the machines never mention is the most useful row on the
  // page, so it must survive rather than being dropped for having no data.
  for (const m of banking.members) {
    assert.ok(brands.some((b) => b.name === m.name), `${m.name} must appear`);
  }
  const fab = brands.find((b) => /First Abu Dhabi/.test(b.name));
  assert.equal(fab.citations, 0);
  assert.equal(fab.cited, false, 'and be marked as not cited');

  // Anything found that is not on the list goes to the sources list.
  assert.ok(others.some((o) => o.domain === 'hsbc.ae'));

  // Measured companies rank above absent ones.
  assert.equal(brands[0].domain, 'emiratesnbd.com');
  assert.ok(brands.findIndex((b) => b.citations === 0) > brands.findIndex((b) => b.citations > 0));
});

await test('an old snapshot is never reported as absent', async () => {
  // Snapshots written before citations and name mentions were separated only
  // carry `mentions`. Reading them with the new field names made every
  // company look absent, which is a stronger claim than the data supports.
  const { readIndex } = await import('../src/lib/sectors.js');
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/lib/sectors.js', import.meta.url), 'utf8')
  );
  const normalise = new Function('snap', src.match(/function normaliseSnapshot\(snap\)[\s\S]*?\n\}/)[0] + '; return normaliseSnapshot(snap);');

  const old = normalise({
    brands: [
      { name: 'Emirates NBD', domain: 'emiratesnbd.com', mentions: 17229, known: true, measured: true },
      { name: 'Mashreq', domain: 'mashreq.com', mentions: 0, known: true, measured: false }
    ]
  });

  assert.equal(old.stale, true, 'the page needs to know it is out of date');
  assert.equal(old.brands[0].citations, 17229, 'the old figure is a citation count');
  assert.equal(old.brands[0].status, 'cited-not-named');
  assert.equal(old.brands[1].status, 'unmeasured', 'not "absent": we never looked at the answer text');
  assert.notEqual(old.brands[1].status, 'absent');

  // And a current snapshot passes through untouched.
  const current = normalise({ brands: [{ name: 'X', domain: 'x.com', citations: 5, named: 2, status: 'named-and-cited' }] });
  assert.equal(current.stale, false);
  assert.equal(current.brands[0].status, 'named-and-cited');
});

await test('the sector list is complete and well formed', () => {
  assert.ok(sec.SECTORS.length >= 25, `only ${sec.SECTORS.length} sectors`);
  const slugs = new Set();
  for (const s of sec.SECTORS) {
    assert.ok(s.slug && !slugs.has(s.slug), `duplicate or missing slug: ${s.slug}`);
    slugs.add(s.slug);
    assert.ok(s.keywords.length >= 1, `${s.slug} needs a query`);
    assert.ok(s.members.length >= 3, `${s.slug} needs known companies`);
    for (const m of s.members) {
      assert.ok(m.name && m.domain, `${s.slug} has a member with no domain`);
      assert.ok(!m.domain.startsWith('www.'), `${m.domain} should be stripped`);
      assert.ok(!/^https?:/.test(m.domain), `${m.domain} should not be a url`);
      assert.ok(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(m.domain), `${m.domain} is not a bare hostname`);
    }
  }

  // A company appearing in two sectors gets ranked twice and reads as an
  // error. Al Futtaim is the deliberate exception: it is genuinely a major
  // player in both retail and automotive distribution.
  const seen = new Map();
  for (const s of sec.SECTORS) {
    for (const m of s.members) {
      if (!seen.has(m.domain)) seen.set(m.domain, []);
      seen.get(m.domain).push(s.slug);
    }
  }
  const duplicated = [...seen.entries()].filter(([d, list]) => list.length > 1 && d !== 'alfuttaim.com');
  assert.deepEqual(duplicated, [], `these domains appear in more than one sector: ${JSON.stringify(duplicated)}`);
});

console.log('\nmena index');

const mena = await import('../src/lib/mena.js');

await test('every company carries a home market', () => {
  assert.equal(mena.MENA_SECTORS.length, 25);
  const slugs = new Set();
  let companies = 0;

  for (const s of mena.MENA_SECTORS) {
    assert.ok(s.slug && !slugs.has(s.slug), `duplicate slug: ${s.slug}`);
    slugs.add(s.slug);
    assert.ok(s.keyword && s.keyword.length > 3, `${s.slug} needs a keyword`);
    // The keyword has the country appended per market, so it must not already
    // name one or the query becomes "best bank saudi uae".
    assert.ok(!/uae|saudi|egypt|qatar|kuwait|dubai/i.test(s.keyword), `${s.slug} keyword must be country-neutral: ${s.keyword}`);

    for (const m of s.members) {
      companies++;
      assert.ok(m.name && m.domain, `${s.slug} has an incomplete member`);
      assert.ok(m.country && mena.COUNTRY_NAMES[m.country], `${m.name} has no usable country: ${m.country}`);
      assert.ok(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(m.domain), `${m.domain} is not a bare hostname`);
    }
  }
  assert.equal(companies, 125);
});

await test('each market is queried in a language its corpus actually holds', async () => {
  const m = await import('../src/lib/mentions.js?lang=1');

  // Taken from llm_mentions/locations_and_languages, not guessed:
  //   UAE ar,en   Saudi ar   Egypt ar,en   Morocco ar,fr   Algeria fr,ar
  // Sending English to an Arabic-only market returns nothing, which looks
  // identical to the market being uncovered and produced a table of zeros.
  assert.equal(m.MARKET_LANGUAGE.SA, 'ar');
  assert.equal(m.MARKET_LANGUAGE.BH, 'ar');
  assert.equal(m.MARKET_LANGUAGE.JO, 'ar');
  assert.equal(m.MARKET_LANGUAGE.DZ, 'fr');
  assert.equal(m.MARKET_LANGUAGE.AE, 'en');
  assert.equal(m.MARKET_LANGUAGE.EG, 'en');

  // Absent from the corpus entirely. Calling them costs money and returns
  // nothing, and publishing that as a zero would be a false claim about a
  // country's largest companies.
  for (const code of ['QA', 'KW', 'OM', 'LB', 'IQ', 'LY']) {
    assert.equal(m.marketSupported(code), false, `${code} must be treated as unmeasurable`);
  }
  assert.equal(m.marketSupported('SA'), true);
  assert.equal(m.marketSupported('AE'), true);

  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  const realFetch = global.fetch;
  let sent = null;
  global.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body)[0];
    return { ok: true, json: async () => ({ cost: 0, tasks: [{ status_code: 20000, result: [{ aggregated_metrics: { sources_domain: [] }, items: [] }] }] }) };
  };

  await m.landscape({ keywords: ['best bank'], market: 'SA', platform: 'google' });
  assert.equal(sent.language_code, 'ar', 'Saudi Arabia must be queried in Arabic');
  await m.landscape({ keywords: ['best bank'], market: 'AE', platform: 'google' });
  assert.equal(sent.language_code, 'en');

  global.fetch = realFetch;
});

await test('the location map covers every market in the index', async () => {
  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  const m = await import('../src/lib/mentions.js?loc=1');
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push(JSON.parse(opts.body)[0].location_name);
    return { ok: true, json: async () => ({ cost: 0, tasks: [{ status_code: 20000, result: [{ aggregated_metrics: { sources_domain: [] }, items: [] }] }] }) };
  };

  const countries = [...new Set(mena.MENA_SECTORS.flatMap((s) => s.members.map((x) => x.country)))];
  for (const c of countries) await m.landscape({ keywords: ['best bank'], market: c, platform: 'google' });
  global.fetch = realFetch;

  // An unmapped country silently falls back to the United States, which would
  // publish American figures under an Arab headline.
  assert.ok(!seen.includes('United States'), `an unmapped country fell back to the US: ${JSON.stringify(seen)}`);
  assert.equal(seen.length, countries.length);
});

console.log('\ncategory landscape');

await test('reads the real response and turns domains into a brand ranking', async () => {
  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  const m = await import('../src/lib/mentions.js?real=1');
  const realFetch = global.fetch;

  // Trimmed from an actual response. brand_entities_title comes back empty,
  // which is why there is no separate brand endpoint to read: the domains
  // cited in the aggregate are the brands.
  const REAL = { cost: 0.2, tasks: [{ status_code: 20000, cost: 0.2, result: [{
    total_count: 8528,
    aggregated_metrics: {
      sources_domain: [
        { key: 'www.emiratesnbd.com', mentions: 17229, ai_search_volume: 15519700 },
        { key: 'www.youtube.com', mentions: 13742, ai_search_volume: 12518910 },
        { key: 'www.adcb.com', mentions: 11128, ai_search_volume: 9548000 },
        { key: 'www.hsbc.ae', mentions: 7909, ai_search_volume: 7005040 }
      ],
      brand_entities_title: [],
      total: { mentions: 75279, ai_search_volume: 70952270 }
    },
    items: [
      { domain: 'www.youtube.com', total: { mentions: 2851 } },
      { domain: 'www.mashreq.com', total: { mentions: 386 } }
    ]
  }] }] };

  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, json: async () => REAL }; };
  const d = await m.landscape({ keywords: ['banks uae'], market: 'AE', platform: 'google' });
  global.fetch = realFetch;

  assert.equal(calls, 1, 'one call per keyword, because each costs twenty cents');
  assert.equal(d.cost, 0.2, 'the real cost must be reported, not an estimate');
  assert.equal(d.totalCount, 8528);

  // Platforms are in every category and say nothing about who leads it.
  assert.ok(!d.brands.some((b) => b.domain === 'youtube.com'), 'youtube is not a brand in this ranking');
  assert.equal(d.brands[0].domain, 'emiratesnbd.com');
  assert.ok(d.brands[0].share > 0, 'share of voice must be computed');

  // But it should still be visible in the unfiltered list, since a platform
  // high in a category is itself a channel worth being on.
  assert.ok(d.domains.some((r) => r.domain === 'youtube.com'), 'the unfiltered list keeps platforms');
  assert.ok(d.domains.length > d.brands.length);
});

await test('domains become readable names', async () => {
  const m = await import('../src/lib/mentions.js?names=1');
  assert.equal(m.brandFromDomain('www.emiratesnbd.com'), 'Emiratesnbd');
  assert.equal(m.brandFromDomain('property-finder.ae'), 'Property Finder');
  // A model call improves these where a key is present; this is the floor.
});

await test('a business description is reduced to a usable keyword', async () => {
  const m = await import('../src/lib/mentions.js?kw=1');

  // The Setup fields hold prose written for a person. Sending it raw returns
  // nothing, and the repetition around a separator produced duplicate words.
  const long = 'full-service digital marketing agency | full-service digital marketing agency businesses in gulf, uae, saudi seeking seo, ppc and ecommerce marketing';
  const kw = m.toKeyword(long);
  assert.ok(kw.split(' ').length <= 4, `too long: ${kw}`);
  assert.equal(new Set(kw.split(' ')).size, kw.split(' ').length, `duplicate words: ${kw}`);
  assert.ok(/digital marketing agency/.test(kw), `lost the meaning: ${kw}`);

  assert.equal(m.toKeyword('orthodontic clinic'), 'orthodontic clinic');
  assert.equal(m.toKeyword('personal and corporate banking services'), 'personal corporate banking');
});

await test('refuses to query with no usable keyword', async () => {
  const m = await import('../src/lib/mentions.js?empty=1');
  await assert.rejects(() => m.landscape({ keywords: [''], market: 'AE' }), /No usable category keyword/);
  await assert.rejects(() => m.landscape({ keywords: ['x'], market: 'AE' }), /No usable category keyword/);
});

await test('each platform gets the parameters it accepts', async () => {
  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  const m = await import('../src/lib/mentions.js?params=1');
  const realFetch = global.fetch;
  let sent = null;
  global.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body)[0];
    return { ok: true, json: async () => ({ cost: 0.2, tasks: [{ status_code: 20000, result: [{ aggregated_metrics: { sources_domain: [] }, items: [] }] }] }) };
  };

  await m.landscape({ keywords: ['banks uae'], market: 'AE', platform: 'google' });
  assert.equal(sent.location_name, 'United Arab Emirates', 'Google needs a location, that is the point');

  // "Invalid Field: 'location_name'." The ChatGPT corpus covers one market,
  // so there is no location to choose and sending one is rejected.
  await m.landscape({ keywords: ['banks uae'], market: 'AE', platform: 'chat_gpt' });
  assert.equal(sent.location_name, undefined, 'ChatGPT rejects location_name outright');
  assert.equal(sent.platform, 'chat_gpt');
  assert.equal(sent.language_code, 'en');

  global.fetch = realFetch;
});

await test('warns when the platform does not cover the market', async () => {
  const m = await import('../src/lib/mentions.js?cov=1');
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ tasks: [{ status_code: 20000, result: [{ items: [] }] }] }) });

  // ChatGPT is United States only in this dataset, which matters a great deal
  // if the customer is anywhere else.
  const uae = await m.landscape({ keywords: ['banks uae'], market: 'AE', platform: 'chat_gpt' });
  assert.ok(/United States only/i.test(uae.coverageWarning));
  assert.ok(/United Arab Emirates/i.test(uae.coverageWarning), 'name the market it does not cover');

  // In the US the same dataset is exactly right, so say so rather than warn.
  const us = await m.landscape({ keywords: ['banks usa'], market: 'US', platform: 'chat_gpt' });
  assert.ok(/matches your market/i.test(us.coverageWarning));

  const google = await m.landscape({ keywords: ['banks uae'], market: 'AE', platform: 'google' });
  assert.equal(google.coverageWarning, null, 'Google covers all locations');

  global.fetch = realFetch;
});

console.log('\ngoogle ai surfaces');

await test('AI Overview parses, and an absent overview is not an error', async () => {
  process.env.MOCK_MODE = 'false';
  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  const { askEngine: live } = await import('../src/lib/dataforseo.js?serp=1');
  const realFetch = global.fetch;
  const respond = (items) => ({
    ok: true,
    json: async () => ({ cost: 0.002, tasks: [{ status_code: 20000, cost: 0.002, result: [{ items }] }] })
  });

  global.fetch = async () => respond([
    { type: 'organic', title: 'x' },
    { type: 'ai_overview', text: 'Clear aligners in Dubai cost AED 12,000 to AED 20,000.',
      references: [{ url: 'https://marinasmile.ae/pricing' }, { url: 'https://clinicb.ae/x' }] }
  ]);
  const present = await live({ engine: 'ai_overview', prompt: 'aligner cost dubai', market: 'AE' });
  assert.equal(present.ok, true, 'a present overview must parse');
  assert.ok(present.text.includes('AED 12,000'));
  assert.deepEqual(present.citations.map((c) => c.domain), ['marinasmile.ae', 'clinicb.ae']);
  assert.equal(present.costUsd, 0.002, 'cost must be recorded, not dropped');

  // Google only shows an overview for some queries. That is a finding.
  global.fetch = async () => respond([{ type: 'organic', title: 'x' }]);
  const absent = await live({ engine: 'ai_overview', prompt: 'q', market: 'AE' });
  assert.equal(absent.ok, true);
  assert.equal(absent.absent, true);
  assert.equal(absent.error, null, 'no overview is not a failure');

  global.fetch = realFetch;
});

await test('the async overview flag is on unless turned off', async () => {
  process.env.MOCK_MODE = 'false';
  delete process.env.AI_OVERVIEW_ASYNC;
  const { askEngine: live } = await import('../src/lib/dataforseo.js?flag=1');
  const realFetch = global.fetch;
  let sent = null;
  global.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body)[0];
    return { ok: true, json: async () => ({ tasks: [{ status_code: 20000, result: [{ items: [{ type: 'ai_overview', text: 'x' }] }] }] }) };
  };
  await live({ engine: 'ai_overview', prompt: 'q', market: 'AE' });
  global.fetch = realFetch;

  // Turning this off stopped the errors and also stopped the data: a study
  // run returned 0 usable AI Overview answers from 31 prompts, which reads as
  // developers being absent when the overview was never fetched at all. A
  // visible failure is better than a silent zero.
  assert.equal(sent.load_async_ai_overview, true, 'must be on by default');
  assert.equal(sent.location_name, 'United Arab Emirates');

  // And it must still be possible to turn off.
  process.env.AI_OVERVIEW_ASYNC = 'false';
  const { askEngine: off } = await import('../src/lib/dataforseo.js?flagoff=1');
  const realFetch2 = global.fetch;
  let sentOff = null;
  global.fetch = async (url, opts) => {
    sentOff = JSON.parse(opts.body)[0];
    return { ok: true, json: async () => ({ tasks: [{ status_code: 20000, result: [{ items: [{ type: 'ai_overview', text: 'x' }] }] }] }) };
  };
  await off({ engine: 'ai_overview', prompt: 'q', market: 'AE' });
  global.fetch = realFetch2;
  delete process.env.AI_OVERVIEW_ASYNC;
  assert.equal(sentOff.load_async_ai_overview, undefined);
});

console.log('\nengine catalogue');

await test('covers every surface DataForSEO can reach, and nothing it cannot', () => {
  assert.deepEqual(ENGINE_IDS.sort(), ['ai_mode','ai_overview','chatgpt','claude','gemini','perplexity'].sort());
  for (const bogus of ['copilot','grok','deepseek','meta_ai']) {
    assert.equal(ENGINES[bogus], undefined, `${bogus} is not available via DataForSEO and must not be offered`);
  }
});

await test('each engine declares how it is fetched and explains itself', () => {
  for (const id of ENGINE_IDS) {
    const e = ENGINES[id];
    assert.ok(['llm','serp'].includes(e.kind), `${id} has no kind`);
    assert.ok(e.label && e.label.length > 2, `${id} has no label`);
    assert.ok(e.note && e.note.length > 20, `${id} needs a note explaining when to use it`);
    // model_name is resolved from DataForSEO's own list at call time rather
    // than hard-coded here, so the catalogue only needs the path.
    if (e.kind === 'llm') assert.ok(e.path, `${id} needs a path`);
    if (e.kind === 'serp') assert.ok(e.mode, `${id} needs a serp mode`);
  }
});

await test('the plan ceiling never exceeds what exists', () => {
  for (const id of PLAN_ORDER) {
    assert.ok(PLANS[id].engines <= ENGINE_IDS.length,
      `${id} allows ${PLANS[id].engines} engines but only ${ENGINE_IDS.length} exist`);
  }
});

await test('SERP engines have a location for the markets we default to', () => {
  for (const code of ['AE','SA','GB','US','EG']) {
    assert.ok(LOCATIONS[code], `no SERP location mapped for ${code}`);
  }
});

console.log('\nnothing runs unattended');

await test('no scheduler is wired into the app itself', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dirs = ['../src', '../src/lib', '../src/jobs'];
  const offenders = [];

  for (const d of dirs) {
    const base = new URL(d + '/', import.meta.url);
    for (const f of readdirSync(base)) {
      if (!f.endsWith('.js')) continue;
      const body = readFileSync(new URL(f, base), 'utf8');
      // A timer or cron inside the server would spend money on its own
      // schedule, which is exactly what must not happen.
      if (/setInterval\s*\(|node-cron|cron\.schedule\s*\(/.test(body)) offenders.push(d + '/' + f);
    }
  }
  assert.deepEqual(offenders, [], `these files schedule work on their own: ${offenders.join(', ')}`);
});

await test('a new site does not schedule itself', async () => {
  const { readFileSync } = await import('node:fs');
  const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');

  // Anything that defaults to on means a customer adding a site starts
  // spending without having asked for it.
  assert.ok(/auto_cycle BOOLEAN NOT NULL DEFAULT false/.test(schema), 'auto_cycle must default to false');
  assert.ok(!/auto_cycle BOOLEAN NOT NULL DEFAULT true/.test(schema));
});

await test('running every site has to be asked for explicitly', async () => {
  const { readFileSync } = await import('node:fs');
  const job = readFileSync(new URL('../src/jobs/runCycle.js', import.meta.url), 'utf8');

  // `npm run cycle` with no arguments used to run every site with auto_cycle
  // on, which is a surprising amount of money for a bare command.
  assert.ok(/--all/.test(job), 'the all-sites path needs an explicit flag');
  assert.ok(/Nothing run/.test(job), 'and a bare invocation must refuse and say so');
});

console.log('\npartial runs');

await test('nothing spends money on a single ambiguous click', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // The button ran everything on click with a separate arrow for the options,
  // so someone reaching for the menu spent a full cycle by accident.
  assert.ok(!/id="runMoreBtn"/.test(html), 'the separate arrow is gone');
  assert.ok(/id="runBtn" aria-haspopup="true"/.test(html), 'the whole control opens the menu');
  assert.ok(/id="runFullBtn"/.test(html), 'running everything is now an explicit choice');

  const handler = app.slice(app.indexOf("$('runBtn').addEventListener"), app.indexOf("$('runFullBtn')"));
  assert.ok(!/startCycle/.test(handler), 'the button itself must not start a cycle');
  assert.ok(/runMenu'\)\.hidden = open/.test(handler), 'it toggles the menu');

  // Both options carry their size, so neither is chosen blind.
  assert.ok(/checksAll/.test(app) && /checksUnrun/.test(app), 'each choice shows what it costs');
});

await test('a partial run joins the last cycle rather than starting one', async () => {
  const { readFileSync } = await import('node:fs');
  const job = readFileSync(new URL('../src/jobs/runCycle.js', import.meta.url), 'utf8');
  const fn = job.slice(job.indexOf('export async function runCycleForProject'), job.indexOf('const budget'));

  // Its own cycle would produce a trend point measured over three questions
  // where the one before covered sixty, which reads as a collapse or a spike
  // that never happened.
  assert.ok(/only === 'unrun' && latest/.test(fn), 'a partial run must reuse the latest cycle date');
  assert.ok(/NOT EXISTS \(SELECT 1 FROM runs/.test(fn), 'and select only questions with no answers');
});

await test('a partial run with nothing to do says so', async () => {
  const { readFileSync } = await import('node:fs');
  const job = readFileSync(new URL('../src/jobs/runCycle.js', import.meta.url), 'utf8');

  // Silently running zero questions and reporting success would look like a
  // cycle that measured nothing.
  assert.ok(/nothingToDo: true/.test(job));
  assert.ok(/Every active question has already been asked/.test(job));

  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.ok(/none waiting/.test(app), 'and the menu must show when there is nothing waiting');
  assert.ok(/checksUnrun/.test(app), 'with the cost of the choice attached');
});

console.log('\ntopic questions');

await test('a generated question never contains the brand name', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/prompts.js', import.meta.url), 'utf8');
  const fn = lib.slice(lib.indexOf('export async function questionsForTopic'), lib.indexOf('export async function generatePrompts'));

  // A question that already names the brand measures nothing: of course the
  // answer mentions them when the question did.
  assert.ok(/Never include the brand name/.test(fn), 'the instruction must say so');
  assert.ok(/new RegExp\(String\(brand\)/.test(fn), 'and the output must be filtered regardless');

  // A keyword is not a question, and the gap between them is where this
  // measurement lives.
  assert.ok(/not a search keyword/.test(fn), 'a topic must become something a person would say');
});

await test('generated questions are approved, not saved', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  assert.ok(/prompts\/from-topic/.test(server), 'generation must be its own call');
  assert.ok(/duplicate: existing\.has/.test(server), 'and flag what is already tracked');
  assert.ok(/data-topicq/.test(app), 'with each suggestion chosen rather than saved');
  assert.ok(/already tracked/.test(app), 'and duplicates shown as such');

  // Nothing usable back is a real outcome and must not look like a silent
  // failure, which is how the persona panel first broke.
  assert.ok(/Nothing usable came back/.test(server), 'an empty result must say so');
});

await test('the composer sits above the list it adds to', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const panel = app.slice(app.indexOf('class="qcompose"'), app.indexOf('id="qList"'));

  // It was at the bottom, below sixty questions, which is where nobody looks.
  assert.ok(panel.length > 0 && panel.length < 1400, 'the composer must come before the list');
  assert.ok(/q_topic/.test(panel) && /q_add/.test(panel), 'with both actions together');
});

console.log('\nre-asking one question');

await test('an action about a question can open that question', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const card = app.slice(app.indexOf('<div class="rec-foot">'), app.indexOf('data-task-edit'));

  // A decline alert had no button at all: it said visibility fell and left
  // the reader to go and find out where, which is the part that needed doing.
  assert.ok(/ev\.prompt_id/.test(card), 'a question-level action must offer its question');
  assert.ok(/data-see-answer="\$\{ev\.prompt_id\}"/.test(card), 'to read the answers');
  assert.ok(/data-reask="\$\{ev\.prompt_id\}"/.test(card), 'and to ask again');
});

await test('two views of one question do not fill each other', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // The same question appears on the Questions tab and on an action card. A
  // shared element id meant clicking one filled the other, invisibly.
  assert.ok(!/id="answers-\$\{/.test(app), 'no shared id between the two');
  assert.ok(/see\.closest\('\.rec, \.prompt'\)/.test(app), 'the panel is found relative to its button');
});

await test('an action says what it is, in words, and does not look pressable', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/public/styles.css', import.meta.url), 'utf8');
  const rec = readFileSync(new URL('../src/lib/recommend.js', import.meta.url), 'utf8');

  // "decline alert" is a field name. Shown raw, styled like the buttons
  // beside it, it read as a control that did nothing when clicked.
  assert.ok(/TYPE_LABEL/.test(app), 'types need readable labels');
  assert.ok(!/t\.type\.replace\(\/_\/g, ' '\)}<\/span>/.test(app), 'the raw type must not be the visible text');

  // Every type the rules can produce needs one, or a new rule silently ships
  // jargon to customers.
  const types = [...rec.matchAll(/type: '([a-z_]+)'/g)].map((m) => m[1]);
  const labels = app.slice(app.indexOf('const TYPE_LABEL'), app.indexOf('function taskCard'));
  for (const t of new Set(types)) {
    assert.ok(labels.includes(`${t}:`), `${t} has no readable label`);
  }

  // And it must not look like something you can press.
  const style = css.slice(css.indexOf('.tag.kind {'), css.indexOf('.tag.kind {') + 400);
  assert.ok(/cursor: default/.test(style));
  assert.ok(/border: none/.test(style));
});

await test('a sound answer is kept, a broken one is replaced', async () => {
  const { readFileSync } = await import('node:fs');
  const job = readFileSync(new URL('../src/jobs/runCycle.js', import.meta.url), 'utf8');
  const fn = job.slice(job.indexOf('export async function reaskPrompt'));

  // Two things could be true when a stored answer disagrees with a manual
  // check: the measurement was broken, or the engine genuinely varies. Those
  // want different treatment.
  assert.ok(/looksTruncated/.test(fn), 'a truncated answer must be recognised');
  assert.ok(/const broken = existing\.filter\(\(r\) => !r\.ok \|\| looksTruncated/.test(fn));
  assert.ok(/DELETE FROM runs WHERE id = ANY/.test(fn), 'and a failed measurement replaced');

  // A completed answer that simply did not name the brand is evidence.
  // Deleting it because someone dislikes the result would be dishonest.
  assert.ok(/sound\.length \? Math\.max/.test(fn), 'a sound answer is kept and the new one added alongside');
});

await test('re-asking is charged and bounded like anything else', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/prompts/:promptId/reask'"), server.indexOf('/* ---------------- page checks'));

  assert.ok(/budgetForCycle/.test(route), 'it must count against the allowance');
  assert.ok(/org_id = \$2/.test(route), 'and be scoped to the account');

  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  // Silently changing a number would hide which of the two cases happened.
  assert.ok(/have been replaced/.test(app), 'the UI must say what happened to the old answers');
});

console.log('\nanswer evidence');

await test('a brand made of ordinary words is still detected', async () => {
  const { analyseRun } = await import('../src/lib/analyze.js?det=1');

  // "The Family Office" is a generic phrase and a real brand. If a table row
  // naming it first were read as not named, every finding for that customer
  // would be wrong.
  const text = [
    'Several established firms provide family wealth management services in Riyadh.',
    'Firm\tMain strengths',
    'The Family Office\tIndependent wealth management, private markets',
    'UBS Saudi Arabia\tFamily-office advisory, estate planning',
    'Jadwa Investment\tShariah-compliant public markets'
  ].join('\n');

  const entities = [
    { id: 1, name: 'The Family Office', aliases: ['TFO'], domain: 'tfoco.com', kind: 'owned' },
    { id: 2, name: 'UBS', aliases: [], domain: 'ubs.com', kind: 'competitor' }
  ];

  const out = await analyseRun({ text, entities, useModel: false });
  const mine = out.find((r) => r.entity_id === 1);
  assert.equal(mine.mentioned, true, 'the brand is named in the table');
  assert.equal(mine.ordinal, 1, 'and named first');
});

await test('the answer panel explains why a manual check differs', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // Everyone checks a surprising result by asking the engine themselves and
  // finds a different answer. Without this the tool looks broken when it is
  // measuring the thing it says it measures.
  assert.ok(/fresh, signed-out session/.test(app), 'the panel must say what was measured');
  assert.ok(/history, saved memories and location/.test(app), 'and why a personal check differs');
  assert.ok(/only this one describes what a stranger sees/.test(app), 'without implying the customer is wrong');
});

await test('a truncated answer cannot support "not named"', async () => {
  const { looksTruncated } = await import('../src/lib/analyze.js?t=1');
  const atCeiling = 'x'.repeat(7300);

  // A category question often returns a long list, and the brand being
  // measured is frequently near the bottom of it. 700 tokens cut answers off
  // mid-table and recorded a confident absence from a fragment.
  assert.equal(looksTruncated(atCeiling + ' | The Family Office | Bahrain', 2000), true);
  assert.equal(looksTruncated(atCeiling + ' and that is the full picture.', 2000), false);
  assert.equal(looksTruncated('A short, complete answer.', 2000), false);
  assert.equal(looksTruncated('', 2000), false);
});

await test('the answer ceiling is high enough to hold a list', async () => {
  const { readFileSync } = await import('node:fs');
  const df = readFileSync(new URL('../src/lib/dataforseo.js', import.meta.url), 'utf8');
  const job = readFileSync(new URL('../src/jobs/runCycle.js', import.meta.url), 'utf8');

  assert.ok(/maxTokens = 2000/.test(df), 'the default must not cut a long answer short');
  assert.ok(/MAX_OUTPUT_TOKENS \|\| 2000/.test(job), 'and the cycle must use the same figure');
});

await test('any verdict can be checked against the answer', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // A percentage nobody can check is a claim. The answers were stored all
  // along and simply never shown.
  assert.ok(/prompts\/:promptId\/answers/.test(server), 'the stored answers must be reachable');
  assert.ok(/response_text/.test(server), 'in full, not as a snippet');
  assert.ok(/truncated: looksTruncated/.test(server), 'and flagged when they were cut off');
  assert.ok(/data-see-answer/.test(app), 'with a way to read them from the question');
  assert.ok(/cut short/.test(app), 'and the truncation shown where the verdict is');
});

console.log('\ntrend chart');

await test('a series can be switched off without moving the others', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // Six overlapping lines is a picture rather than an instrument.
  assert.ok(/data-series="\$\{i\}"/.test(app), 'each series needs a toggle');
  assert.ok(/class="seriesline" data-series/.test(app), 'and a line it can hide');

  // Rescaling on toggle would make the remaining lines jump, which reads as
  // the data changing rather than the view.
  const handler = app.slice(app.indexOf("const key = e.target.closest('[data-series][data-chart]')"), app.indexOf('function chartHover'));
  assert.ok(/style\.display =/.test(handler), 'hiding is display only');
  assert.ok(!/y\(|rescale|Math\.max/.test(handler), 'the axis must not move');
});

await test('hovering reads out every visible value at that date', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // A native SVG title needs an exact hit on a three-pixel dot, which on a
  // touchscreen is no tooltip at all.
  assert.ok(/class="hitzone"/.test(app), 'a hit area per date, not per dot');
  assert.ok(/crosshair/.test(app), 'with a marker showing which date');

  // The readout must follow what is switched on, or it reports lines that
  // are not on screen.
  const fn = app.slice(app.indexOf('function chartHover'), app.indexOf("document.addEventListener('mouseover'"));
  assert.ok(/serieskey\.is-on/.test(fn), 'only visible series are listed');
  assert.ok(/sort\(\(a, b\) => b\.values\[date\] - a\.values\[date\]\)/.test(fn), 'ordered by value at that date');
});

console.log('\nquestion list');

await test('filters narrow together rather than replacing each other', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('function applyQuestionView'), app.indexOf('document.addEventListener(\'click\', (e) => {\n  const chip'));

  // Picking one filter and having it silently clear another is the usual way
  // a list like this stops being trustworthy.
  for (const g of ['state', 'persona', 'cluster', 'intent']) {
    assert.ok(new RegExp(`qState\\.${g}`).test(fn), `${g} must take part in the same test`);
  }
  assert.ok(/qState\.text/.test(fn), 'and the search box with them');

  // Leaving a filter set when moving between sites would quietly hide rows.
  assert.ok(/state: 'all', persona: 'all'/.test(app), 'the view must reset when it opens');
});

await test('an unmeasured question does not sort as the worst performer', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const i = app.indexOf('function applyQuestionView');
  const fn = app.slice(i, app.indexOf('document.addEventListener', i));

  // Never asked carries -1 so it is distinguishable from a measured zero.
  // Sorting least-visible-first must not put "not asked yet" at the top as
  // though it were the biggest problem.
  assert.ok(fn.includes("< 0 ? 2 :"), 'unmeasured must sort last when ranking by visibility');
  assert.ok(fn.includes("< 0 ? 0 :"), 'and score zero for opportunity rather than maximum');
});

await test('long filter lists are dropdowns, and still combine', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // Topic and intent can each run to a dozen values. As chips they filled
  // three rows of the toolbar before a single question was visible.
  assert.ok(/id="qcluster" data-select-group="cluster"/.test(app), 'topic must be a dropdown');
  assert.ok(/id="qintent" data-select-group="intent"/.test(app), 'and intent');

  // The point of the filters is that they narrow together. Moving two of
  // them into dropdowns must not quietly take them out of that.
  const handler = app.slice(app.indexOf("if (e.target.id === 'qsort')"), app.indexOf("if (e.target.id === 'qsort')") + 700);
  assert.ok(/dataset\?\.selectGroup/.test(handler), 'a dropdown must feed the same filter state');
  assert.ok(/qState\[group\] = e\.target\.value/.test(handler));

  // And reopening the view must reset the controls, not just the state
  // behind them, or a stale selection would show while everything is listed.
  assert.ok(/data-select-group\]'\)\) el\.value = 'all'/.test(app), 'the dropdowns must reset with the rest');
});

await test('the default sort puts the work first', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // Most asked and least visible is where the work is. Alphabetical or raw
  // insertion order tells someone nothing about where to start.
  assert.ok(/sort: 'opportunity'/.test(app), 'opportunity must be the default');
  assert.ok(/1 - num\(r, 'rate'\)/.test(app), 'and combine visibility with volume');
});

console.log('\npage checks');

await test('no overview is kept apart from not being cited', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/pagecheck.js', import.meta.url), 'utf8');

  // Three different outcomes: Google showed no overview, showed one without
  // you, or cited your site through a different page. Collapsing the first
  // into the second reports a Google decision as a failure of the page.
  assert.ok(/overview: false/.test(lib), 'a missing overview must be its own state');
  assert.ok(/noOverview/.test(lib), 'and detected rather than inferred from an empty answer');
  assert.ok(/pageCited: Boolean\(exact\)/.test(lib), 'the exact page must be matched, not just the domain');

  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.ok(/another page cited/.test(app), 'the middle case needs its own label');
  assert.ok(/Google's choice rather than yours/.test(app), 'and the absent case must not read as a failure');
});

await test('a page check never fails as a generic 500', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = server.indexOf("app.get('/api/projects/:id/page-checks/preview'");
  const block = server.slice(start, start + 1800);

  // Checking only for the chosen property let a project with a property and
  // no working token throw inside the Google client, where it became
  // "Something went wrong on our side" with nothing to act on.
  assert.ok(/ga4_refresh_token/.test(block), 'the credential must be checked, not just the property');
  assert.ok(/gsc_site_url/.test(block), 'and the property too');
  assert.ok(/try \{[\s\S]*?catch/.test(block), 'and anything Google throws must be caught here');
  assert.ok(/no longer valid/.test(block), 'with a message that names the actual problem');

  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const panel = app.slice(app.indexOf("const panel = $('pcPanel')"), app.indexOf("const panel = $('pcPanel')") + 900);
  assert.ok(/d\.fix === 'connect'/.test(panel), 'and every error must offer its fix');
});

await test('a branded search is flagged, not silently checked', async () => {
  const { isBranded } = await import('../src/lib/pagecheck.js?b=1');
  const project = { brand_name: 'The Family Office', name: 'The Family Office', domain: 'tfoco.com', aliases: ['TFO'] };

  // An AI Overview naming you for your own brand confirms nothing, and on
  // some brands those searches are most of the list.
  assert.equal(isBranded('the family office bahrain', project), true);
  assert.equal(isBranded('the family office company', project), true);
  assert.equal(isBranded('tfoco reviews', project), true, 'the domain stem counts too');

  // The generic category term is the one worth checking, and it must not be
  // caught just because the brand is made of ordinary words.
  assert.equal(isBranded('family office dubai', project), false);
  assert.equal(isBranded('family offices in uae', project), false);
  assert.equal(isBranded('how to choose a family office', project), false);
});

await test('every search is fetched, not the first page of them', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/pagecheck.js', import.meta.url), 'utf8');
  const fn = lib.slice(lib.indexOf('export async function fetchPageQueries'), lib.indexOf('export async function checkQuery'));

  // A single request capped the list at whatever came back first, so a site
  // with a thousand searches saw a fraction and had no way to know what was
  // missing.
  assert.ok(/startRow/.test(fn), 'the fetch must paginate');
  assert.ok(/rows\.length < PAGE/.test(fn), 'and stop when a short page comes back');

  // One impression is a real impression. Ten was us deciding the tail did
  // not matter on the customer's behalf.
  assert.ok(/minImpressions = 1/.test(fn), 'the floor must not silently drop the tail');
});

await test('the folders offered are the site\'s own, not an example', async () => {
  const { sectionsFrom } = await import('../src/lib/pagecheck.js?sec=1');

  const rows = [];
  for (let i = 0; i < 6; i++) rows.push({ page: `https://x.com/en/insights/articles/p${i}`, impressions: 100 });
  for (let i = 0; i < 4; i++) rows.push({ page: `https://x.com/en/insights/reports/r${i}`, impressions: 80 });
  rows.push({ page: 'https://x.com/en/', impressions: 500 });

  const found = sectionsFrom(rows).map((s) => s.path);

  // A hardcoded example is wrong for everyone except the site it came from,
  // and /insights/articles appeared on every project because it came from one.
  assert.ok(found.includes('/en/insights'), 'the real folders must be discovered');
  assert.ok(found.includes('/en/insights/articles'), 'at more than one depth');

  // A segment covering a single page is just that page, and offering it as a
  // section is noise.
  assert.ok(!sectionsFrom([{ page: 'https://x.com/only', impressions: 5 }]).length);
});

await test('a section of a site can be checked on its own', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/pagecheck.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // Filtering at Search Console rather than pulling everything and throwing
  // most of it away, and it is how someone actually asks the question.
  assert.ok(/dimensionFilterGroups/.test(lib), 'the path filter must go to the API');
  assert.ok(/dimension: 'page', operator: 'contains'/.test(lib));
  assert.ok(/pcPath/.test(app), 'and be offered in the interface');

  // The placeholder must not be one site's paths shown to every customer.
  assert.ok(!/placeholder="\/insights\/articles"/.test(app), 'no hardcoded example path');
  assert.ok(/a folder, or one full URL/.test(app), 'and it must say a full URL works');
  assert.ok(/data-pcsection/.test(app), 'with the site\'s own sections offered');
});

await test('a long list opens shut', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // Hundreds of searches across dozens of pages is unreadable fully expanded.
  assert.ok(/d\.pages\.length > 6/.test(app), 'groups must collapse once there are enough to matter');
  assert.ok(/data-pctoggle/.test(app), 'and be openable');
  // A match inside a shut group would otherwise be invisible.
  assert.ok(/if \(needle && anyVisible\) g\.classList\.remove\('is-shut'\)/.test(app), 'searching must open what it finds');
});

await test('the picker decides what runs, not the server', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/pagecheck.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // Taking the top N whatever the customer ticked would make the picker
  // decorative and spend money on searches they excluded.
  assert.ok(/queries\?\.length/.test(lib), 'an explicit list must win over the default');
  assert.ok(/queries: \[\.\.\.document\.querySelectorAll\('\[data-pcq\]:checked'\)\]/.test(app.replace(/\s+/g, ' ')) || /data-pcq\]:checked/.test(app), 'the UI must send what was ticked');

  // A group box that starts unchecked while its children are ticked appears
  // to do nothing on first click.
  assert.ok(/const allOn = kids\.every/.test(app), 'the group toggle must follow its children');
  assert.ok(/indeterminate/.test(app), 'and show a partial state');
});

await test('a page check states its cost before running', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  assert.ok(/page-checks\/preview/.test(server), 'there must be a preview before the spend');
  assert.ok(/estimateUsd/.test(server), 'with a figure');
  assert.ok(/costs about/.test(app), 'shown to the person clicking');
});

await test('a url is matched exactly, not by domain', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/pagecheck.js', import.meta.url), 'utf8');

  // A trailing slash or a www should not decide whether a page counts as
  // cited, and neither should a scheme.
  const strip = new Function('u', 'return String(u || "").replace(/^https?:\\/\\//, "").replace(/^www\\./, "").replace(/\\/$/, "").toLowerCase();');
  assert.equal(strip('https://www.x.com/a/'), strip('http://x.com/a'));
  assert.notEqual(strip('https://x.com/a'), strip('https://x.com/b'));
  assert.ok(/sameUrl/.test(lib), 'and the comparison must be a named thing, not inline');
});

console.log('\nrun cadence');

await test('one run per question is the default, and the copy agrees', async () => {
  const { readFileSync } = await import('node:fs');
  const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../src/public/landing.html', import.meta.url), 'utf8');
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, '');

  assert.ok(/runs_per_cycle INTEGER NOT NULL DEFAULT 1/.test(schema), 'one run by default');

  // Three runs bought a variance figure. Charging every customer three times
  // over for it by default is a different decision, and the copy must not go
  // on claiming something the product no longer does.
  assert.ok(!/One run is noise/.test(visible), 'that line contradicts the default');
  assert.ok(!/asks each question several times/.test(visible), 'and so does that one');
  assert.ok(!/with three runs\s+each/.test(visible), 'and the pricing example');

  // The honest argument for percentages does not depend on repeat runs.
  assert.ok(/there is no rank to report/i.test(visible), 'percentages need a reason that is still true');
  // And repeat runs remain available, described for what they actually buy.
  assert.ok(/raise the runs per question/i.test(visible), 'variance should still be offered');
});

console.log('\nexport');

await test('the export keeps misses and never merges cited with mentioned', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/export.js', import.meta.url), 'utf8');

  // A file filtered to citations answers the easy question and hides the
  // useful one. Misses are the point.
  assert.ok(/LEFT JOIN mentions/.test(src), 'a run with no mention must still produce a row');
  assert.ok(/mine \? 'TRUE' : 'FALSE'/.test(src), 'cited is TRUE or FALSE, never absent');
  assert.ok(/r\.mentioned \? 'TRUE' : 'FALSE'/.test(src));

  // An answer can name a brand without linking to it, which is the more
  // common case and the whole reason these are two columns.
  const header = src.slice(src.indexOf('const header = ['), src.indexOf('if (withAnswers) header.push'));
  assert.ok(/'cited'/.test(header) && /'mentioned'/.test(header), 'both columns are required');
  assert.ok(header.indexOf("'cited'") < header.indexOf("'mentioned'"));
});

await test('the export says what it does not cover', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/export.js', import.meta.url), 'utf8');

  // Copilot and Grok are not queried at all. Silence would read as a nil
  // return rather than no measurement, which is a different claim.
  assert.ok(/Copilot and Grok are not covered/.test(src));
  assert.ok(/not a nil return, it is no measurement/.test(src));
  assert.ok(/Bing Webmaster Tools/.test(src), 'and the overlap question must be answered');

  // A reworded prompt is a delete and an add, so ids do not carry across.
  assert.ok(/reworded prompt is a delete and an add/.test(src), 'the id limitation must be stated');
  assert.ok(/inferred from created_at/.test(src), 'and reconstructed history labelled as such');
});

await test('prompt changes are recorded as they happen', async () => {
  const { readFileSync } = await import('node:fs');
  const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  assert.ok(/CREATE TABLE IF NOT EXISTS prompt_events/.test(schema));

  // A removal must be read before the row goes, or there is nothing to log.
  const del = server.slice(server.indexOf("app.delete('/api/prompts/:promptId'"), server.indexOf("app.post('/api/projects/:id/generate-prompts'"));
  assert.ok(del.indexOf('SELECT p.id, p.text') < del.indexOf('DELETE FROM prompts'), 'read it before deleting it');
  assert.ok(/'removed'/.test(del));
});

console.log('\ncitation sources');

await test('an action the evidence no longer supports is withdrawn', async () => {
  const { readFileSync } = await import('node:fs');
  const rec = readFileSync(new URL('../src/lib/recommend.js', import.meta.url), 'utf8');
  const fn = rec.slice(rec.indexOf('export async function persistRecommendations'));

  // Recommendations were only ever written, never withdrawn, so an action
  // outlived the thing behind it. Repointing citations away from a redirect
  // wrapper left the old action in place with nothing underneath it.
  assert.ok(/DELETE FROM recommendations/.test(fn), 'stale actions must be removed');
  assert.ok(/status = 'open'/.test(fn), 'but only open ones');

  // Someone who has started or finished a task should not find it vanished
  // because this cycle read the world slightly differently.
  assert.ok(!/status IN \('open', 'doing'\)/.test(fn), 'work in progress must survive a rebuild');

  // A rebuild that produced nothing is a failure, not a reason to empty the
  // board.
  assert.ok(/if \(!written\.length\) return/.test(fn), 'an empty build must not wipe the list');
});

await test('our own plumbing is never a source', async () => {
  const { isSourceUrl } = await import('../src/lib/dataforseo.js?src=1');

  // The collector walks the whole response for keys containing "url", which
  // swept up the API's own envelope and every image thumbnail. 873 citations
  // for api.dataforseo.com is our plumbing showing through into a customer's
  // findings.
  assert.equal(isSourceUrl('https://api.dataforseo.com/v3/serp/task_get/1'), false);
  assert.equal(isSourceUrl('https://lh3.googleusercontent.com/p/AF1QipN'), false);
  assert.equal(isSourceUrl('https://www.gstatic.com/images/x.png'), false);
  assert.equal(isSourceUrl('https://example.com/photo.jpg'), false, 'an asset is not a page');

  // A search results page is navigation, not a publisher answering.
  assert.equal(isSourceUrl('https://www.google.com/search?q=family+office'), false);
  assert.equal(isSourceUrl('https://www.google.com/'), false);
  assert.equal(isSourceUrl('https://www.google.com/searchviewer/10?svid=CAwS'), false);

  // These matched only because "searchviewer" happens to start with "search",
  // and a publisher whose name starts the same way must not be caught by it.
  assert.equal(isSourceUrl('https://searchengineland.com/agency-guide'), true);
  assert.equal(isSourceUrl('https://www.searchenginejournal.com/guide'), true);

  // And the real ones must survive, including platforms that genuinely get
  // cited.
  assert.equal(isSourceUrl('https://en.wikipedia.org/wiki/Family_office'), true);
  assert.equal(isSourceUrl('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(isSourceUrl('https://www.linkedin.com/company/x'), true);
  assert.equal(isSourceUrl('https://titinroundtheworld.com/apps-for-traveling'), true);
});

await test('a local listing is separated, not silently binned', async () => {
  const { isLocalListing, isSourceUrl } = await import('../src/lib/dataforseo.js?loc=1');

  // Nobody can pitch a Maps listing, so it does not belong in the sources
  // table. But an answer built from business profiles rather than articles is
  // a different problem with a different fix, and deleting it quietly would
  // hide that.
  assert.equal(isLocalListing('https://www.google.com/maps/search/WRISE+Middle+East'), true);
  assert.equal(isLocalListing('https://www.google.com/searchviewer/10?svid=CAwS'), true);
  assert.equal(isLocalListing('https://en.wikipedia.org/wiki/Family_office'), false);

  assert.equal(isSourceUrl('https://www.google.com/maps/search/WRISE'), false, 'still not a source');
});

await test('a redirect wrapper is recognised, and a real page is not', async () => {
  const { isWrapper } = await import('../src/lib/resolve.js?w=1');

  // Google's AI surfaces cite a grounding redirect rather than the publisher,
  // so every one of those was recorded as a citation for Google: one invented
  // source with a huge count, and every genuine publisher missing.
  assert.equal(isWrapper('https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC'), true);
  assert.equal(isWrapper('https://www.google.com/url?q=https://navira.com/blog'), true);
  assert.equal(isWrapper('https://t.co/abc'), true);

  // Precision matters as much: a genuine page on a host that also wraps must
  // not be discarded.
  assert.equal(isWrapper('https://cloud.google.com/vertex-ai/docs'), false);
  assert.equal(isWrapper('https://www.naviracorporate.com/blog/difc-vs-adgm'), false);
  assert.equal(isWrapper('https://clutch.co/ae/agencies'), false);
});

await test('a wrapper never appears as a source to act on', async () => {
  const { readFileSync } = await import('node:fs');
  const rec = readFileSync(new URL('../src/lib/recommend.js', import.meta.url), 'utf8');

  // "vertexaisearch.cloud.google.com shapes 53 of your questions" is a bug
  // wearing a finding, and there is nothing the customer could do about it.
  assert.ok(/isWrapper/.test(rec), 'the rules must know what a wrapper is');
  // Filtered at the query so no later rule can reintroduce it, which is what
  // happened when it was filtered halfway down.
  const q = rec.slice(rec.indexOf('const sourceRows'), rec.indexOf('const ownCited'));
  assert.ok(/\)\)\.filter\(\(s\) => !isWrapper/.test(q), 'and filter at the source, not downstream');
});

await test('a failed resolution is retried, not frozen', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/resolve.js', import.meta.url), 'utf8');
  const fn = lib.slice(lib.indexOf('export async function resolveUrl'), lib.indexOf('export async function resolveAll'));

  // Caching failures permanently meant one missing header froze a link as
  // unresolvable for good, and the wrapper sat in the data looking like a
  // real source with nothing ever trying again.
  assert.ok(/cached\?\.target\) return/.test(fn), 'a success is trusted');
  assert.ok(/6 \* 3600_000/.test(fn), 'a failure is only trusted briefly');
  assert.ok(/reason/.test(fn), 'and the reason recorded so it can be diagnosed');
});

await test('the redirector is asked the way a browser asks', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/resolve.js', import.meta.url), 'utf8');

  // Without a browser user agent Google answers 403 and no Location header,
  // which is indistinguishable from a dead link.
  assert.ok(/User-Agent/.test(lib), 'a user agent must be sent');
  assert.ok(/Mozilla\/5\.0/.test(lib));

  // And some wrappers bounce with markup or script rather than a header.
  assert.ok(/http-equiv/.test(lib), 'a meta refresh must be read');
  assert.ok(/window\\.location/.test(lib) || /window\.location/.test(lib), 'and a script redirect');
});

await test('a citation is stored against the publisher', async () => {
  const { readFileSync } = await import('node:fs');
  const job = readFileSync(new URL('../src/jobs/runCycle.js', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src/lib/resolve.js', import.meta.url), 'utf8');

  assert.ok(/resolveAll/.test(job), 'wrappers must be followed before storing');
  assert.ok(/domain: domainOf\(r\.url\)/.test(job), 'and the domain taken from where it lands');

  // The same grounding link appears across many answers; asking fifty times
  // is slow and rude.
  assert.ok(/url_resolutions/.test(lib), 'resolutions must be remembered');
  // A failed follow must leave the honest wrapper rather than inventing a
  // publisher.
  assert.ok(/target \|\| url/.test(lib), 'an unresolved link stays as it is');
});

console.log('\naggregated report');

await test('the report can tell a recurring problem from a new one', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/report.js', import.meta.url), 'utf8');
  const rec = readFileSync(new URL('../src/lib/recommend.js', import.meta.url), 'utf8');

  // Recommendations upsert on fingerprint, so the live table holds only what
  // is true today. Without a per-cycle record, "this has been true for eight
  // weeks" cannot be said, which is the whole point of a report over time.
  assert.ok(/recommendation_history/.test(rec), 'each cycle must be recorded');
  assert.ok(/COUNT\(DISTINCT cycle_date\)/.test(lib), 'and counted');
  assert.ok(/standing/.test(lib) && /recurring/.test(lib), 'and classified by how long it has persisted');
});

await test('the cited-page sample says how it was gathered', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/report.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../src/lib/report-html.js', import.meta.url), 'utf8');

  // This section was built only from pages someone had clicked, so a pattern
  // from three hand-picked pages read exactly like one from thirty.
  assert.ok(/universe/.test(lib), 'the report must know how many pages could have been read');
  assert.ok(/thin: n < 8/.test(lib), 'and flag a sample too small to lean on');
  assert.ok(/How this was measured/.test(html), 'the page must state its own sample');
  assert.ok(/indicative rather than settled/.test(html), 'and say when to distrust it');
});

await test('cited pages are read automatically, not only on request', async () => {
  const { readFileSync } = await import('node:fs');
  const td = readFileSync(new URL('../src/lib/teardown.js', import.meta.url), 'utf8');
  const job = readFileSync(new URL('../src/jobs/runCycle.js', import.meta.url), 'utf8');

  assert.ok(/export async function teardownTopCited/.test(td), 'there must be an automatic pass');
  assert.ok(/ORDER BY COUNT\(\*\) DESC/.test(td), 'over the most cited pages');
  assert.ok(/<> \$3/.test(td), 'excluding our own, since the question is what others do');

  // The measurement is already stored by this point; a failed fetch must not
  // lose a cycle.
  const block = job.slice(job.indexOf('teardownTopCited'), job.indexOf('teardownTopCited') + 500);
  assert.ok(/catch/.test(block), 'and a failure here must not fail the cycle');
});

await test('the report does not claim a fix caused a change', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/report.js', import.meta.url), 'utf8');

  // Completed work and a visibility change sitting side by side invites the
  // reader to join them. Too much moves at once in these systems to attribute
  // a change to a single edit, and a report that implies otherwise is selling.
  assert.ok(/do not claim one caused the other/i.test(lib), 'the caveat must be explicit');
  assert.ok(/measurement did not run rather than returning zero/i.test(lib), 'and absence must not read as zero');
});

await test('the report is readable without the app', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../src/lib/report-html.js', import.meta.url), 'utf8');

  // It gets printed, emailed and forwarded, so it has to stand alone.
  assert.ok(/@page/.test(html), 'it must be printable');
  assert.ok(/page-break/.test(html), 'without splitting tables across pages');
  assert.ok(/How to read this/.test(html), 'and carry its own caveats');
  assert.ok(!/<script/.test(html), 'and need no javascript');
});

console.log('\ncontrast');

await test('no text is unreadable against what sits behind it', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/public/styles.css', import.meta.url), 'utf8');

  const hx = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const [la, lb] = [lum(a), lum(b)];
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const varOf = (name) => {
    const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
    assert.ok(m, `--${name} should be defined`);
    return hx(m[1]);
  };

  // The muted grey measured 3.3:1 against the paper background, which is
  // below the 4.5:1 needed to read comfortably at small sizes.
  for (const bg of ['paper', 'panel']) {
    const r = ratio(varOf('ink-3'), varOf(bg));
    assert.ok(r >= 4.5, `muted text on ${bg} is ${r.toFixed(2)}:1, below 4.5`);
  }

  // Red text on a red fill is the pairing that kept appearing.
  const alert = varOf('alert');
  assert.ok(ratio([255, 255, 255], alert) >= 4.5, 'white must be readable on the alert colour');

  const block = css.slice(css.indexOf('Red on red is never allowed'));
  const tagRule = block.slice(block.indexOf('.tag.overdue'));
  assert.ok(/background: transparent/.test(tagRule.slice(0, 200)), 'red tags carry no red fill');
  assert.ok(/color: var\(--paper\)/.test(block), 'and anything filled red takes light text');
});

await test('admin is a flag, and invisible to everyone else', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const guard = server.slice(server.indexOf('async function requireAdmin'), server.indexOf('async function assertProject'));

  // Matching on an email address means anyone who changes theirs to it gets
  // in, and scatters a hardcoded identity through the codebase.
  assert.ok(/internal FROM orgs/.test(guard), 'trust comes from the flag');
  assert.ok(!/omar@|sandstormdigital/.test(guard), 'no hardcoded identity');

  // 404 rather than 403: a page that denies you tells you it exists.
  assert.ok(/status\(404\)/.test(guard), 'it should not announce itself');

  for (const route of ['/api/admin/accounts', "app.delete('/api/admin/accounts/:orgId'"]) {
    const at = server.indexOf(route);
    assert.ok(at > -1 && server.slice(at, at + 120).includes('requireAdmin'), `${route} must be guarded`);
  }
});

await test('red text never sits on a red fill', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/public/styles.css', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../src/public/admin.html', import.meta.url), 'utf8');

  // A variant rule set the text red and won on specificity, so a filled red
  // button rendered red on red. The fill and the text it carries have to be
  // declared together or they drift apart again.
  const pairing = css.slice(css.indexOf('.ghost.danger:hover,'));
  assert.ok(/background: var\(--alert\)/.test(pairing) && /color: var\(--paper\)/.test(pairing),
    'the filled state must state its own text colour');

  // The admin page carries its own styles and does not inherit the guard.
  const local = admin.slice(admin.indexOf('.danger {'), admin.indexOf('</style>'));
  assert.ok(/\.danger:hover/.test(local), 'the admin page needs the pairing too');
  assert.ok(/color: #fff/.test(local));
});

await test('the admin link is only offered where it works', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  assert.ok(/adminLink.*hidden = !me\.admin/s.test(app), 'hidden unless the account is internal');

  // The link is a convenience; the route is the control. Showing or hiding a
  // link is not access control.
  const guard = server.slice(server.indexOf('async function requireAdmin'), server.indexOf('async function assertProject'));
  assert.ok(/internal FROM orgs/.test(guard), 'the route checks independently');
});

await test('an account is counted once, however many people are on it', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.get('/api/admin/accounts'"), server.indexOf('Remove an account and everything'));

  // Joining users to orgs multiplied every org-level figure by the number of
  // people on it, so a two-person account showed its spend twice and the
  // total was double the real one.
  assert.ok(!/JOIN users u ON u\.org_id = o\.id/.test(route), 'the row must not fan out across people');
  assert.ok(/json_agg/.test(route), 'people belong inside the account, not beside it');
  assert.ok(/FROM orgs o\n     LEFT JOIN subscriptions/.test(route), 'one row per org');

  // The figure that was wrong.
  assert.ok(/accounts\.reduce\(\(n, a\) => n \+ Number\(a\.spend_this_month/.test(route), 'spend is summed once per account');
});

await test('deleting an account refuses the two obvious mistakes', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.delete('/api/admin/accounts/:orgId'"), server.indexOf('/* ---------------- feedback'));

  // It cascades through every table, so the two cases that are almost always
  // a mistake are refused rather than confirmed away.
  assert.ok(/orgId === req\.session\.orgId/.test(route), 'you cannot delete yourself');
  assert.ok(/needsForce/.test(route), 'and a paying account needs a second look');
  assert.ok(/Cancel the subscription in Stripe first/.test(route), 'with the real consequence named');
});

console.log('\nsignup and passwords');

await test('signing up says an email is coming', async () => {
  const { readFileSync } = await import('node:fs');
  const login = readFileSync(new URL('../src/public/login.html', import.meta.url), 'utf8');

  // Dropping someone straight into the app meant the first they heard of
  // verification was an error when they clicked Run, after all the setup.
  assert.ok(/verificationSent/.test(login), 'the signup response must be acted on');
  assert.ok(/Check your email/.test(login), 'and the screen must say so');
  assert.ok(/works for two days/.test(login), 'with how long they have');
  // Collapsed first, since the copy wraps across lines in the markup.
  const flat = login.replace(/\s+/g, ' ');
  assert.ok(/unlocks running a cycle/.test(flat), 'and what it unlocks');

  // A resend has to be reachable from here, not only from inside the app.
  assert.ok(/id="resend"/.test(login));
  // And a forgotten password needs a way out from the sign-in screen.
  assert.ok(/id="forgot"/.test(login), 'reset must be reachable where people notice they need it');
});

await test('an unverified account is stopped before the work, not after', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  // The server enforces this regardless. The point here is when someone
  // finds out: on the control, rather than after choosing what to run.
  const handler = app.slice(app.indexOf("$('runBtn').addEventListener"), app.indexOf("$('runFullBtn')"));
  assert.ok(/state\.emailVerified === false/.test(handler), 'the run control must check first');
  assert.ok(handler.indexOf('emailVerified') < handler.indexOf("$('runMenu').hidden = open"), 'before opening the menu');
  assert.ok(/needs-verify/.test(app), 'and the button should look unavailable');
});

await test('a reset token is stored hashed, and works once', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/auth-email.js', import.meta.url), 'utf8');

  // A leaked database should not hand someone a set of working password
  // reset links, which is what storing them in plain text would do.
  assert.ok(/createHash\('sha256'\)/.test(lib), 'tokens must be hashed at rest');
  assert.ok(!/token_hash, \$3.*token\)/.test(lib), 'and the raw token never stored');

  // Marked used before the caller acts, so a mail client prefetching the link
  // cannot burn it and a double click cannot replay it.
  const consume = lib.slice(lib.indexOf('export async function consumeToken'), lib.indexOf('export function sendVerification'));
  assert.ok(/used_at IS NULL AND t\.expires_at > now\(\)/.test(consume), 'expired or used tokens are refused');
  assert.ok(consume.indexOf('UPDATE auth_tokens SET used_at') < consume.indexOf('return row'), 'burn it before returning it');
});

await test('an unverified address cannot spend, but can look around', async () => {
  const { readFileSync } = await import('node:fs');
  const billing = readFileSync(new URL('../src/lib/billing.js', import.meta.url), 'utf8');

  // Every free account carries an allowance that costs real money at the
  // provider, so the block belongs where money is spent.
  const budget = billing.slice(billing.indexOf('export async function budgetForCycle'), billing.indexOf('export async function ensureCustomer'));
  assert.ok(/verifiedEnough/.test(budget), 'running a cycle requires a confirmed address');

  const addSite = billing.slice(billing.indexOf('export async function checkCanAddSite'), billing.indexOf('export async function checkCanAddQuestions'));
  assert.ok(!/verifiedEnough/.test(addSite), 'but setting a site up must not be blocked');

  // Accounts that existed before verification did must not be locked out for
  // failing a test that did not exist.
  assert.ok(/first_user/.test(billing), 'older accounts are grandfathered');
});

await test('signups from one place are bounded', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/register'"), server.indexOf('/* ---------------- email verification'));

  assert.ok(/recentSignups/.test(route), 'a limit must exist');
  assert.ok(/429/.test(route), 'and refuse rather than fail silently');
  // Telling a stranger which addresses have accounts is a small leak that
  // costs nothing to avoid.
  const forgot = server.slice(server.indexOf("app.post('/api/password/forgot'"), server.indexOf("app.get('/reset'"));
  assert.ok(/sent: true/.test(forgot) && !/no account/i.test(forgot), 'forgot password must not confirm who exists');
});

console.log('\ninternal accounts');

await test('an internal account lifts the allowance but not the spend cap', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/lib/billing.js', import.meta.url), 'utf8');

  // The allowance protects margin on a sold plan, and there is no margin to
  // protect on our own account. The spend cap protects the provider balance
  // from a bug, and a bug does not care whose account it runs on.
  // Every commercial ceiling goes, not just the answer checks. Lifting one
  // and leaving the rest meant the account we use most kept hitting walls
  // built for customers.
  assert.ok(/monthlyCalls: Number\.MAX_SAFE_INTEGER/.test(src), 'checks must be unlimited');
  assert.ok(/sites: Number\.MAX_SAFE_INTEGER/.test(src), 'and sites');
  assert.ok(/questions: Number\.MAX_SAFE_INTEGER/.test(src), 'and questions per site');
  assert.ok(/engines: ENGINE_IDS\.length/.test(src), 'and every engine available');
  assert.ok(/monthlyBudgetUsd: INTERNAL_BUDGET/.test(src), 'spend must still be capped');
  assert.ok(/INTERNAL_MONTHLY_BUDGET/.test(src), 'and the cap must be raisable');

  // MAX_SAFE_INTEGER rendered in a usage pill is nonsense.
  assert.ok(/limit: internal \? null/.test(src), 'an internal account reports no limit rather than a huge one');

  const app = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.ok(/b\.internal/.test(app), 'and the pill must handle it');

  // The message when it does stop has to point at the right cause.
  assert.ok(/something is looping/.test(src), 'hitting the internal cap means a bug, not an upsell');
  assert.ok(!/upgrade now[\s\S]{0,80}internal/.test(src), 'never sell an upgrade to ourselves');
});

console.log('\nplans and margins');

await test('every plan is internally consistent', () => {
  for (const id of PLAN_ORDER) {
    const p = PLANS[id];
    assert.equal(p.id, id);
    assert.ok(p.sites >= 1 && p.questions >= 1 && p.engines >= 1 && p.runs >= 1);
    assert.ok(p.monthlyCalls > 0);
    assert.ok(p.features.length >= 3, `${id} needs features listed`);
  }
});

await test('limits rise monotonically with price', () => {
  const paid = PLAN_ORDER.map((id) => PLANS[id]);
  for (let i = 1; i < paid.length; i++) {
    assert.ok(paid[i].price > paid[i - 1].price, `${paid[i].id} should cost more than ${paid[i - 1].id}`);
    assert.ok(paid[i].monthlyCalls > paid[i - 1].monthlyCalls, `${paid[i].id} should include more checks`);
    assert.ok(paid[i].sites >= paid[i - 1].sites);
    assert.ok(paid[i].questions >= paid[i - 1].questions);
  }
});

await test('margin holds even if every call is the most expensive surface', () => {
  for (const id of ['starter', 'growth', 'agency']) {
    const p = PLANS[id];
    const worst = p.monthlyCalls * WORST_CASE_CALL;
    const margin = (p.price - worst) / p.price;
    assert.ok(margin >= 0.7,
      `${id}: worst case $${worst.toFixed(2)} against $${p.price} leaves only ${Math.round(margin * 100)}%`);
  }
});

await test('every plan carries a hard spend ceiling as a backstop', () => {
  for (const id of PLAN_ORDER) {
    const p = PLANS[id];
    assert.ok(typeof p.monthlyBudgetUsd === 'number' && p.monthlyBudgetUsd > 0,
      `${id} has no monthlyBudgetUsd`);
    if (p.price) {
      assert.ok(p.monthlyBudgetUsd <= p.price * COGS_SHARE + 0.01,
        `${id} budget $${p.monthlyBudgetUsd} exceeds ${COGS_SHARE * 100}% of $${p.price}`);
    }
  }
});

await test('the two ceilings agree with each other', () => {
  // The call allowance must not be able to outspend the budget at worst case,
  // otherwise customers hit the money cap before the allowance we advertised.
  for (const id of ['starter', 'growth', 'agency']) {
    const p = PLANS[id];
    const worst = p.monthlyCalls * WORST_CASE_CALL;
    assert.ok(worst <= p.monthlyBudgetUsd + 0.5,
      `${id}: ${p.monthlyCalls} calls could cost $${worst.toFixed(2)} but the budget is $${p.monthlyBudgetUsd}`);
  }
});

await test('annual pricing gives roughly two months free', () => {
  for (const id of ['starter', 'growth', 'agency']) {
    const p = PLANS[id];
    const ratio = p.priceAnnual / (p.price * 12);
    assert.ok(ratio > 0.78 && ratio < 0.88, `${id} annual discount is ${Math.round((1 - ratio) * 100)}%`);
  }
});

await test('one site at its ceiling fits a weekly cadence', () => {
  // Free is excluded on purpose: it is a manual-run demo tier, not a subscription.
  // The allowance is pooled across sites, so the honest test is that a single
  // site using every question and surface can still run every week.
  for (const id of ['starter', 'growth', 'agency']) {
    const p = PLANS[id];
    const runs = Math.min(3, p.runs);
    const { calls } = estimateCycle({ questions: p.questions, engines: p.engines, runs });
    assert.ok(calls * 4.33 <= p.monthlyCalls,
      `${id}: one site at ${p.questions}q x ${p.engines} surfaces x ${runs} runs needs ${Math.ceil(calls * 4.33)} checks a month but only ${p.monthlyCalls} are included`);
  }
});

await test('downgrading clamps engines and runs immediately', () => {
  const clamped = clampToPlan(PLANS.free, { engines: ['chatgpt', 'gemini', 'perplexity'], runs: 5 });
  assert.deepEqual(clamped.engines, ['chatgpt']);
  assert.equal(clamped.runs, 1);
});

await test('an unknown plan falls back to free rather than throwing', () => {
  assert.equal(planFor('enterprise-deluxe').id, 'free');
  assert.equal(planFor(undefined).id, 'free');
});

await test('annual is offered for every paid plan', () => {
  for (const id of ['starter', 'growth', 'agency']) {
    assert.ok(PLANS[id].priceAnnual > 0, `${id} has no annual price`);
  }
});

console.log('\nprompt generation');

await test('falls back to templates without an API key', async () => {
  const prompts = await generatePrompts({
    brand: 'Sandstorm Digital', domain: 'sandstormdigital.com',
    category: 'SEO agency', market: 'the UK', qualifier: 'ecommerce brand', count: 10
  });
  assert.equal(prompts.length, 10);
  assert.ok(prompts.every((p) => !/sandstorm/i.test(p.text)), 'never leaks the brand name into the question');
  assert.ok(prompts.every((p) => p.text.length > 20));
});

console.log(`\n${pass} checks passed\n`);
