import { possibleTruncation } from './answer-quality.js';

// One recent flagged answer per engine, at most three independent pairs.
export function selectPilot(rows) {
  const seen = new Set();
  return rows.filter(r => {
    if (seen.has(r.engine) || !possibleTruncation(r)) return false;
    seen.add(r.engine);
    return true;
  }).slice(0, 3);
}

export async function runPilotPair({ row, model, ask, save, account, checkBudget }) {
  const results = [];
  for (const maxTokens of [700, 2000]) {
    await checkBudget();
    const answer = await ask({ engine: row.engine, prompt: row.text, model, maxTokens });
    await account(answer.costUsd || 0);
    const result = { maxTokens, requestedModel: model, answer,
      possiblyShort: possibleTruncation({ engine: row.engine, response_text: answer.text, max_output_tokens: maxTokens }) };
    await save(result);
    results.push(result);
  }
  return results;
}
