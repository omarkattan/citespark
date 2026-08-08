/**
 * The extraction layer.
 *
 * Given an answer body and a company list, work out three things:
 *
 *   who is named, across every alias
 *   in what order, among company names only
 *   whether each named company's own site is linked in the same answer
 *
 * Everything published rests on this. If alias matching is loose, the numbers
 * are noise dressed as evidence, so this module errs towards missing a
 * mention rather than inventing one, records which alias fired so collisions
 * can be audited, and is designed to be validated by hand before any UI is
 * built on top of it.
 */

/* ---------------- normalisation ---------------- */

const stripDomain = (d) =>
  String(d || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();

/** Fold the punctuation and casing that vary between answers. */
function normalise(text) {
  return String(text || '')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ');
}

/**
 * Ambiguous aliases are the whole problem.
 *
 * "Select", "Nest" and "One" are ordinary English words as well as developer
 * names, so a bare match fires on "select a developer" and "nest your
 * savings" and quietly inflates a published score. Being short is not the
 * test: "Arada" is five letters and unmistakable, "Select" is six and not.
 * What matters is whether the string has a common meaning of its own.
 */
const COMMON_WORDS = new Set([
  'nest', 'select', 'one', 'first', 'union', 'core', 'arc', 'bloom', 'pearl',
  'oasis', 'vision', 'prime', 'peak', 'summit', 'range', 'grand', 'royal',
  'imperial', 'sky', 'palm', 'marina', 'creek', 'harbour', 'harbor', 'gate',
  'the', 'and', 'city', 'home', 'homes', 'living', 'group', 'holding',
  'properties', 'property', 'real', 'estate', 'development', 'developments',
  'national', 'international', 'emirates', 'dubai', 'sharjah', 'gulf'
]);

/**
 * Suffixes that turn an ordinary word into a company name. Case matters:
 * "Select Group" is a company, "select group discounts" is not, and matching
 * case-insensitively accepted the second.
 */
const COMPANY_SUFFIX =
  /^(Group|Properties|Property|Developments?|Holdings?|Homes|Real Estate|Realty|Estates|International|LLC|PJSC)\b/;

const QUALIFIERS =
  /\b(develop\w*|properties|property|real estate|project|community|tower|residence|villa|apartment|off.?plan|handover|master.?plan|launch\w*)/i;

export function isAmbiguous(alias) {
  const a = String(alias || '').trim().toLowerCase();
  if (a.length <= 3) return true;
  const words = a.split(/\s+/);
  if (words.length === 1) return COMMON_WORDS.has(a);
  // Every token is a common word, e.g. "Select Group" or "First Homes".
  return words.every((w) => COMMON_WORDS.has(w));
}

/** Word-boundary match that will not fire inside another word. */
function findAll(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=[^\\p{L}\\p{N}]|$)`, 'giu');
  const hits = [];
  let m;
  while ((m = re.exec(haystack)) !== null) {
    hits.push({ index: m.index + m[1].length, text: m[2] });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return hits;
}

/**
 * An ambiguous alias only counts on hard evidence, never on proximity.
 * "Select a developer" put a qualifier nine characters away and produced a
 * false positive, so nearness alone is not enough. One of these must hold:
 *
 *   a company suffix follows it              "Select Group", "Nest Properties"
 *   it is introduced as an entity            "by Nest", "from Nest"
 *   the company's own domain is linked        nestdubai.ae appears in the answer
 *   an unambiguous form appears elsewhere     the full name is used somewhere
 */
function ambiguousHitIsReal(text, hit, alias, company, linkedDomains) {
  // A multi-word alias matching its exact capitalisation is a proper noun,
  // not prose. "Select Group delivered Marina Gate" is the company; "select a
  // group of developers" is not, and would not match this alias anyway.
  if (alias.includes(' ') && hit.text === alias && /^[A-Z]/.test(alias)) {
    return { ok: true, why: 'exact capitalisation of a multi-word name' };
  }

  const after = text.slice(hit.index + alias.length).replace(/^[\s,.:;-]+/, '');
  if (COMPANY_SUFFIX.test(after)) return { ok: true, why: 'company suffix follows' };

  const before = text.slice(Math.max(0, hit.index - 24), hit.index).toLowerCase();
  if (/\b(by|from|developer|developed by)\s+$/.test(before)) return { ok: true, why: 'introduced as an entity' };

  const domain = stripDomain(company.domain);
  if (domain && linkedDomains.has(domain)) return { ok: true, why: 'own domain linked in the answer' };

  const unambiguous = [company.name, ...(company.aliases || [])].filter((a) => a && !isAmbiguous(a));
  for (const u of unambiguous) {
    if (findAll(text, u).length) return { ok: true, why: `unambiguous form "${u}" also present` };
  }

  return { ok: false };
}

/* ---------------- links and citations ---------------- */

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/**
 * Every link in the answer, plus anything supplied separately by the engine.
 * Tracking parameters are stripped so a citation can be matched to a domain.
 */
export function extractLinks(text, supplied = []) {
  const out = new Map();

  const add = (raw, source) => {
    if (!raw) return;
    let url = String(raw).trim().replace(/[.,;)]+$/, '');
    try {
      const u = new URL(url);
      for (const p of [...u.searchParams.keys()]) {
        if (/^utm_|^ref$|^source$|^fbclid$|^gclid$/i.test(p)) u.searchParams.delete(p);
      }
      url = u.toString();
      const domain = stripDomain(u.hostname);
      if (!out.has(url)) out.set(url, { url, domain, source });
    } catch {
      // not a usable URL
    }
  };

  for (const m of String(text || '').matchAll(URL_RE)) add(m[0], 'inline');
  for (const s of supplied) add(typeof s === 'string' ? s : s?.url || s?.link, 'engine');

  return [...out.values()];
}

/* ---------------- the extraction ---------------- */

/**
 * @param {string} answerText
 * @param {Array<{id?, key, name, domain, aliases?}>} companies
 * @param {Array} suppliedLinks  citations the engine returned separately
 */
/**
 * Some names belong to two companies. "Alef" is a Sharjah developer and also
 * Alef Education, a UAE edtech firm that sits in another of our own public
 * indexes. "Sobha" is a Dubai developer and an unrelated listed company in
 * India. "Danube" is a developer, a river, and a furniture retailer.
 *
 * A company may therefore declare strings that must never be counted as it,
 * checked before any alias is accepted. This runs first because a false
 * positive here would attribute another company's visibility to this one on
 * a public page.
 */
function excludedHere(text, hit, alias, company) {
  const blockers = company.neverMatch || company.never_match || [];
  if (!blockers.length) return false;

  // The hit must be part of the excluded phrase, not merely near it. A window
  // blocked "Alef Group is building Hayyan" because "Alef Education" appeared
  // in the following sentence, which is exactly backwards: the other company
  // appearing elsewhere is normal and says nothing about this mention.
  const hitStart = hit.index;
  const hitEnd = hit.index + alias.length;

  for (const b of blockers) {
    const escaped = String(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      const bStart = m.index;
      const bEnd = m.index + m[0].length;
      // Overlap means this hit is the one inside the excluded phrase.
      if (hitStart < bEnd && hitEnd > bStart) return true;
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  return false;
}

export function extractMentions(answerText, companies, suppliedLinks = []) {
  const text = normalise(answerText);
  const links = extractLinks(text, suppliedLinks);
  const linkedDomains = new Set(links.map((l) => l.domain));

  const found = [];

  for (const company of companies) {
    // Longest aliases first, so "Emaar Properties" wins over "Emaar" and the
    // recorded alias reflects what the answer actually said.
    //
    // Project names are matched too but flagged, because naming a community
    // is not the same as naming the company that built it and the two are
    // reported as separate measurements.
    const corporate = [...new Set([company.name, ...(company.aliases || [])])].filter(Boolean);
    const projects = [...new Set(company.projectAliases || company.project_aliases || [])].filter(Boolean);
    const aliases = [...corporate, ...projects].sort((a, b) => b.length - a.length);
    const isProject = new Set(projects);

    let best = null;

    for (const alias of aliases) {
      const ambiguous = isAmbiguous(alias);
      for (const hit of findAll(text, alias)) {
        if (excludedHere(text, hit, alias, company)) continue;
        let why = null;
        if (ambiguous) {
          const verdict = ambiguousHitIsReal(text, hit, alias, company, linkedDomains);
          if (!verdict.ok) continue;
          why = verdict.why;
        }
        const viaProject = isProject.has(alias);
        // A corporate mention outranks a project mention, whatever the order:
        // the company being named directly is the stronger signal.
        const better =
          !best ||
          (best.viaProject && !viaProject) ||
          (best.viaProject === viaProject && hit.index < best.index);
        if (better) best = { index: hit.index, alias, ambiguous, why, viaProject };
        break; // first qualifying hit per alias is enough
      }
      if (best && !best.ambiguous && !best.viaProject) break; // settled
    }

    if (!best) continue;

    const domain = stripDomain(company.domain);
    const citation = links.find((l) => domain && l.domain === domain);

    found.push({
      company,
      index: best.index,
      matchedAlias: best.alias,
      ambiguousMatch: best.ambiguous,
      // True when the company was found only via one of its project names.
      viaProject: Boolean(best.viaProject),
      // Why an ambiguous match was accepted, so a reviewer can audit it.
      matchReason: best.why || null,
      snippet: snippetAround(text, best.index, best.alias.length),
      cited: Boolean(citation),
      citationUrl: citation?.url || null
    });
  }

  // Ordinal is position among company names only, which is what a reader of
  // the answer perceives as the ranking. Position in the raw text is not.
  found.sort((a, b) => a.index - b.index);
  found.forEach((f, i) => {
    f.ordinal = i + 1;
  });

  return {
    mentions: found,
    links,
    linkedDomains: [...linkedDomains],
    totalNamed: found.length
  };
}

function snippetAround(text, index, length, pad = 130) {
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + length + pad);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/* ---------------- recommendation ---------------- */

/**
 * "Recommended" is narrower than "mentioned". A developer listed in a table
 * of every licensed builder is named; one the answer actually puts forward is
 * recommended. Detected from the language immediately around the mention, and
 * deliberately conservative: a false positive here inflates a published score.
 */
const RECOMMEND = /\b(recommend\w*|best|top|leading|strongest|standout|worth considering|first choice|go.?to|ideal|excellent choice|stands out|most trusted|prefer\w*)\b/i;
const NEGATIVE = /\b(avoid|not recommend\w*|worst|poor|criticis\w*|complaint\w*|delay\w*|struggl\w*)\b/i;

/**
 * The sentence containing a position, which is the unit a recommendation
 * actually lives in. A character window is the wrong scope: at 160 characters
 * a single "avoid" three sentences away suppressed every recommendation in
 * the passage, including the one the answer was making.
 */
export function sentenceAt(text, index) {
  const t = normalise(text);
  // Sentence end followed by whitespace, avoiding common abbreviations.
  const boundary = /[.!?\n](?=\s|$)/g;
  let start = 0;
  let m;
  while ((m = boundary.exec(t)) !== null) {
    if (m.index >= index) break;
    start = m.index + 1;
  }
  boundary.lastIndex = index;
  const endMatch = boundary.exec(t);
  const end = endMatch ? endMatch.index + 1 : t.length;
  return t.slice(start, end).trim();
}

export function isRecommended(text, index, aliasLength) {
  const sentence = sentenceAt(text, index);
  if (NEGATIVE.test(sentence)) return false;
  return RECOMMEND.test(sentence);
}

/** Apply recommendation detection across an extraction result. */
export function scoreRecommendations(answerText, extraction) {
  for (const m of extraction.mentions) {
    m.recommended = isRecommended(answerText, m.index, m.matchedAlias.length);
  }
  return extraction;
}
