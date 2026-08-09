#!/usr/bin/env node
/**
 * Build the structured data for the public pages, from the pages themselves.
 *
 *   npm run schema
 *
 * Written as a generator rather than hand-maintained JSON because the two
 * drift apart otherwise, and structured data that disagrees with the visible
 * page is worse than none: Google treats it as a reason to distrust the rest.
 * FAQ answers here are read out of the markup, so they cannot diverge.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = new URL('../src/public/', import.meta.url);
const SITE = 'https://cited.ae';

const read = (f) => readFileSync(new URL(f, DIR), 'utf8');
const write = (f, s) => writeFileSync(new URL(f, DIR), s);
const strip = (h) =>
  h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rarr;/g, '')
    .replace(/&mdash;/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();

/* ---------------- shared nodes ---------------- */

const publisher = {
  '@type': 'Organization',
  '@id': `${SITE}/#organization`,
  name: 'Sandstorm Digital',
  url: 'https://sandstormdigital.com',
  logo: { '@type': 'ImageObject', url: `${SITE}/og.png` },
  address: {
    '@type': 'PostalAddress',
    addressLocality: 'Dubai',
    addressRegion: 'Dubai Media City',
    addressCountry: 'AE'
  },
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    email: 'omar@sandstormdigital.com',
    areaServed: ['AE', 'SA', 'EG', 'QA', 'KW', 'GB'],
    availableLanguage: ['en', 'ar']
  }
};

const website = {
  '@type': 'WebSite',
  '@id': `${SITE}/#website`,
  url: SITE,
  name: 'Cited',
  description:
    'Cited measures whether AI assistants name your brand when buyers ask category questions, then turns the gaps into a ranked list of things to fix.',
  publisher: { '@id': `${SITE}/#organization` },
  inLanguage: 'en'
};

const breadcrumb = (trail) => ({
  '@type': 'BreadcrumbList',
  itemListElement: trail.map(([name, url], i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name,
    item: `${SITE}${url}`
  }))
});

/* ---------------- landing ---------------- */

function landing() {
  const html = read('landing.html');

  // Read the questions and answers off the page so the two cannot diverge.
  const faqs = [...html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
    .map(([, q, a]) => ({ q: strip(q), a: strip(a) }))
    .filter((f) => f.q && f.a.length > 30);

  /**
   * The plans, read from the price row each tier renders. Publishing prices
   * that disagree with the page is worse than publishing none: Google treats
   * a mismatch as a reason to distrust everything else on it.
   */
  const tiers = [...html.matchAll(
    /<div class="tier-name">([^<]+)<\/div>\s*<div class="tier-price"><span class="amt" data-m="(\d+)" data-y="(\d+)">/g
  )].map(([, name, monthly, annual]) => ({
    name: name.trim(),
    price: Number(monthly),
    annual: Number(annual)
  }));

  // Silence here would publish "$0 to $0" while the page charges $499, and a
  // mismatch is worse than no markup at all.
  if (tiers.length < 2) {
    throw new Error(`Only found ${tiers.length} pricing tier(s). Refusing to publish an offer list that disagrees with the page.`);
  }

  const offers = tiers;

  return [
    publisher,
    website,
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE}/#software`,
      name: 'Cited',
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'Search engine optimisation',
      operatingSystem: 'Web browser',
      url: SITE,
      description:
        'Cited asks the questions your buyers ask across ChatGPT, Google AI Overview, Google AI Mode, Perplexity, Gemini and Claude, records whether your brand is named and cited, and turns the gaps into a ranked list of actions.',
      publisher: { '@id': `${SITE}/#organization` },
      featureList: [
        'Answer engine visibility measurement across six AI surfaces',
        'Share of voice against named competitors',
        'Citation source analysis',
        'Fan-out query capture',
        'Google Analytics and Search Console integration',
        'Ranked, assignable actions'
      ],
      offers: {
        '@type': 'AggregateOffer',
        priceCurrency: 'USD',
        lowPrice: 0,
        highPrice: Math.max(...offers.map((o) => o.price), 0),
        offerCount: offers.length,
        offers: offers.map((o) => ({
          '@type': 'Offer',
          name: o.name,
          price: o.price,
          priceCurrency: 'USD',
          availability: 'https://schema.org/InStock',
          url: `${SITE}/#pricing`,
          ...(o.annual && o.annual !== o.price
            ? {
                priceSpecification: {
                  '@type': 'UnitPriceSpecification',
                  price: o.annual,
                  priceCurrency: 'USD',
                  billingDuration: 12,
                  billingIncrement: 1,
                  unitText: 'MONTH',
                  description: 'Effective monthly price when billed annually'
                }
              }
            : {})
        }))
      }
    },
    faqs.length && {
      '@type': 'FAQPage',
      '@id': `${SITE}/#faq`,
      mainEntity: faqs.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a }
      }))
    }
  ].filter(Boolean);
}

/* ---------------- legal ---------------- */

const legal = (title, path, described) => [
  publisher,
  website,
  {
    '@type': 'WebPage',
    '@id': `${SITE}${path}#page`,
    url: `${SITE}${path}`,
    name: title,
    description: described,
    isPartOf: { '@id': `${SITE}/#website` },
    publisher: { '@id': `${SITE}/#organization` },
    inLanguage: 'en'
  },
  breadcrumb([['Cited', '/'], [title, path]])
];

/* ---------------- write ---------------- */

function inject(file, graph) {
  const html = read(file);
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2);
  const block = `<script type="application/ld+json">\n${json}\n</script>`;

  // Replace only the pre-rendered block, never one a page fills from JS.
  const existing = /<script type="application\/ld\+json">[\s\S]*?<\/script>/;
  const out = existing.test(html) ? html.replace(existing, block) : html.replace('</head>', `${block}\n</head>`);
  write(file, out);

  const types = graph.map((g) => g['@type']);
  console.log(`  ${file.padEnd(28)} ${types.join(', ')}`);
}

console.log('\nStructured data written from page content\n');
inject('landing.html', landing());
inject(
  'privacy.html',
  legal('Privacy Policy', '/privacy', 'How Cited collects, uses, stores and deletes your data, including Google user data.')
);
inject(
  'terms.html',
  legal('Terms of Service', '/terms', 'The terms on which Cited is provided by Sandstorm Digital.')
);

console.log('\nThe index pages build theirs from live data at render time.\n');
