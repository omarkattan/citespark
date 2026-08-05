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

const AGGREGATORS = /(clutch\.co|g2\.com|capterra|trustpilot|designrush|sortlist|goodfirms|upcity|expertise\.com|yelp|tripadvisor|glassdoor|crunchbase|producthunt|thumbtack|houzz|checkatrade|trustedtraders|bayut|propertyfinder|property-finder|dubizzle|houza|opensooq|yallacompare|souqalmal|policybazaar|compareit4me|talabat|deliveroo|noon\.com|booking\.com|agoda|expedia|skyscanner|kayak|bayt\.com|naukrigulf)/i;
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

/**
 * Models return a bare object about as often as an array, and sometimes wrap
 * it in prose. Demanding one exact shape threw away perfectly good answers,
 * which is why most teardowns reported "could not be interpreted".
 */
function parseExplanation(raw) {
  if (!raw) return null;
  const text = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

  const candidates = [];
  const arr = text.indexOf('['), arrEnd = text.lastIndexOf(']');
  if (arr !== -1 && arrEnd > arr) candidates.push(text.slice(arr, arrEnd + 1));
  const obj = text.indexOf('{'), objEnd = text.lastIndexOf('}');
  if (obj !== -1 && objEnd > obj) candidates.push(text.slice(obj, objEnd + 1));
  candidates.push(text);

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      const item = Array.isArray(parsed) ? parsed[0] : parsed;
      if (item && (item.why || item.actions)) {
        return {
          why: [].concat(item.why || []).map(String).filter(Boolean),
          actions: [].concat(item.actions || [])
            .map((a) => (typeof a === 'string' ? { do: a, because: '' } : { do: String(a.do || a.action || ''), because: String(a.because || a.why || '') }))
            .filter((a) => a.do),
          confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium'
        };
      }
    } catch {
      // try the next candidate shape
    }
  }
  return null;
}

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

  const raw = await complete(summary, { system: SYSTEM, maxTokens: 1800 });
  const parsed = parseExplanation(raw);
  if (parsed) return parsed;

  // One retry with the shape spelled out, then give up on the model.
  const retry = await complete(
    `${summary}\n\nRespond with a single JSON object and nothing else, in exactly this shape:\n{"why":["...","...","..."],"actions":[{"do":"...","because":"..."}],"confidence":"medium"}`,
    { maxTokens: 1800 }
  );
  return parseExplanation(retry);
}

/**
 * What we can say without a model at all.
 *
 * The structural pass already knows what the page has. That is enough to
 * produce specific, useful advice, so a model failure should degrade the
 * quality of the wording rather than leave the person with nothing.
 */
export function deterministicExplanation(structure, kind) {
  const why = [];
  const actions = [];
  const s = structure;

  if (s.headingsMatchingQuestion?.length) {
    why.push(`It asks the question back as a heading: "${s.headingsMatchingQuestion[0]}". Engines strongly favour a page that visibly addresses the exact question.`);
    actions.push({
      do: `Add an H2 to your matching page that states the question almost verbatim, then answer it in the following 40 to 60 words.`,
      because: 'This page does exactly that, and it is the single most repeatable feature of cited pages.'
    });
  } else {
    actions.push({
      do: 'Add a heading that states the question and answer it immediately beneath.',
      because: 'Neither this page nor yours does it, so it is available to whoever moves first.'
    });
  }

  if (s.hasFaqSchema) {
    why.push('It carries FAQ structured data, which makes the question and answer pairs machine-readable rather than something to infer from prose.');
    actions.push({ do: 'Add FAQPage schema covering the questions you want to win.', because: 'The cited page has it and yours can too, at no editorial cost.' });
  }
  if (s.hasReviewSchema) {
    why.push('It exposes review or rating markup, which reads as third-party corroboration.');
  }
  if (s.hasOrganisationSchema) {
    why.push('It has Organization markup, so the entity behind the page is unambiguous.');
    actions.push({ do: 'Add Organization schema with sameAs pointing at your review, directory and social profiles.', because: 'It makes your brand a resolvable entity rather than a string of text.' });
  }
  if (s.tables > 0) {
    why.push(`It contains ${s.tables} table${s.tables === 1 ? '' : 's'}. Tabular comparisons are easy to extract and hard to paraphrase from memory.`);
    actions.push({ do: 'Add a comparison table with the criteria a buyer actually weighs.', because: 'Tables are among the most reliably quoted elements on a cited page.' });
  }
  if (s.statMentions >= 3) {
    why.push(`It quotes ${s.statMentions} specific figures or prices. Concrete numbers are the thing an engine cannot invent, so it cites the source.`);
    actions.push({ do: 'Put real figures on the page: prices, ranges, timeframes, sample sizes.', because: 'A page with numbers gets cited; a page of adjectives gets paraphrased.' });
  }
  if (s.hasAuthor) why.push('It names an author, which contributes to how trustworthy the page reads.');
  if (s.publishedOrUpdated) {
    why.push(`It states a date of ${String(s.publishedOrUpdated).slice(0, 10)}, so freshness is verifiable rather than assumed.`);
    if (!actions.some((a) => /date/i.test(a.do))) {
      actions.push({ do: 'Show a visible last-updated date and keep it honest.', because: 'Undated pages lose to dated ones on questions where recency matters.' });
    }
  }

  if (!why.length) {
    why.push('The page shows no obvious structural advantage. The citation most likely reflects the authority of the domain rather than anything on the page itself.');
    actions.push({
      do: kind === 'competitor'
        ? 'Treat this as a brand and corroboration problem rather than a content one: earn mentions on the sources this engine already trusts.'
        : 'Focus on being cited by the sources this engine already reads, rather than on rewriting this page.',
      because: 'Nothing on the page explains the citation, so matching its structure will not close the gap.'
    });
  }

  return { why: why.slice(0, 4), actions: actions.slice(0, 4), confidence: why.length > 1 ? 'medium' : 'low', source: 'structural' };
}

/**
 * The renderer returns structured metadata rather than HTML, so build the
 * same shape from what it does give us.
 */
function structureFromRendered(r = {}, question = '') {
  const headings = [...(r.h2s || []), ...(r.h3s || [])];
  const qWords = new Set(
    question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3)
  );
  const matching = headings.filter((h) => {
    const hits = String(h).toLowerCase().split(/\s+/).filter((w) => qWords.has(w)).length;
    return qWords.size > 0 && hits / Math.max(3, qWords.size) > 0.3;
  });
  const text = r.body || '';

  return {
    title: r.title || null,
    metaDescription: r.description || null,
    h1: r.h1 || null,
    h2s: r.h2s || [],
    h3s: r.h3s || [],
    headingsMatchingQuestion: matching.slice(0, 6),
    schemaTypes: r.hasMicromarkup ? ['(structured data present)'] : [],
    hasFaqSchema: false,
    hasHowTo: false,
    hasReviewSchema: false,
    hasOrganisationSchema: Boolean(r.hasMicromarkup),
    hasAuthor: false,
    tables: 0,
    lists: 0,
    statMentions: (text.match(/\b\d+(\.\d+)?\s*(%|percent)|\b(?:AED|USD|GBP|\$|£|€)\s?\d/gi) || []).length,
    publishedOrUpdated: null,
    wordCount: r.wordCount || text.split(/\s+/).length,
    openingAnswer: r.description || null,
    excerpt: text.slice(0, 2600),
    partial: true // read through the renderer, so some signals are unavailable
  };
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
  if (!page || (!page.html && !page.structured)) {
    return {
      ok: false,
      error: 'That page could not be read, even through our renderer. It may require a login, or be blocked at the network level.'
    };
  }

  const structure = page.html
    ? readStructure(page.html, question)
    : structureFromRendered(page.structured, question);

  const modelled = await explainCitation({ question, url, kind, structure, ownBrand });
  const explanation = modelled || deterministicExplanation(structure, kind);

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
