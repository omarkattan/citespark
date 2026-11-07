import { complete, parseJsonArray } from './anthropic.js';
import { isBuyerQuestion, containsSearchBrand, queryKey } from './gsc-query-integrity.js';

/**
 * Generate the tracked prompt set for a project.
 *
 * These are the questions a real buyer types into ChatGPT, not keywords.
 * Quality here decides whether the whole product is useful, so if an
 * ANTHROPIC_API_KEY is present we generate from the brand context and
 * only fall back to templates when it is not.
 */

export function topicLanguage(text) {
  return /[\u0620-\u064A\u066E-\u06D3\u06FA-\u06FC]/u.test(String(text)) ? 'ar' : 'en';
}

function languageRule(language) {
  if (!['en', 'ar'].includes(language)) throw new Error('Choose English or Arabic for site suggestions.');
  return `Write every question in ${language === 'ar' ? 'Arabic' : 'English'}. The market, location and brand must never override this language. Keep proper names as needed.`;
}

function matchesLanguage(text, language) {
  return topicLanguage(text) === language;
}

const SYSTEM = `You write the question sets used to measure whether a brand appears in AI assistant answers.

Rules:
- Use clear, natural phrasing in the requested language. Preserve the intended question and do not invent dialect or force extra qualifiers.
- Write questions exactly as a real buyer would type them into ChatGPT, as concise, natural questions. Avoid padding questions to meet a word count.
- Every item must be a complete question, not a keyword heading such as "Best skincare for dry skin" or "How to treat pigmentation". Use wording such as "Which skincare products suit dry skin?" or "How can I choose skincare for pigmentation?".
- Never include the brand's own name. We are measuring unprompted recall.
- Use the stated business activity and customer as the scope, not the literal meaning of its brand name. A wealth manager called The Family Office is not automatically a service for establishing or operating a family office.
- Do not invent services, eligibility requirements or customer segments beyond the supplied context.
- Prefer evergreen wording without a year. If a current-year qualifier is essential, use the supplied current year, never a past or future year.
- Lead with unbranded category discovery and provider/product shortlisting. At least half of the set, and the first five questions (or all if fewer than five are requested), must ask an assistant to recommend, name, shortlist or compare relevant businesses, providers or products. Label these intent "discovery" or "comparison". General advice such as "What should I consider?" is not provider discovery.
- Match the actual niche: for a marketing agency ask "Who are the best [actual service] agencies in [market]?"; for a shop ask where to buy its actual products; for a bank ask which banks offer the relevant service. Use the business's actual category, supported services, customer and market. Never make every business an agency.
- Vary the buying situation and supported service rather than repeating the same best-provider question with synonyms. Do not invent services or audiences.
- Place problem education, pricing and process questions after discovery and shortlisting.
- For sets of at least 10, cover all of these buyer needs: best providers/products; who/which to shortlist; where to buy or book; what the service includes; when it is needed; why choose one option over another; how to choose; and how much it costs. Use natural questions, not mechanically repeated prefixes. Include the buyer's main supported services and locations. Do not introduce adjacent services such as hybrid diagnostics unless the context explicitly supports them.
- Include a direct service-scope question (what is included) and a direct price/budget question (how much it costs). A best-provider question starting with "what" or "ما" does not cover service scope. A provider offering competitive prices does not answer the cost question. Arabic examples: "ما الذي تشمله خدمة ...؟" and "كم تبلغ تكلفة ...؟". Use clear Arabic technical terms, such as "برمجة كمبيوتر المحرك", rather than awkward literal translations.
- At least one question must explicitly ask who/which providers or products are best. Avoid vague questions about a provider's track record without naming the category or service.
- Include location or sector qualifiers where the business is local or vertical.
- Return ONLY a JSON array. Each item: {"text": string, "cluster": string, "intent": "discovery"|"comparison"|"commercial"|"problem"}
- No preamble, no markdown fences.`;

const TEMPLATES = [
  { t: 'What is the best {category} for {qualifier}?', cluster: 'best-of', intent: 'commercial' },
  { t: 'Which {category} companies are worth considering in {market}?', cluster: 'discovery', intent: 'discovery' },
  { t: 'What should I compare when choosing {category}?', cluster: 'selection', intent: 'problem' },
  { t: 'How much should I budget for {category}?', cluster: 'pricing', intent: 'commercial' },
  { t: 'Who are the top rated {category} specialists in {market}?', cluster: 'best-of', intent: 'discovery' },
  { t: 'What should I check before paying for {category}?', cluster: 'selection', intent: 'problem' },
  { t: 'Which {category} businesses have the strongest track record?', cluster: 'proof', intent: 'comparison' },
  { t: 'How can I compare the quality of different {category}?', cluster: 'comparison', intent: 'comparison' },
  { t: 'What evidence should I look for when comparing {category}?', cluster: 'process', intent: 'problem' },
  { t: 'How long does {category} take to show results?', cluster: 'process', intent: 'problem' }
];

export function isProviderDiscovery(text) {
  const value=String(text||'').toLowerCase().trim();
  if (/^(?:how|what) (?:can|should|do|would) i (?:choose|find|select|compare|check)|^(?:كيف|ما الذي)\s/u.test(value)) return false;
  return /\b(?:best|top[- ]rated|recommend|shortlist|worth considering)\b|أفضل|افضل|ترشح|تنصح|توصي/u.test(value)
    || /^(?:who|which|where)\b.*\b(?:provide|providers?|offer|garages?|shops?|centres?|centers?|banks?|agencies|companies|buy|book|find|get|specialis|specializ)/u.test(value)
    || /^(?:من|أي|اي|أين|اين)\s.*(?:يقدم|يوفر|ورش|مراكز|شركات|بنوك|وكالات|شراء|أشتري|اشتري|أحجز|احجز|أجد|اجد)/u.test(value);
}

/** Wording coverage, not a claim of service relevance or measured demand. */
export function baselineCoverage(items, requested = items.length) {
  const texts=items.map(p=>String(p.text||'').toLowerCase().trim());
  const tests={
    'best providers/products':t=>isProviderDiscovery(t)&&/\bbest\b|أفضل|افضل/u.test(t),
    'who/which to shortlist':t=>/^(?:who|which)\b|^(?:من|أي|اي)\s/u.test(t)&&isProviderDiscovery(t),
    'where to buy/book':t=>/^where\b|^(?:أين|اين)\s/u.test(t),
    'what is included':t=>/^what\b.*\b(?:include[ds]?|involve[ds]?|covers?|included)\b|^(?:ما|ماذا)\s.*(?:[يت]شمل|[يت]تضمن|يتضمن|المشمول)/u.test(t),
    'when it is needed':t=>/^when\b|^متى\s/u.test(t),
    'why choose an option':t=>/^why\b|^لماذا\s/u.test(t),
    'how to choose/use':t=>/^how\b(?!\s+much)|^كيف\s/u.test(t),
    'cost/budget':t=>/^(?:how much|what)\b.*\b(?:costs?|prices?|budget|pay|spend|charge[ds]?|fees?)\b|^how much (?:is|are)\b|^(?:كم|ما|ماذا)\s.*(?:تكلفة|تكلف|أسعار|اسعار|سعر|ميزاني|أدفع|ادفع|رسوم)|^بكم\s/u.test(t)
  };
  const covered=Object.keys(tests).filter(key=>texts.some(tests[key]));
  const missing=Object.keys(tests).filter(key=>!covered.includes(key));
  const discovery=texts.filter(isProviderDiscovery).length;
  const minimumDiscovery=Math.ceil(requested/2);
  const required=requested>=10?missing:missing.filter(x=>x==='best providers/products');
  return {covered,missing:required,discovery,minimumDiscovery,requested,total:items.length,
    complete:items.length>=requested&&required.length===0&&discovery>=minimumDiscovery};
}

export function discoveryFirst(suggestions, { category, market, brand, domain, language = 'en', count = 20 }) {
  const isRecommendation = p => isProviderDiscovery(p.text);
  const leading = suggestions.filter(isRecommendation);
  // Ensure a new project can test unprompted provider discovery even if the model
  // returns only education questions. These are suggestions, never GSC evidence.
  if (!leading.length && category && market) {
    const text = language === 'ar'
      ? `بمن تنصح في مجال ${category} في ${market}؟`
      : `Who would you recommend for ${category} in ${market}?`;
    if (matchesLanguage(text, language) && !containsSearchBrand(text, [brand, domain])) {
      leading.push({text, cluster:'provider-discovery', intent:'discovery', ai_search_volume:null});
    }
  }
  const seen = new Set();
  return [...leading, ...suggestions.filter(p => !isRecommendation(p))].filter(p => {
    const key = queryKey(p.text); if (seen.has(key)) return false; seen.add(key); return true;
  }).slice(0, count);
}

function templateSet({ category, market, qualifier }) {
  return TEMPLATES.map((row, i) => ({
    text: row.t
      .replace('{category}', category)
      .replace('{market}', market)
      .replace('{qualifier}', qualifier),
    cluster: row.cluster,
    intent: row.intent,
    ai_search_volume: null
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
  const language = topicLanguage(topic);
  const system = `${languageRule(language)}\n\nYou write the questions a real buyer types into an AI assistant.

Rules:
- Use clear, natural phrasing in the requested language. Preserve the intended question and do not invent dialect or force extra qualifiers.
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

  const raw = await complete(ask, { system, maxTokens: 900, timeoutMs:45000 });
  const parsed = parseJsonArray(raw) || [];

  return parsed
    .map((q) => String(q).trim())
    .filter((q) => matchesLanguage(q, language))
    .filter((q) => q.length > 12 && q.length < 220)
    // A question containing the brand name measures nothing: of course the
    // answer names them when the question already did.
    .filter((q) => !new RegExp(String(brand).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(q))
    .slice(0, count);
}

export async function generatePrompts({ brand, domain, category, market = 'the UK', qualifier = 'customers looking for this offering', count = 20, language = 'en', quickStart = false }, {completeText = complete} = {}) {
  count=Math.min(30,Math.max(1,Math.floor(Number(count)||20)));
  const system = `${languageRule(language)}\n\n${SYSTEM}${quickStart ? "\nFor this Quick Start set, override the broad education and W/cost coverage requirements above. Make at least 80% of questions ask which providers or products to shortlist, recommend or compare. Use distinct, supported buying needs, services and locations. Avoid general educational questions and repeated synonyms. Include price or service-scope criteria in buying questions only where relevant." : ""}`;
  const ask = `Current date: ${new Date().toISOString().slice(0, 10)}
Current year: ${new Date().getUTCFullYear()}
Business: ${brand} (${domain})
Category: ${category}
Market: ${market}
Typical customer: ${qualifier}

Write ${count} questions.`;

  const raw = await completeText(ask, { system, maxTokens: Math.min(6000, count*180), timeoutMs:45000 });
  const parsed = parseJsonArray(raw);

  if (parsed && parsed.length) {
    const clean = input => {
      const seen = new Set();
      return input
      .filter((p) => p && isBuyerQuestion(p.text) && !/^how\s+to\b/i.test(p.text.trim()))
      .filter((p) => !containsSearchBrand(p.text, [brand, domain]))
      .filter((p) => { const key = queryKey(p.text); if (seen.has(key)) return false; seen.add(key); return true; })
      .filter((p) => matchesLanguage(p.text, language))
      .filter((p) => !hasUnrequestedYear(p.text))
      .map((p) => ({
        text: p.text.trim(),
        cluster: String(p.cluster || 'general').toLowerCase(),
        intent: ['discovery', 'comparison', 'commercial', 'problem'].includes(p.intent) ? p.intent : 'commercial',
        ai_search_volume: null
      }))
      ;
    };
    let suggestions = clean(parsed);
    let coverage=quickStart ? {complete:suggestions.length>=count && suggestions.filter(p=>isProviderDiscovery(p.text)).length>=Math.ceil(count*.8),missing:[],discovery:suggestions.filter(p=>isProviderDiscovery(p.text)).length,minimumDiscovery:Math.ceil(count*.8)} : baselineCoverage(suggestions.slice(0,count),count);
    // A bounded repair asks for missing buyer needs, never silently invents
    // a full baseline or starts another measurement.
    if (!coverage.complete) {
      let extra;
      try { extra=await completeText(`${ask}\n\nReview these existing suggestions: ${JSON.stringify(suggestions)}\nMissing buyer needs: ${coverage.missing.join(', ')||'none'}. Current provider-discovery questions: ${coverage.discovery}, required: ${coverage.minimumDiscovery}. Write up to ${count} additional, distinct questions to fill the gaps and reach ${count} usable questions. Keep to explicitly supported services and translate category/location naturally for Arabic.`,{system,maxTokens:Math.min(6000,count*180),timeoutMs:45000}); } catch { /* Keep usable suggestions and surface incomplete coverage. */ }
      suggestions=clean([...suggestions,...(parseJsonArray(extra)||[])]);
    }
    if (suggestions.length) {
      const ordered=discoveryFirst(suggestions,{category,market,brand,domain,language,count:suggestions.length});
      if(quickStart && ordered.filter(p=>isProviderDiscovery(p.text)).length<Math.ceil(count*.8))throw new Error('Buyer-shortlist questions could not be prepared. Please try again.');
      if(quickStart) return ordered.filter(p=>isProviderDiscovery(p.text)).concat(ordered.filter(p=>!isProviderDiscovery(p.text))).slice(0,count);
      // Reserve the W/cost needs before filling remaining slots with discovery.
      const selected=[];
      const discovery=ordered.filter(p=>isProviderDiscovery(p.text));
      for(const need of ['best providers/products','who/which to shortlist','where to buy/book']){
        const match=discovery.find(p=>!selected.includes(p)&&baselineCoverage([p],10).covered.includes(need));
        if(match&&selected.length<count)selected.push(match);
      }
      for(const p of discovery)if(!selected.includes(p)&&selected.length<Math.ceil(count/2))selected.push(p);
      if(count>=10)for(const need of baselineCoverage(selected,count).missing){
        const match=ordered.find(p=>!selected.includes(p)&&baselineCoverage([p],10).covered.includes(need));
        if(match&&selected.length<count)selected.push(match);
      }
      for(const p of ordered)if(!selected.includes(p)&&selected.length<count)selected.push(p);
      return discoveryFirst(selected,{category,market,brand,domain,language,count});
    }
  }

  if (raw || language === 'ar') {
    throw new Error('No usable questions were returned in the selected language. Please try again.');
  }
  return discoveryFirst(templateSet({ category, market, qualifier })
    .filter(p => matchesLanguage(p.text, language)), {category, market, brand, domain, language, count});
}

/** New site suggestions are current discovery questions, not historical studies.
 * Reject date-qualified drift without rewriting the question or touching stored data.
 * Numeric budgets (including four-digit amounts) are not dates.
 */
export function hasUnrequestedYear(text, currentYear = new Date().getUTCFullYear()) {
  return [...String(text).matchAll(/\b(?:in|for|during|of|year)\s+(?:the year\s+)?(20\d{2})\b(?!\s*(?:dollars|USD|SAR|AED|riyals|dirhams)\b)/gi)]
    .some(m => Number(m[1]) !== currentYear);
}

