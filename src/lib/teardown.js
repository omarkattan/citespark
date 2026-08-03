import { fetchPage } from './discover.js';
import { complete } from './anthropic.js';
import { one, query } from '../db/index.js';

/**
 * Why was this page cited?
 *
 * A citation is the closest thing to a ranking signal these engines emit.
 * Rather than guessing, fetch the page that was actually cited, pull out the
 * structural features that plausibly earned it the citation, and compare it
 * against the question it was answering.
 *
 * The structural pass is deterministic and free. The model then explains what
 * it means and what to do, grounded in those observations rather than in
 * generic advice.
 */

const AGGREGATORS = /(clutch\.co|g2\.com|capterra|trustpilot|designrush|sortlist|goodfirms|upcity|expertise\.com|yelp|tripadvisor|glassdoor|crunchbase|producthunt|thumbtack|houzz|checkatrade|trustedtraders)/i;
const COMMUNITY = /(reddit|quora|stackexchange|stackoverflow|discourse|forum|community\.|facebook\.com\/groups)/i;
const REFERENCE = /(wikipedia|\.gov(\.|$)|\.edu(\.|$)|\.ac\.|britannica|who\.int|statista)/i;
const PUBLISHER = /(medium\.com|substack|linkedin\.com\/pulse|forbes|entrepreneur|techcrunch|searchengine|hubspot\/blog)/i;

/**
 * What kind of source is this, and can you realistically get onto it?
 * This is the distinction that was missing: telling someone to pitch a
 * contribution to a competitor's homepage is useless advice.
 */
export function classifySource(domain, { ownDomain, competitorDomains = [] } = {}) {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (!d) return { kind: 'unknown', reachable: false };

  if (ownDomain && d === String(ownDomain).toLowerCase().replace(/^www\./, '')) {
    return { kind: 'own', reachable: true };
  }
  if (competitorDomains.some((c) => c && d === String(c).toLowerCase().replace(/^www\./, ''))) {
    return { kind: 'competitor', reachable: false };
  }
  if (AGGREGATORS.test(d)) return { kind: 'directory', reachable: true };
  if (COMMUNITY.test(d)) return { kind: 'community', reachable: true };
  if (REFERENCE.test(d)) return { kind: 'reference', reachable: false };
  if (PUBLISHER.test(d)) return { kind: 'publisher', reachable: true };
  return { kind: 'editorial', reachable: true };
}

/* ---------------- structural read ---------------- */

function textOf(html, re, all = false) {
  if (!all) {
    const m = re.exec(html);
    return m ? clean(m[1]) : null;
  }
  return [...html.matchAll(re)].map((m) => clean(m[1])).filter(Boolean);
}

const clean = (s) =>
  String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function schemaTypes(html) {
  const types = new Set();
  for (const block of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (node['@type']) {
          for (const t of [].concat(node['@type'])) types.add(String(t));
        }
        Object.values(node).forEach(walk);
      };
      walk(JSON.parse(block[1].trim()));
    } catch {
      // malformed JSON-LD is common and not worth failing over
    }
  }
  return [...types];
}

/**
 * The features that plausibly earn a citation. Deterministic and free, so
 * this runs on every teardown and grounds whatever the model says next.
 */
export function readStructure(html, question = '') {
  const body = clean(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
  const h2s = textOf(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi, true).slice(0, 20);
  const h3s = textOf(html, /<h3[^>]*>([\s\S]*?)<\/h3>/gi, true).slice(0, 20);
  const types = schemaTypes(html);

  // Which headings overlap the question? Crude term overlap is enough to
  // spot a page that mirrors the question back.
  const qWords = new Set(
    question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3)
  );
  const matching = [...h2s, ...h3s].filter((h) => {
    const hw = h.toLowerCase().split(/\s+/);
    const hits = hw.filter((w) => qWords.has(w)).length;
    return qWords.size > 0 && hits / Math.max(3, qWords.size) > 0.3;
  });

  const firstPara = textOf(html, /<p[^>]*>([\s\S]*?)<\/p>/i);
  const stats = (body.match(/\b\d+(\.\d+)?\s*(%|percent|per cent)|\b(?:AED|USD|GBP|\$|£|€)\s?\d/gi) || []).length;

  return {
    title: textOf(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    metaDescription: textOf(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i),
    h1: textOf(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i),
    h2s,
    h3s,
    headingsMatchingQuestion: matching.slice(0, 6),
    schemaTypes: types,
    hasFaqSchema: types.some((t) => /FAQPage|Question/i.test(t)),
    hasHowTo: types.some((t) => /HowTo/i.test(t)),
    hasReviewSchema: types.some((t) => /Review|AggregateRating/i.test(t)),
    hasOrganisationSchema: types.some((t) => /Organization|LocalBusiness|ProfessionalService/i.test(t)),
    hasAuthor: /rel=["']author["']|itemprop=["']author["']|"author"\s*:/i.test(html),
    tables: (html.match(/<table[\s>]/gi) || []).length,
    lists: (html.match(/<[uo]l[\s>]/gi) || []).length,
    statMentions: stats,
    publishedOrUpdated:
      textOf(html, /<meta[^>]+property=["']article:modified_time["'][^>]+content=["']([^"']+)["']/i) ||
      textOf(html, /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i) ||
      textOf(html, /"date(?:Modified|Published)"\s*:\s*"([^"]+)"/i),
    wordCount: body.split(/\s+/).length,
    openingAnswer: firstPara ? firstPara.slice(0, 320) : null,
    excerpt: body.slice(0, 2600)
  };
}

/* ---------------- the explanation ---------------- */

const SYSTEM = `You explain why an AI assistant cited a particular page, and what the reader should change on their own site.

You will be given the question that was asked, a structural summary of the page that was cited, and what kind of source it is.

Rules:
- Ground every claim in the structural evidence provided. If the evidence does not support a reason, say the page shows no obvious structural advantage and the citation likely reflects the domain's authority.
- Never suggest getting listed on a competitor's own website. Where the source is a competitor, the advice is to match what earned the citation, not to seek inclusion.
- Be specific and concrete. "Add an H2 that asks the question verbatim and answer it in the first 50 words" beats "improve your content".
- Prefer three good actions over six vague ones.

Return ONLY a JSON array with one object:
{
  "why": [string, string, string],        // why this page was likely cited, evidence-led
  "actions": [                            // what the reader should do
    {"do": string, "because": string}
  ],
  "confidence": "high" | "medium" | "low"
}`;

export async function explainCitation({ question, url, kind, structure, ownBrand }) {
  const summary = [
    `Question asked: ${question}`,
    `Cited page: ${url}`,
    `Source type: ${kind}`,
    ``,
    `Title: ${structure.title || 'none'}`,
    `Meta description: ${structure.metaDescription || 'none'}`,
    `H1: ${structure.h1 || 'none'}`,
    structure.h2s.length ? `H2s: ${structure.h2s.slice(0, 12).join(' | ')}` : 'H2s: none found',
    structure.headingsMatchingQuestion.length
      ? `Headings that mirror the question: ${structure.headingsMatchingQuestion.join(' | ')}`
      : 'No heading mirrors the question',
    `Schema types: ${structure.schemaTypes.join(', ') || 'none'}`,
    `FAQ schema: ${structure.hasFaqSchema} | Review schema: ${structure.hasReviewSchema} | Organisation schema: ${structure.hasOrganisationSchema} | Author markup: ${structure.hasAuthor}`,
    `Tables: ${structure.tables} | Lists: ${structure.lists} | Figures or prices mentioned: ${structure.statMentions}`,
    `Last published or updated: ${structure.publishedOrUpdated || 'not stated'}`,
    `Word count: ${structure.wordCount}`,
    `Opening paragraph: ${structure.openingAnswer || 'none'}`,
    ``,
    `Page text: ${structure.excerpt}`,
    ``,
    ownBrand ? `The reader's brand is ${ownBrand}.` : ''
  ].join('\n');

  const raw = await complete(summary, { system: SYSTEM, maxTokens: 1400 });
  if (!raw) return null;

  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))[0];
    if (!parsed?.why || !parsed?.actions) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ---------------- orchestration ---------------- */

export async function teardown({ url, question, kind, ownBrand, useCache = true }) {
  if (useCache) {
    const cached = await one(
      `SELECT result FROM page_teardowns
       WHERE url = $1 AND question = $2 AND created_at > now() - interval '30 days'
       ORDER BY created_at DESC LIMIT 1`,
      [url, question]
    );
    if (cached?.result) return { ...cached.result, cached: true };
  }

  const page = await fetchPage(url);
  if (!page?.html) {
    return {
      ok: false,
      error: 'That page could not be read. It may be blocking automated requests.'
    };
  }

  const structure = readStructure(page.html, question);
  const explanation = await explainCitation({ question, url, kind, structure, ownBrand });

  const result = {
    ok: true,
    url,
    kind,
    structure: {
      // keep the page text out of what we store and return
      ...structure,
      excerpt: undefined,
      h3s: undefined
    },
    explanation,
    via: page.via
  };

  await query(
    'INSERT INTO page_teardowns (url, question, result) VALUES ($1,$2,$3)',
    [url, question, JSON.stringify(result)]
  );
  return result;
}
