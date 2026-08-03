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

  const run = async (responder) => {
    let calls = 0;
    global.fetch = async () => { calls++; return responder(); };
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
    if (e.kind === 'llm') assert.ok(e.path && e.model, `${id} needs a path and model`);
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
