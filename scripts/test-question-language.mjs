import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('src/lib/prompts.js', root), 'utf8');
async function generator(reply) {
  const calls = [];
  const context = vm.createContext({
    complete: async (ask, options) => { calls.push({ ask, ...options }); return reply; },
    parseJsonArray: text => text ? JSON.parse(text) : null
  });
  vm.runInContext(source.replace(/^import .*\n/, '').replaceAll('export ', ''), context);
  return { context, calls };
}
const english = 'How do I choose a retirement planning adviser?';
const arabic = 'كيف أختار مستشاراً مناسباً للتخطيط للتقاعد؟';
const args = { brand: 'ExampleBrand', domain: 'example.test', category: 'retirement planning', market: 'Saudi Arabia', qualifier: 'families' };

test('English topic stays English in an Arabic-speaking market', async () => {
  const { context, calls } = await generator(JSON.stringify([english, arabic]));
  const result = await context.questionsForTopic({ ...args, topic: 'retirement planning' });
  assert.deepEqual(Array.from(result), [english]);
  assert.match(calls[0].system, /Write every question in English/);
  assert.doesNotMatch(calls[0].system, /Write Arabic directly/);
});
test('Arabic topic stays Arabic in an English-speaking market', async () => {
  const { context, calls } = await generator(JSON.stringify([english, arabic]));
  const result = await context.questionsForTopic({ ...args, market: 'UK', topic: 'التخطيط للتقاعد' });
  assert.deepEqual(Array.from(result), [arabic]);
  assert.match(calls[0].system, /Write every question in Arabic/);
});
test('Arabic topic may include Latin product names', async () => {
  const { context } = await generator(null);
  assert.equal(context.topicLanguage('مقارنة SkinCycles'), 'ar');
});
test('Site suggestions default to English regardless of market', async () => {
  const { context, calls } = await generator(JSON.stringify([{ text: english }, { text: arabic }]));
  const result = await context.generatePrompts(args);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, english);
  assert.match(calls[0].system, /Write every question in English/);
});
test('Explicit Arabic site suggestions accept Arabic only', async () => {
  const { context, calls } = await generator(JSON.stringify([{ text: english }, { text: arabic }]));
  const result = await context.generatePrompts({ ...args, language: 'ar' });
  assert.equal(result.length, 1);
  assert.equal(result[0].text, arabic);
  assert.match(calls[0].system, /Write every question in Arabic/);
});
test('Wrong-language output and unavailable Arabic do not produce English fallbacks', async () => {
  for (const reply of [null, JSON.stringify([{ text: english }])]) {
    const { context } = await generator(reply);
    await assert.rejects(context.generatePrompts({ ...args, language: 'ar' }), /selected language/);
  }
  const { context } = await generator(JSON.stringify([{ text: arabic }]));
  await assert.rejects(context.generatePrompts(args), /selected language/);
});
test('Unavailable English generation retains English fallback', async () => {
  const { context } = await generator(null);
  const result = await context.generatePrompts(args);
  assert.ok(result.length > 0);
  assert.ok(result.every(p => context.topicLanguage(p.text) === 'en'));
});
test('Unsupported language is rejected before model invocation', async () => {
  const { context, calls } = await generator(null);
  await assert.rejects(context.generatePrompts({ ...args, language: 'xx' }), /Choose English or Arabic/);
  assert.equal(calls.length, 0);
});
test('Site endpoint passes selection and rejects failed generation before inserting', async () => {
  const server = await readFile(new URL('src/server.js', root), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/projects/:id/generate-prompts'"), server.indexOf('/* ---------------- public demo'));
  let handler;
  let inserts = 0;
  const context = vm.createContext({
    app: { post: (path, auth, fn) => { handler = fn; } }, requireAuth: null, wrap: fn => fn,
    assertProject: async () => ({ ...args, id: 1, brand_name: args.brand, language: 'en' }),
    getEntitlements: async () => ({ plan: { questions: 20 } }), MARKET_NAMES: {},
    one: async sql => { if (sql.includes('INSERT')) { inserts++; return { id: 1 }; } return { n: 0 }; },
    generatePrompts: async options => { assert.equal(options.language, 'ar'); throw Error('No usable questions'); }
  });
  vm.runInContext(route, context);
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ body: { language: 'ar' }, session: { orgId: 1 } }, res);
  assert.equal(res.code, 502);
  assert.equal(inserts, 0);
  await handler({ body: { language: 'xx' }, session: { orgId: 1 } }, res);
  assert.equal(res.code, 400);
  assert.equal(inserts, 0);
});
test('Site language selector renders and sends the selected language', async () => {
  const app = await readFile(new URL('src/public/app.js', root), 'utf8');
  assert.match(app, /<label for="q_site_language">Site suggestion language<\/label>/);
  assert.match(app, /<option value="en"/);
  assert.match(app, /<option value="ar"/);
  const start = app.indexOf("  if (t.id === 'q_generate')");
  const end = app.indexOf("  if (t.id === 's_delete')", start);
  let sent;
  const context = vm.createContext({
    t: { id: 'q_generate' }, state: { projectId: 1 },
    $: id => { assert.equal(id, 'q_site_language'); return { value: 'ar' }; },
    fetch: async (url, request) => { sent = JSON.parse(request.body); return { ok: true, json: async () => ({ added: 1 }) }; },
    render: async () => {}, setupErr: message => assert.fail(message)
  });
  await vm.runInContext(`(async () => { ${app.slice(start, end)} })()`, context);
  assert.deepEqual(sent, { count: 10, language: 'ar' });
});
