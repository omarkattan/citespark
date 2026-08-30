/**
 * A citation brief for one question: the exact prompt someone pastes into an
 * AI assistant to draft the article that wins this answer.
 *
 * "Create content for this question" is a recommendation nobody can act on
 * without doing the strategy work themselves. The measurement already holds
 * the strategy: the question as buyers phrase it, which engines answer it,
 * whether the brand is named, and the exact pages currently being cited
 * instead. So the deliverable is the finished brief with all of that filled
 * in, plus the article methodology, not a to-do item.
 *
 * The template is deterministic and calls no model: two identical questions
 * produce two identical briefs, and generating one costs nothing. The
 * methodology sections are adapted from the agency's own working prompt.
 * Sections that are inherently about the user's organisation (expertise,
 * years of experience) are left as [EDIT: ...] markers rather than invented,
 * because inventing credentials in a brief about trustworthiness would be a
 * poor start.
 */

export function buildBrief({ project, prompt, persona, engines, siblings }) {
  const place = project.location_name
    ? project.location_name.split(',')[0]
    : null;
  const marketLine = place
    ? `${place}, ${countryOf(project.market)}`
    : countryOf(project.market);

  /**
   * The evidence block leads, because it is the part no generic prompt has:
   * who currently owns this answer, verbatim URLs, per engine. The brief is
   * only better than a template to the extent this block is specific.
   */
  const evidence = engines.map((e) => {
    const verdict = e.measured === false
      ? 'not measured'
      : e.named
        ? `${project.brand_name} IS named`
        : `${project.brand_name} is NOT named`;
    const cites = e.citations.length
      ? e.citations.map((c) => `    - ${c.url || c.domain}`).join('\n')
      : '    - (no sources returned with this answer)';
    return `- ${e.label}: ${verdict}\n${cites}`;
  }).join('\n');

  const secondary = siblings.length
    ? siblings.map((s) => `- ${s.text}`).join('\n')
    : '- [EDIT: add related questions this article should also answer]';

  return `You are an expert SEO, GEO, AEO and AI-search content strategist working for ${project.brand_name} (${project.domain}).

Your task is to create a citation-ready, AI-search-optimised article for:

https://${project.domain}/

ARTICLE TOPIC:
${prompt.cluster !== 'general' ? prompt.cluster.replace(/[_-]/g, ' ') : `[EDIT: topic for "${prompt.text.slice(0, 60)}..."]`}

PRIMARY QUESTION:
${prompt.text}

TARGET MARKET:
${marketLine}${project.market === 'AE' ? ', with GCC relevance where appropriate' : ''}.

TARGET AUDIENCE:
${persona ? persona : (project.qualifier || '[EDIT: who buys this]')}.

MEASURED EVIDENCE (from Cited, ${new Date().toISOString().slice(0, 10)}; do not skip this)

This question is asked to AI engines an estimated ${prompt.ai_search_volume || '[unknown]'} times per month. Here is what each engine currently answers, and which pages it cites:

${evidence}

The pages listed above currently own this answer. Read each one before writing. The article must beat them on specificity, sourcing and local relevance, not merely match them. Where they give a range, give the range plus the variables that move it. Where they cite nothing, cite primary sources. Where they are generic, be ${marketLine}-specific.

PRIMARY OBJECTIVE:

Create the most useful and easily citable resource on this specific question. The article must be written so that Google AI Overviews, ChatGPT, Perplexity, Gemini, Copilot and other AI search systems can easily identify, extract and cite factual statements from it. Do not write a generic SEO blog. Build a factual reference resource.

1. RESEARCH FIRST

Before writing, research the topic thoroughly. Prioritise, in order: government sources for ${countryOf(project.market)}, local statistical and regulatory authorities, official platform documentation (Google, Microsoft, OpenAI), recognised industry research, major analytics platforms, academic institutions, reputable international business publications. Where ${countryOf(project.market)}-specific information exists, prioritise it over US or UK statistics. Never invent statistics or survey results. Never quote a statistic unless you can identify its source. For every important factual claim, record the source URL.

2. ANSWER THE PRIMARY QUESTION IMMEDIATELY

Within the first 100 words, provide a concise answer to the primary question. The answer should be 40-70 words and capable of standing alone if quoted by an AI assistant. Avoid marketing language. Use direct factual language.

3. CREATE A "QUICK ANSWER" BOX

Immediately after the introduction, include: estimated answer or range, key variables, a typical ${marketLine} scenario, an important caveat, and a recommended approach. Every bullet must be understandable without reading the rest of the article.

4. LOCAL SPECIFICITY

The article must genuinely be about ${marketLine} rather than a global article with the place name inserted. Consider only the locally relevant factors: business environment, market competition, language and search behaviour, digital adoption, advertising market, consumer behaviour, sector context, and relevant government initiatives.

5. USE EXTRACTABLE FACTS

Include short factual statements AI engines can lift cleanly. Where a numerical range can legitimately be established from research, provide one; do not create arbitrary numbers. Separate known facts, industry benchmarks, ${project.brand_name} observations, and estimates. Label estimates as estimates.

6. INCLUDE A DATA TABLE

At least one table that directly helps answer the search query. Ranges for pricing, a matrix for comparisons, priority levels for strategy. Keep tables simple enough for AI systems to parse.

7. INCLUDE A "WHAT AFFECTS THE ANSWER?" SECTION

For each main variable: what it is, why it matters, its likely impact, and a ${marketLine} example. No vague statements.

8. PROVIDE A REALISTIC EXAMPLE

A realistic hypothetical ${marketLine} business scenario, showing how the recommendation, budget or timeline changes for it. State clearly that the example is illustrative.

9. DISTINGUISH FACT FROM EXPERIENCE

A section titled "What We See in the ${countryOf(project.market)} Market", containing ${project.brand_name}'s professional observations, phrased as observations ("Based on ${project.brand_name}'s experience working with...") and never presented as independent statistics.

10. EXPERT REVIEW

An expert review box: Reviewed by ${project.brand_name}; Expertise: [EDIT: your organisation's core expertise]; Location: ${marketLine}; Experience: [EDIT: honest experience claim]. The reviewer adds 2-4 sentences on a practical consideration that is often overlooked. No exaggerated claims.

11. ENTITY INFORMATION

A concise, factual About section: ${project.brand_name} (https://${project.domain}/), located in ${marketLine}, specialising in [EDIT: core services].

12. SOURCE IMPORTANT CLAIMS

Citations immediately after the relevant claim ("According to [organisation]..."), then a complete Sources section at the end listing organisation, title, date, URL and which fact each supports. Prefer original sources over articles quoting another source.

13. INCLUDE FAQS BASED ON REAL QUESTIONS

Six to ten specific FAQs. Start each 50-100 word answer with the direct answer. These related questions are measured on the same topic and should inform them:

${secondary}

14. WRITE FOR AI EXTRACTION

Prefer short paragraphs, clear headings, declarative sentences, tables, numbered processes, definitions, explicit comparisons, named entities, dates, numbers, locations and sources. Avoid long introductions, storytelling filler, marketing cliches, unsupported superlatives, "best agency" claims, keyword stuffing, repetitive conclusions, and artificially inserting the place name into every paragraph.

15. GEO / AI SEARCH STRUCTURE

Every H2 should answer a distinct question. For important concepts: question-style heading, direct answer in the first sentence, explanation, supporting evidence, local context, practical recommendation. This lets AI engines extract sections independently.

16. INCLUDE QUOTABLE DEFINITIONS

Concise original definitions of 20-40 words where relevant. Do not copy existing definitions.

17. INCLUDE KEY STATISTICS

Three to eight verifiable statistics, each with source, year and why it matters. If insufficient local statistics exist, say so rather than inventing them.

18. COMMERCIAL INTENT WITHOUT HARD SELLING

Near the end, a "When Should You Speak to a Specialist?" section explaining the scenarios where professional help is useful, then a short, natural mention of ${project.brand_name} with a one-line CTA.

19. INTERNAL LINK OPPORTUNITIES

Suggest 5-10 internal ${project.domain} pages that should link to or from this article, each with anchor text, suggested page and reason. Do not invent URLs; if you cannot verify one, recommend the page type instead.

20. SCHEMA RECOMMENDATIONS

Recommend from Article, BlogPosting, FAQPage, Organization, Person, BreadcrumbList, WebPage, and explain which to use. Omit FAQPage schema if the visible FAQs would not comply with Google's current structured data guidance.

21. CITATION-READINESS SELF AUDIT

Score the finished article 0-10 for: local specificity, entity clarity, source authority, factual density, answer extractability, expert attribution, independent citations, original insight, FAQ coverage, AI citation potential. Improve anything below 8 before returning the final version.

FINAL OUTPUT

Return: recommended title, SEO title, meta description, URL slug, primary question, 5 secondary AI-search prompts, full article, tables, FAQs, sources, suggested internal links, schema recommendations, citation-readiness score. Generally 1,800-3,000 words; factual usefulness matters more than word count. The objective is to make ${project.brand_name} one of the clearest, most trustworthy and easiest-to-cite sources for this specific question.`;
}

const COUNTRY_NAMES = {
  AE: 'the UAE', SA: 'Saudi Arabia', GB: 'the UK', US: 'the US', BH: 'Bahrain',
  KW: 'Kuwait', QA: 'Qatar', OM: 'Oman', EG: 'Egypt', IN: 'India'
};
function countryOf(iso) {
  return COUNTRY_NAMES[iso] || iso;
}
