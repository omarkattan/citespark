import { looksTruncated } from './analyze.js';
/** Missing text cannot establish a brand's absence. Keep provider-confirmed
 * no-overview outcomes separate from legacy blanks with unknown cause. */
export const NO_OVERVIEW = 'No AI Overview returned for this query.';
export function hasAnswerText(text) { return typeof text === 'string' && text.trim().length > 0; }
export function unmeasuredReason(run) {
  if (!run.ok) return run.error || 'The provider call failed.';
  if (!hasAnswerText(run.response_text)) return run.no_overview === true || run.error === NO_OVERVIEW ? NO_OVERVIEW : 'No answer text was stored. The reason is not recorded.';
  return 'This answer has no brand measurement.';
}
export function measuredQuestionRates(runs) {
  const measured = runs.filter(r => r.mentioned != null);
  const n = measured.length;
  return { measured: n > 0, measuredAnswers: n,
    rate: n ? measured.filter(r => r.mentioned).length / n : null,
    citedRate: n ? measured.filter(r => r.cited).length / n : null,
    seenRate: n ? measured.filter(r => r.mentioned || r.cited).length / n : null };
}
/** A text-length heuristic is not grounds to delete a successful sample. */
export function retrySamples(existing) {
  return { broken: existing.filter(r => !r.ok), sound: existing.filter(r => r.ok) };
}

export function possibleTruncation(run, fallback = 2000) {
  // Google SERP collection does not use our assistant output-token budget.
  if (['ai_mode','ai_overview'].includes(run.engine)) return false;
  const recorded = Number(run.max_output_tokens);
  if (recorded > 0) return looksTruncated(run.response_text, recorded);
  if (typeof run.quality_review?.possibleTruncation === 'boolean') return run.quality_review.possibleTruncation;
  return looksTruncated(run.response_text, fallback);
}

export function collectionLimit(engine, limit) {
  return ['ai_mode','ai_overview'].includes(engine) ? null : limit;
}
