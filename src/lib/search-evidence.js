import { signState, readState } from './tokens.js';

export function sealCandidate(projectId, candidate, evidence) {
  return signState({ purpose: 'gsc-import', projectId: String(projectId), candidate, evidence });
}
export function openCandidate(token, projectId, property) {
  const payload = readState(token, 30 * 60 * 1000);
  if (!payload || payload.purpose !== 'gsc-import' || payload.projectId !== String(projectId) || payload.evidence?.property !== property) {
    const err = new Error('Search evidence expired or the connected property changed. Load Search Console suggestions again.');
    err.code = 'GSC_SELECTION_EXPIRED';
    throw err;
  }
  return { ...payload.candidate, evidence: payload.evidence };
}

export function matchSearchSnapshot(origin, { rows, evidence }) {
  const full = Array.isArray(origin.querySet) && origin.querySet.length > 0;
  const queries = [...new Set(full ? origin.querySet : origin.queryExamples || [])];
  const wanted = new Set(queries);
  const matched = rows.filter(r => wanted.has(r.query));
  const impressions = matched.length ? matched.reduce((n,r) => n + r.impressions, 0) : null;
  return { ...evidence, scope: full ? 'stored query set' : 'stored query examples only', storedQueries: queries.length,
    matchedQueries: matched.length, impressions, clicks: matched.length ? matched.reduce((n,r) => n + r.clicks, 0) : null,
    avgPosition: impressions > 0 ? matched.reduce((n,r) => n + r.position * r.impressions, 0) / impressions : null };
}

/** Wording-based editorial triage, never a claim about intent, demand or revenue. */
export function questionRole(text) {
  if (/\b(best|top|choose|choosing|compare|comparison|versus|vs\.?|fees?|costs?|minimum|eligible|eligibility|providers?|firms?|companies)\b|أفضل|اختيار|رسوم|تكلفة|شركات|مقارنة/i.test(text || '')) return 'Buyer decision';
  return 'Topic to qualify';
}
export function reviewShortlist(questions) {
  return questions.filter(q => questionRole(q.text) === 'Buyer decision').sort((a,b) =>
    Number(Boolean(b.cited || b.named)) - Number(Boolean(a.cited || a.named)) || b.measured - a.measured || a.id - b.id).slice(0,3);
}
