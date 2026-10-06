// Narrow review rule for the observed introduction-only provider response.
// This does not prove that other answers are complete or factually correct.
export const ANSWER_ELIGIBILITY_POLICY = 'intro-only-withheld-v1';
export const INTRO_ONLY_REASON = 'This answer appears to introduce a list without supplying it. Brand naming and citation scores are withheld pending a complete measurement. The original answer is retained.';
export function introductionOnly(text) {
  return typeof text === 'string' && text.trim().length > 0 &&
    text.trim().length < 600 && /[:：]\s*$/.test(text) &&
    !/(?:^|\n)\s*(?:[-*]\s|\d+[.)]\s)/m.test(text);
}
