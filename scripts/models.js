import 'dotenv/config';
import { ENGINES, ENGINE_IDS, listModels } from '../src/lib/dataforseo.js';

/**
 * Print every model DataForSEO offers per engine, and which one we would
 * pick. Free to run, and the fastest way to diagnose a model_name failure.
 *
 *   npm run models
 */

function score(m) {
  let s = 0;
  if (m.web_search_supported) s += 100;
  if (!m.reasoning) s += 20;
  if (!/\d{4}-\d{2}-\d{2}|\d{8}/.test(m.model_name)) s += 10;
  if (/mini|flash|haiku|small|sonar$/.test(m.model_name)) s += 8;
  return s;
}

for (const id of ENGINE_IDS) {
  if (ENGINES[id].kind !== 'llm') continue;
  process.stdout.write(`\n${ENGINES[id].label}\n`);
  try {
    const list = await listModels(id);
    const ranked = [...list].sort((a, b) => score(b) - score(a));
    for (const m of ranked.slice(0, 8)) {
      const flags = [
        m.web_search_supported ? 'web search' : 'NO web search',
        m.reasoning ? 'reasoning' : ''
      ].filter(Boolean).join(', ');
      process.stdout.write(`  ${m === ranked[0] ? '->' : '  '} ${m.model_name.padEnd(34)} ${flags}\n`);
    }
    if (list.length > 8) process.stdout.write(`     ...and ${list.length - 8} more\n`);
    process.stdout.write(`  we would use: ${ranked[0]?.model_name}\n`);
  } catch (err) {
    process.stdout.write(`  could not list models: ${err.message}\n`);
  }
}
process.exit(0);
