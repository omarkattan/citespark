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

await test('fanout_target fires and quotes the real search', () => {
  const recs = evaluateRules({
    project,
    stats: [stat({ hits: 0 })],
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
