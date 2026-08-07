import 'dotenv/config';
import { landscape } from '../src/lib/mentions.js';

/**
 * Which markets does the LLM Mentions corpus actually cover?
 *
 *   npm run coverage
 *   npm run coverage -- "best bank"
 *
 * A whole country returning nothing is a gap in the data, not a finding about
 * its companies, and the difference matters a great deal before publishing.
 * Costs $0.20 per market.
 */
const keyword = process.argv[2] || 'best bank';
const MARKETS = [
  ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'], ['QA', 'Qatar'],
  ['KW', 'Kuwait'], ['EG', 'Egypt'], ['BH', 'Bahrain'], ['OM', 'Oman'],
  ['MA', 'Morocco'], ['DZ', 'Algeria'], ['JO', 'Jordan']
];

console.log(`Checking coverage for "${keyword}" across ${MARKETS.length} markets, about $${(MARKETS.length * 0.2).toFixed(2)}\n`);

let spend = 0;
const covered = [];
const empty = [];

for (const [code, name] of MARKETS) {
  const q = `${keyword} ${name.toLowerCase()}`;
  try {
    const d = await landscape({ keywords: [q], market: code, platform: 'google' });
    spend += d.cost || 0;
    const n = d.domains.length;
    const corpus = d.totalCount || 0;
    console.log(`  ${name.padEnd(22)} ${String(n).padStart(3)} domains, corpus ${corpus.toLocaleString().padStart(8)}  "${q}"`);
    (n ? covered : empty).push(name);
  } catch (err) {
    console.log(`  ${name.padEnd(22)} failed: ${err.message}`);
    empty.push(name);
  }
}

console.log(`\nCovered: ${covered.join(', ') || 'none'}`);
console.log(`No data: ${empty.join(', ') || 'none'}`);
console.log(`\n$${spend.toFixed(2)} spent.`);
if (empty.length) {
  console.log('\nMarkets with no data should not be published as zero. The index already');
  console.log('reports them as "no data", but it is worth knowing which they are.');
}
process.exit(0);
