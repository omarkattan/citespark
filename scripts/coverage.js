import 'dotenv/config';
import { landscape } from '../src/lib/mentions.js';

/**
 * Which markets does the LLM Mentions corpus cover, and in which language?
 *
 *   npm run coverage
 *   npm run coverage -- "best bank"
 *
 * Two different rejections mean two different things, and the difference
 * decides whether a market is missing or simply not English:
 *
 *   Invalid Field: 'location_name'  the market is not in the dataset at all
 *   Invalid Field: 'language_code'  the market is there, in another language
 */
const keyword = process.argv[2] || 'best bank';

const MARKETS = [
  ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'], ['QA', 'Qatar'],
  ['KW', 'Kuwait'], ['EG', 'Egypt'], ['BH', 'Bahrain'], ['OM', 'Oman'],
  ['MA', 'Morocco'], ['DZ', 'Algeria'], ['JO', 'Jordan']
];

console.log(`Checking coverage for "${keyword}" across ${MARKETS.length} markets, both languages\n`);

let spend = 0;
const results = [];

for (const [code, name] of MARKETS) {
  let outcome = null;

  for (const lang of ['en', 'ar']) {
    try {
      const d = await landscape({ keywords: [`${keyword} ${name.toLowerCase()}`], market: code, platform: 'google', language: lang });
      spend += d.cost || 0;
      if (d.domains.length) {
        outcome = { lang, domains: d.domains.length, corpus: d.totalCount || 0 };
        break;
      }
      outcome = outcome || { lang, domains: 0, corpus: 0 };
    } catch (err) {
      const msg = String(err.message);
      if (/location_name/.test(msg)) {
        outcome = { error: 'market not in the dataset' };
        break; // no point trying another language
      }
      if (/language_code/.test(msg)) continue; // try the other language
      outcome = { error: msg.slice(0, 60) };
    }
  }

  results.push([code, name, outcome || { error: 'no language worked' }]);
  const o = results.at(-1)[2];
  console.log(
    o.error
      ? `  ${name.padEnd(22)} ${o.error}`
      : o.domains
        ? `  ${name.padEnd(22)} ${String(o.domains).padStart(3)} domains in ${o.lang}, corpus ${o.corpus.toLocaleString()}`
        : `  ${name.padEnd(22)} no rows in either language`
  );
}

const usable = results.filter(([, , o]) => o.domains);
console.log(`\nUsable markets: ${usable.map(([, n, o]) => `${n} (${o.lang})`).join(', ') || 'none'}`);
console.log(`Unavailable   : ${results.filter(([, , o]) => !o.domains).map(([, n]) => n).join(', ') || 'none'}`);
console.log(`\n$${spend.toFixed(2)} spent.`);

if (usable.some(([, , o]) => o.lang === 'ar')) {
  console.log('\nSome markets are only covered in Arabic. Their keywords need to be Arabic');
  console.log('too, or the query will match nothing even though the market is there.');
}
process.exit(0);
