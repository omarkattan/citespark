import { complete, parseJsonArray } from './anthropic.js';

/**
 * Generate the tracked prompt set for a project.
 *
 * These are the questions a real buyer types into ChatGPT, not keywords.
 * Quality here decides whether the whole product is useful, so if an
 * ANTHROPIC_API_KEY is present we generate from the brand context and
 * only fall back to templates when it is not.
 */

const SYSTEM = `You write the question sets used to measure whether a brand appears in AI assistant answers.

Rules:
- Write questions exactly as a real buyer would type them into ChatGPT, in full sentences, 8 to 25 words.
- Never include the brand's own name. We are measuring unprompted recall.
- Cover a spread of intent: category discovery, comparison, "best X for Y" with a qualifier, problem-led, and pricing or process questions.
- Include location or sector qualifiers where the business is local or vertical.
- Return ONLY a JSON array. Each item: {"text": string, "cluster": string, "intent": "discovery"|"comparison"|"commercial"|"problem", "ai_search_volume": integer estimate 0-5000}
- No preamble, no markdown fences.`;

const TEMPLATES = [
  { t: 'What is the best {category} for {qualifier}?', cluster: 'best-of', intent: 'commercial' },
  { t: 'Which {category} companies are worth considering in {market}?', cluster: 'discovery', intent: 'discovery' },
  { t: 'How do I choose a {category} provider without getting burned?', cluster: 'selection', intent: 'problem' },
  { t: 'What should a {category} cost per month for a small business?', cluster: 'pricing', intent: 'commercial' },
  { t: 'Who are the top rated {category} specialists in {market}?', cluster: 'best-of', intent: 'discovery' },
  { t: 'What questions should I ask before hiring a {category}?', cluster: 'selection', intent: 'problem' },
  { t: 'Which {category} businesses have the strongest track record?', cluster: 'proof', intent: 'comparison' },
  { t: 'Is it better to hire a {category} or build the team in house?', cluster: 'comparison', intent: 'comparison' },
  { t: 'What does a good {category} report actually include?', cluster: 'process', intent: 'problem' },
  { t: 'How long does {category} take to show results?', cluster: 'process', intent: 'problem' }
];

function templateSet({ category, market, qualifier }) {
  return TEMPLATES.map((row, i) => ({
    text: row.t
      .replace('{category}', category)
      .replace('{market}', market)
      .replace('{qualifier}', qualifier),
    cluster: row.cluster,
    intent: row.intent,
    ai_search_volume: 500 - i * 30
  }));
}

/**
 * Questions a buyer would ask about one topic.
 *
 * A keyword is not a question, and the gap between them is where this
 * measurement lives: nobody asks an assistant "retirement planning", they ask
 * something a person would say out loud. This turns the topic into those
 * questions, using what the project already knows about the brand and who it
 * sells to.
 */
export async function questionsForTopic({ topic, brand, domain, category, market, qualifier, count = 8 }) {
  const system = `You write the questions a real buyer types into an AI assistant.

Rules:
- Never include the brand name. We are measuring whether the assistant volunteers it.
- Write what a person would actually say, not a search keyword. "retirement planning" becomes "how much do I need saved before I can retire in the UAE".
- Stay on the topic given. Do not drift into the wider category.
- Vary the intent: what it is, how to choose, what it costs, who is best, what goes wrong.
- Include the market where a buyer naturally would, and leave it out where they would not.
- Return ONLY a JSON array of strings. No preamble, no markdown fences.`;

  const ask = `Topic: ${topic}
Brand being measured: ${brand} (${domain})
What the business does: ${category}
Who the customer is: ${qualifier || 'not stated'}
Market: ${market}

Write ${count} questions this buyer would ask an AI assistant about "${topic}".`;

  const raw = await complete(ask, { system, maxTokens: 900 });
  const parsed = parseJsonArray(raw) || [];

  return parsed
    .map((q) => String(q).trim())
    .filter((q) => q.length > 12 && q.length < 220)
    // A question containing the brand name measures nothing: of course the
    // answer names them when the question already did.
    .filter((q) => !new RegExp(String(brand).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(q))
    .slice(0, count);
}

export async function generatePrompts({ brand, domain, category, market = 'the UK', qualifier = 'small business', count = 20 }) {
  const ask = `Business: ${brand} (${domain})
Category: ${category}
Market: ${market}
Typical customer: ${qualifier}

Write ${count} questions.`;

  const raw = await complete(ask, { system: SYSTEM, maxTokens: 2000 });
  const parsed = parseJsonArray(raw);

  if (parsed && parsed.length) {
    return parsed
      .filter((p) => p && typeof p.text === 'string' && p.text.length > 10)
      .map((p) => ({
        text: p.text.trim(),
        cluster: String(p.cluster || 'general').toLowerCase(),
        intent: ['discovery', 'comparison', 'commercial', 'problem'].includes(p.intent) ? p.intent : 'commercial',
        ai_search_volume: Number.isFinite(p.ai_search_volume) ? Math.max(0, Math.round(p.ai_search_volume)) : 100
      }))
      .slice(0, count);
  }

  return templateSet({ category, market, qualifier }).slice(0, count);
}
