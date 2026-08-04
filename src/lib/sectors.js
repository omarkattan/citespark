import { many, one, query } from '../db/index.js';
import { landscape } from './mentions.js';

/**
 * The public UAE AI Visibility Index.
 *
 * A page that measures a whole market, refreshed on a schedule and served
 * from a stored snapshot. Visitors never trigger an API call, so it is fast
 * and costs nothing to promote. A full refresh across every sector runs to a
 * few cents.
 *
 * Google AI Overview is the platform throughout, because it is the only one
 * in this dataset with UAE coverage. ChatGPT here is United States only, and
 * publishing US figures under a UAE headline would be dishonest.
 */

export const SECTORS = [
  { slug: 'banking', name: 'Banking', keywords: ['banks uae', 'best bank uae'], blurb: 'Retail and corporate banks operating in the Emirates.' },
  { slug: 'telecoms', name: 'Telecoms', keywords: ['mobile plans uae', 'internet provider uae'], blurb: 'Mobile, broadband and enterprise connectivity.' },
  { slug: 'real-estate', name: 'Real Estate', keywords: ['property developers uae', 'buy property dubai'], blurb: 'Developers, brokerages and property portals.' },
  { slug: 'airlines-travel', name: 'Airlines & Travel', keywords: ['airlines uae', 'travel agency dubai'], blurb: 'Carriers, tour operators and booking platforms.' },
  { slug: 'healthcare', name: 'Healthcare & Clinics', keywords: ['hospitals dubai', 'clinics uae'], blurb: 'Hospital groups, clinics and specialist care.' },
  { slug: 'hospitality', name: 'Hotels & Hospitality', keywords: ['hotels dubai', 'resorts uae'], blurb: 'Hotels, resorts and hospitality groups.' },
  { slug: 'retail-ecommerce', name: 'Retail & Ecommerce', keywords: ['online shopping uae', 'ecommerce sites uae'], blurb: 'Marketplaces, retailers and direct-to-consumer brands.' },
  { slug: 'fintech-payments', name: 'Fintech & Payments', keywords: ['payment apps uae', 'money transfer uae'], blurb: 'Wallets, remittance and payment infrastructure.' },
  { slug: 'insurance', name: 'Insurance', keywords: ['insurance uae', 'health insurance dubai'], blurb: 'Health, motor and general insurers.' },
  { slug: 'education', name: 'Education', keywords: ['schools dubai', 'universities uae'], blurb: 'Schools, universities and training providers.' },
  { slug: 'legal-professional', name: 'Legal & Professional', keywords: ['law firms dubai', 'accounting firms uae'], blurb: 'Law, audit, accounting and consulting.' },
  { slug: 'food-delivery', name: 'Food & Delivery', keywords: ['food delivery uae', 'restaurants dubai'], blurb: 'Delivery platforms and restaurant groups.' },
  { slug: 'automotive', name: 'Automotive', keywords: ['car dealers uae', 'buy car dubai'], blurb: 'Dealerships, marketplaces and rental.' },
  { slug: 'logistics', name: 'Logistics & Shipping', keywords: ['shipping companies uae', 'courier dubai'], blurb: 'Freight, courier and last-mile delivery.' },
  { slug: 'marketing-agencies', name: 'Marketing Agencies', keywords: ['digital marketing agency dubai', 'seo agency uae'], blurb: 'Agencies serving the Gulf market.' },
  { slug: 'construction', name: 'Construction & Fit-out', keywords: ['construction companies uae', 'fit out companies dubai'], blurb: 'Contractors, fit-out and engineering.' }
];

export const bySlug = (slug) => SECTORS.find((s) => s.slug === slug) || null;

/**
 * Refresh one sector. Kept deliberately small so a failure affects one card
 * on the page rather than the whole index.
 */
export async function refreshSector(sector, { market = 'AE' } = {}) {
  const data = await landscape({
    keywords: sector.keywords,
    market,
    platform: 'google'
  });

  const snapshot = {
    slug: sector.slug,
    name: sector.name,
    blurb: sector.blurb,
    keywords: data.keywordsUsed || sector.keywords,
    brands: data.brands.rows.slice(0, 10),
    domains: data.domains.rows.slice(0, 10),
    pages: data.pages.rows.slice(0, 5),
    errors: [data.brands.error, data.domains.error, data.pages.error].filter(Boolean),
    cost: data.cost
  };

  await query(
    `INSERT INTO index_snapshots (slug, market, data, cost_usd) VALUES ($1,$2,$3,$4)`,
    [sector.slug, market, JSON.stringify(snapshot), data.cost || 0]
  );
  return snapshot;
}

export async function refreshAll({ market = 'AE', only = null } = {}) {
  const list = only ? SECTORS.filter((s) => only.includes(s.slug)) : SECTORS;
  const done = [];
  let spend = 0;

  for (const sector of list) {
    try {
      const snap = await refreshSector(sector, { market });
      spend += snap.cost || 0;
      done.push({ slug: sector.slug, brands: snap.brands.length, domains: snap.domains.length, errors: snap.errors.length });

      const empty = !snap.brands.length && !snap.domains.length;
      const why = empty
        ? snap.errors.length
          ? `no data (${snap.errors[0]})`
          : snap.cost === 0
            ? 'no data and nothing billed, so the request matched nothing. Run: npm run probe'
            : 'no data for these keywords'
        : '';
      console.log(`  ${sector.name.padEnd(24)} ${snap.brands.length} brands, ${snap.domains.length} domains${why ? `  <- ${why}` : ''}`);
    } catch (err) {
      console.warn(`  ${sector.name.padEnd(24)} failed: ${err.message}`);
      done.push({ slug: sector.slug, error: String(err.message) });
    }
  }
  return { sectors: done, spend: Math.round(spend * 10000) / 10000 };
}

/** The latest snapshot per sector, for the public page. */
export async function readIndex({ market = 'AE' } = {}) {
  const rows = await many(
    `SELECT DISTINCT ON (slug) slug, data, captured_at
     FROM index_snapshots WHERE market = $1
     ORDER BY slug, captured_at DESC`,
    [market]
  );

  const bySlugMap = new Map(rows.map((r) => [r.slug, { ...r.data, capturedAt: r.captured_at }]));
  const sectors = SECTORS.map((s) => bySlugMap.get(s.slug)).filter(Boolean);

  // Which sources shape answers across the whole market, not one sector.
  const domainTotals = new Map();
  for (const s of sectors) {
    for (const d of s.domains || []) {
      const prev = domainTotals.get(d.domain) || { domain: d.domain, mentions: 0, sectors: 0 };
      prev.mentions += d.mentions || d.citations || 0;
      prev.sectors += 1;
      domainTotals.set(d.domain, prev);
    }
  }

  const latest = rows.reduce((a, r) => (!a || r.captured_at > a ? r.captured_at : a), null);

  return {
    market,
    updatedAt: latest,
    sectors,
    crossSector: [...domainTotals.values()].sort((a, b) => b.sectors - a.sectors || b.mentions - a.mentions).slice(0, 12),
    totals: {
      sectors: sectors.length,
      brands: sectors.reduce((n, s) => n + (s.brands?.length || 0), 0)
    }
  };
}
