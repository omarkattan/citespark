import { complete } from './anthropic.js';

/**
 * Turn one raw LLM answer into structured mentions.
 *
 * Ordinal matters: appearing first in a recommendation list is worth far
 * more than appearing fifth, and it is the metric most likely to move
 * before overall mention rate does.
 */

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function variants(entity) {
  const set = new Set();
  const add = (v) => {
    if (v && v.trim().length > 1) set.add(v.trim());
  };
  add(entity.name);
  for (const alias of entity.aliases || []) add(alias);
  if (entity.domain) {
    add(entity.domain);
    add(entity.domain.replace(/\.(com|co\.uk|io|ai|net|org)$/i, ''));
  }
  return [...set].sort((a, b) => b.length - a.length);
}

/** First character index at which this entity appears, or -1. */
function findFirstIndex(text, entity) {
  let best = -1;
  for (const v of variants(entity)) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(v)}([^a-z0-9]|$)`, 'i');
    const m = re.exec(text);
    if (m) {
      const idx = m.index + m[1].length;
      if (best === -1 || idx < best) best = idx;
    }
  }
  return best;
}

function snippetAround(text, index, width = 240) {
  if (index < 0) return null;
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + width);
  return (start > 0 ? '...' : '') + text.slice(start, end).trim() + (end < text.length ? '...' : '');
}

const NEGATIVE = /\b(avoid|poor|complaints?|disappoint|scam|overpriced|slow|unresponsive|mixed reviews|caution)\b/i;
const POSITIVE = /\b(recommend|strong|excellent|leading|best|trusted|highly regarded|well reviewed|award)\b/i;

function heuristicSentiment(snippet) {
  if (!snippet) return null;
  if (NEGATIVE.test(snippet)) return 'negative';
  if (POSITIVE.test(snippet)) return 'positive';
  return 'neutral';
}

/**
 * Analyse a single answer against all tracked entities.
 * Returns [{ entity_id, mentioned, ordinal, sentiment, snippet }]
 */
/**
 * Does this answer look like it stopped mid-flow?
 *
 * A truncated answer cannot support "not named": the brand may simply be in
 * the part that never arrived. Better to know the measurement is unreliable
 * than to record an absence that is really a token limit.
 */
export function looksTruncated(text, maxTokens = 2000) {
  const t = String(text || '').trimEnd();
  if (!t) return false;

  // Roughly four characters to a token. Well short of the ceiling means it
  // ended because the model finished, not because it ran out of room.
  const approxTokens = t.length / 4;
  if (approxTokens < maxTokens * 0.9) return false;

  // Ending on a sentence, a list item or a closed table reads as finished.
  return !/[.!?)\]"'\u201d]$/.test(t) || /\|\s*$/.test(t);
}

export async function analyseRun({ text, entities, useModel = false }) {
  const found = entities.map((entity) => ({
    entity,
    index: findFirstIndex(text || '', entity)
  }));

  const ordered = found
    .filter((f) => f.index >= 0)
    .sort((a, b) => a.index - b.index);

  const ordinalById = new Map();
  ordered.forEach((f, i) => ordinalById.set(f.entity.id, i + 1));

  const results = [];
  for (const f of found) {
    const mentioned = f.index >= 0;
    const snippet = mentioned ? snippetAround(text, f.index) : null;
    results.push({
      entity_id: f.entity.id,
      mentioned,
      ordinal: mentioned ? ordinalById.get(f.entity.id) : null,
      sentiment: mentioned ? heuristicSentiment(snippet) : null,
      snippet
    });
  }

  // Optional refinement for owned-brand sentiment only, to keep cost down.
  if (useModel) {
    const owned = results.find((r) => {
      const e = entities.find((x) => x.id === r.entity_id);
      return e && e.kind === 'owned' && r.mentioned;
    });
    if (owned && owned.snippet) {
      const verdict = await complete(
        `Classify how this passage characterises the brand. Reply with exactly one word: positive, neutral, or negative.\n\n${owned.snippet}`,
        { maxTokens: 10 }
      );
      const word = (verdict || '').toLowerCase().trim();
      if (['positive', 'neutral', 'negative'].includes(word)) owned.sentiment = word;
    }
  }

  return results;
}
