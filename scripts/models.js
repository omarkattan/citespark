import 'dotenv/config';
import { ENGINES, ENGINE_IDS, listModels } from '../src/lib/dataforseo.js';

/**
 * Print every model DataForSEO offers per engine, and which one we would
 * pick. Free to run, and the fastest way to diagnose a model_name failure.
 *
 *   npm run models
 */

/**
 * This used to rank with a private copy of the scoring function, which went
 * stale: it kept preferring small models after the real logic changed, and it
 * never looked at the environment pins at all. So it confidently answered a
 * question about code it was not running - the check that could not fail.
 *
 * Now the ranking comes from the exported comparator and the answer comes
 * from resolveModel itself, the function a cycle actually calls.
 */
import { betterModel, resolveModel } from '../src/lib/dataforseo.js';

for (const id of ENGINE_IDS) {
  if (ENGINES[id].kind !== 'llm') continue;
  process.stdout.write(`\n${ENGINES[id].label}\n`);
  try {
    const list = await listModels(id);
    const ranked = [...list].sort(betterModel);
    for (const m of ranked.slice(0, 8)) {
      const flags = [
        m.web_search_supported ? 'web search' : 'NO web search',
        m.reasoning ? 'reasoning' : ''
      ].filter(Boolean).join(', ');
      process.stdout.write(`  ${m === ranked[0] ? '->' : '  '} ${m.model_name.padEnd(34)} ${flags}\n`);
    }
    if (list.length > 8) process.stdout.write(`     ...and ${list.length - 8} more\n`);

    const used = await resolveModel(id, ENGINES[id]);
    const pinned = Boolean(ENGINES[id].model);
    process.stdout.write(`  a cycle would use: ${used}${pinned ? '   (pinned by MODEL_' + id.toUpperCase() + ', scoring not consulted)' : ''}\n`);
    if (!pinned && used !== ranked[0]?.model_name) {
      process.stdout.write(`  NOTE: resolver and ranking disagree. Trust "a cycle would use".\n`);
    }
  } catch (err) {
    process.stdout.write(`  could not list models: ${err.message}\n`);
  }
}
process.exit(0);
