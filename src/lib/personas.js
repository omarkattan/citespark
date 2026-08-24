import { complete, parseJsonArray } from './anthropic.js';
import { many, one, query } from '../db/index.js';

/**
 * Buyer personas.
 *
 * "Which CRM is best" and "which CRM is best for a two-person agency on a
 * tight budget" are not the same question, and they do not get the same
 * answer. A single visibility number averages those together and hides the
 * thing worth knowing: which kind of buyer you are invisible to.
 *
 * Two rules shape this module.
 *
 *   Personas are derived from evidence where evidence exists. A persona
 *   invented from a category name is just a longer prompt, and a longer
 *   prompt is not a better measurement.
 *
 *   A persona has to earn its place. If asking as that persona returns the
 *   same brands as asking plainly, it is costing money and telling you
 *   nothing, and the product should say so rather than bill for it.
 */

const SYSTEM = `You identify the distinct buyer types for a business, for the purpose of measuring how AI assistants answer their questions differently.

Rules:
- Return only buyer types that would plausibly receive DIFFERENT recommendations. A persona that would get the same answer as everyone else is useless here.
- Ground each one in the evidence given. Do not invent a segment the evidence does not support.
- The descriptor is a first-person clause that will be prefixed to a question, 8 to 20 words. Written as the buyer would describe themselves, not as a marketer would describe them.
- Return ONLY a JSON array, 3 to 5 items: {"name": string (2-4 words), "descriptor": string, "context": string (one sentence on why they ask differently), "confidence": "evidence"|"inferred"}
- No preamble, no markdown fences.`;

/**
 * Suggest personas for a project, from whatever evidence exists.
 *
 * Search Console queries are the strongest signal: they are what real people
 * typed on their way to this site. The site's own copy is next. The category
 * alone is the weakest, and personas from it are marked inferred so nobody
 * mistakes a guess for a finding.
 */
/**
 * When the model is unavailable or returns nothing usable, these are offered
 * instead. Deliberately generic and clearly marked as such: the axes along
 * which buyers differ (budget, size, urgency, expertise) hold across almost
 * every category, and a plain fallback is better than an empty panel that
 * looks broken.
 */
function fallbackPersonas(project) {
  // The category is a noun phrase like "SEO and digital marketing agency",
  // so these are written to read naturally without it rather than slotting
  // it awkwardly into the middle of a sentence.
  return [
    {
      name: 'Price-led buyer',
      descriptor: 'I run a small business and I am watching every dirham, so cost matters more than anything else',
      context: 'Asks about price first, and tends to be shown cheaper or smaller providers than a neutral question returns.'
    },
    {
      name: 'Enterprise buyer',
      descriptor: 'I am buying on behalf of a large organisation and I need proven scale, references and compliance',
      context: 'Asks about track record and process, and tends to be shown established names rather than boutiques.'
    },
    {
      name: 'First-time buyer',
      descriptor: 'I have never bought anything like this before and I am not sure what I should be asking',
      context: 'Asks how to choose rather than who to choose, so answers often name guides rather than companies.'
    },
    {
      name: 'Urgent buyer',
      descriptor: 'I need this sorted within the month, not next quarter',
      context: 'Time pressure changes which providers are recommended, favouring availability over fit.'
    }
  ].map((p) => ({
    ...p,
    source: 'suggested',
    evidence: { from: 'a standard set, not your data', confidence: 'inferred', fallback: true }
  }));
}

export async function suggestPersonas(project, { gscQueries = [], pageText = '' } = {}) {
  const evidence = [];

  if (gscQueries.length) {
    const top = gscQueries.slice(0, 60).map((q) => `${q.query} (${q.impressions} impressions)`);
    evidence.push(`Search Console queries that already bring people to this site:\n${top.join('\n')}`);
  }
  if (pageText) evidence.push(`What the site says about itself:\n${pageText.slice(0, 2500)}`);

  const ask = `Business: ${project.brand_name} (${project.domain})
Category: ${project.category}
Market: ${project.market}
Who they say their customer is: ${project.qualifier || 'not stated'}

${evidence.length ? evidence.join('\n\n') : 'No search or site evidence available. Work from the category alone and mark every persona as inferred.'}

Identify the buyer types whose questions would produce different answers.`;

  let parsed = [];
  try {
    const raw = await complete(ask, { system: SYSTEM, maxTokens: 1600 });
    parsed = parseJsonArray(raw) || [];
  } catch (err) {
    console.warn(`persona suggestion failed, falling back: ${err.message}`);
  }

  const usable = parsed.filter((p) => p?.name && p?.descriptor && p.descriptor.length > 15);

  // An empty panel reads as a broken feature. Offering a plain set that is
  // labelled as generic is more honest and more useful than nothing.
  if (!usable.length) return fallbackPersonas(project);

  return usable
    .slice(0, 5)
    .map((p) => ({
      name: String(p.name).trim().slice(0, 60),
      descriptor: String(p.descriptor).trim().slice(0, 240),
      context: String(p.context || '').trim().slice(0, 300),
      // Without evidence nothing can be evidence-backed, whatever the model says.
      source: gscQueries.length && p.confidence === 'evidence' ? 'search-console' : 'suggested',
      evidence: {
        from: gscQueries.length ? 'search console queries' : pageText ? 'site content' : 'category only',
        confidence: gscQueries.length || pageText ? p.confidence || 'inferred' : 'inferred'
      }
    }));
}

/**
 * Rewrite a neutral question as this persona would ask it.
 *
 * Deliberately a prefix rather than a rewrite: the question being measured
 * stays comparable to the neutral version, so a difference in the answer is
 * attributable to the persona rather than to different wording.
 */
export function asPersona(question, persona) {
  // A descriptor written as a clause often ends in a comma, and stripping
  // only full stops left "investments,. How do I..." going to the engines.
  const d = persona.descriptor.trim().replace(/[.,;:\s]+$/, '');
  return `${d}. ${question}`;
}

/**
 * The question underneath a persona's version of it.
 *
 * Two personas asking the same thing store two rows with different text, so
 * the uniqueness constraint never fires and the duplication is invisible
 * until someone reads the list.
 */
export function baseQuestion(text, personas = []) {
  for (const p of personas) {
    const d = String(p.descriptor || '').trim().replace(/[.,;:\s]+$/, '');
    if (d && text.startsWith(d)) return text.slice(d.length).replace(/^[.,;:\s]+/, '');
  }
  return text;
}

/**
 * Are two personas different enough to be worth measuring separately?
 *
 * Suggestion can produce near-synonyms: "Alternative Investment Focused" and
 * "Asset Class Specialists" ask the same questions and get the same answers,
 * at twice the cost.
 */
export function personaOverlap(a, b) {
  const words = (s) =>
    new Set(
      String(s || '')
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );

  const wa = words(`${a.name} ${a.descriptor}`);
  const wb = words(`${b.name} ${b.descriptor}`);
  if (!wa.size || !wb.size) return 0;

  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

export const listPersonas = (projectId) =>
  many('SELECT * FROM personas WHERE project_id = $1 ORDER BY active DESC, id', [projectId]);

export async function savePersona(projectId, p) {
  return one(
    `INSERT INTO personas (project_id, name, descriptor, context, evidence, source)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (project_id, name) DO UPDATE SET
       descriptor = EXCLUDED.descriptor, context = EXCLUDED.context, evidence = EXCLUDED.evidence
     RETURNING *`,
    [projectId, p.name, p.descriptor, p.context || null, JSON.stringify(p.evidence || {}), p.source || 'manual']
  );
}

/**
 * Does this persona actually change the answer?
 *
 * Compares the brands named for a persona's questions against the brands
 * named for the neutral ones. A persona whose answers look identical is
 * spending the customer's allowance to tell them nothing they did not already
 * know, and the honest thing is to say so.
 */
export async function personaLift(projectId, cycle) {
  const rows = await many(
    `SELECT COALESCE(p.persona_id, 0) AS persona_id,
            pe.name AS persona,
            e.name AS brand, e.kind,
            COUNT(*) FILTER (WHERE m.mentioned)::int AS hits,
            COUNT(*)::int AS runs
     FROM prompts p
     JOIN runs r ON r.prompt_id = p.id AND r.cycle_date = $2 AND r.ok
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id
     LEFT JOIN personas pe ON pe.id = p.persona_id
     WHERE p.project_id = $1
     GROUP BY 1, 2, 3, 4`,
    [projectId, cycle]
  );

  const neutral = new Map();
  const byPersona = new Map();

  for (const r of rows) {
    const target = r.persona_id === 0 ? neutral : byPersona.get(r.persona_id) || new Map();
    target.set(r.brand, { rate: r.runs ? r.hits / r.runs : 0, kind: r.kind });
    if (r.persona_id !== 0) byPersona.set(r.persona_id, target);
  }

  const out = [];
  for (const [id, brands] of byPersona) {
    const name = rows.find((r) => r.persona_id === id)?.persona || `persona ${id}`;

    // Brands this persona sees that the neutral question does not, and the
    // reverse. Either direction is a finding.
    const onlyHere = [...brands.entries()].filter(([b, v]) => v.rate > 0.2 && (neutral.get(b)?.rate || 0) < 0.1);
    const onlyNeutral = [...neutral.entries()].filter(([b, v]) => v.rate > 0.2 && (brands.get(b)?.rate || 0) < 0.1);

    const shared = [...brands.keys()].filter((b) => neutral.has(b));
    const drift =
      shared.length === 0
        ? 1
        : shared.reduce((sum, b) => sum + Math.abs(brands.get(b).rate - neutral.get(b).rate), 0) / shared.length;

    /**
     * How much drift is just noise.
     *
     * These models are not deterministic, so two identical question sets
     * differ by chance alone, and the smaller the sample the more they
     * differ. A fixed threshold called a persona "different" on eight runs
     * of pure noise. This scales with the sample so a small one has to show
     * a large difference before we claim anything.
     */
    const runs = Math.min(
      rows.filter((r) => r.persona_id === id).reduce((n, r) => Math.max(n, r.runs), 0),
      rows.filter((r) => r.persona_id === 0).reduce((n, r) => Math.max(n, r.runs), 0)
    );
    const noise = runs > 0 ? Math.min(0.5, 1 / Math.sqrt(runs)) : 0.5;

    // A brand appearing or vanishing entirely is a stronger signal than
    // drift, and does not need the same guard.
    const changed = onlyHere.length > 0 || onlyNeutral.length > 0;
    const meaningful = changed || drift > noise;

    out.push({
      personaId: id,
      persona: name,
      differentBrands: onlyHere.map(([b]) => b),
      missingBrands: onlyNeutral.map(([b]) => b),
      drift: Math.round(drift * 100) / 100,
      noiseFloor: Math.round(noise * 100) / 100,
      runs,
      // The judgement, stated rather than left to the reader.
      verdict: meaningful
        ? 'this persona sees a different answer'
        : runs < 6
          ? 'too few answers to tell yet, so keep it for another cycle or two'
          : 'this persona gets the same answer as everyone else, so it is not earning its cost'
    });
  }

  return out.sort((a, b) => b.differentBrands.length + b.missingBrands.length - (a.differentBrands.length + a.missingBrands.length));
}

/**
 * Why one audience cannot see you, when another can.
 *
 * Knowing that UHNW principals see you in 8% of answers and price-led buyers
 * in 62% is a measurement. The brief is what differs underneath: which
 * sources shape that audience's answers, which rivals get named to them, and
 * which of your own questions they lose. Those three together are a piece of
 * work someone can actually do.
 */
export async function personaGap(projectId, personaId) {
  const { many, one } = await import('../db/index.js');

  const project = await one('SELECT domain, brand_name FROM projects WHERE id = $1', [projectId]);
  const cycle = (await one('SELECT MAX(cycle_date) AS d FROM runs WHERE project_id = $1 AND ok', [projectId]))?.d;
  if (!cycle) return null;

  const own = String(project.domain).replace(/^www\./, '').toLowerCase();

  // Scoped to this audience's questions, which is the whole point: a source
  // that shapes answers for everyone is a different finding from one that
  // shapes answers for the buyer who cannot see you.
  const where = personaId ? 'p.persona_id = $3' : 'p.persona_id IS NULL';
  const args = personaId ? [projectId, cycle, personaId] : [projectId, cycle];

  const sources = await many(
    `SELECT lower(regexp_replace(c.domain, '^www\\.', '')) AS domain,
            COUNT(*)::int AS citations,
            COUNT(DISTINCT r.prompt_id)::int AS questions,
            (ARRAY_AGG(c.url ORDER BY c.position))[1] AS example_url
     FROM citations c
     JOIN runs r ON r.id = c.run_id
     JOIN prompts p ON p.id = r.prompt_id
     WHERE r.project_id = $1 AND r.ok AND r.cycle_date = $2 AND ${where}
       AND lower(regexp_replace(c.domain, '^www\\.', '')) <> '${own}'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
    args
  );

  const named = await many(
    `SELECT e.name, e.kind,
            COUNT(*) FILTER (WHERE m.mentioned)::float / NULLIF(COUNT(*), 0) AS rate
     FROM mentions m
     JOIN runs r ON r.id = m.run_id
     JOIN prompts p ON p.id = r.prompt_id
     JOIN entities e ON e.id = m.entity_id
     WHERE r.project_id = $1 AND r.ok AND r.cycle_date = $2 AND ${where}
       AND e.kind IN ('owned', 'competitor')
     GROUP BY e.id, e.name, e.kind
     ORDER BY 3 DESC NULLS LAST`,
    args
  );

  // The questions this audience asks where the brand never appears. Ordered
  // by demand, so the list starts where the work is worth most.
  const lost = await many(
    `SELECT p.id, p.text, p.ai_search_volume AS volume,
            COUNT(*) FILTER (WHERE m.mentioned)::int AS named
     FROM runs r
     JOIN prompts p ON p.id = r.prompt_id
     JOIN mentions m ON m.run_id = r.id
     JOIN entities e ON e.id = m.entity_id AND e.kind = 'owned'
     WHERE r.project_id = $1 AND r.ok AND r.cycle_date = $2 AND ${where}
     GROUP BY p.id, p.text, p.ai_search_volume
     HAVING COUNT(*) FILTER (WHERE m.mentioned) = 0
     ORDER BY p.ai_search_volume DESC NULLS LAST LIMIT 12`,
    args
  );

  const us = named.find((n) => n.kind === 'owned');
  const ahead = named.filter((n) => n.kind === 'competitor' && (n.rate || 0) > (us?.rate || 0));

  return {
    personaId: personaId || null,
    rate: us?.rate ?? null,
    sources,
    ahead,
    lost,
    // Stated rather than left for the reader to assemble from three tables.
    brief: buildBrief({ brand: project.brand_name, rate: us?.rate ?? 0, sources, ahead, lost })
  };
}

/** One paragraph a person could act on, assembled from the three findings. */
function buildBrief({ brand, rate, sources, ahead, lost }) {
  const parts = [];

  if (ahead.length) {
    const top = ahead.slice(0, 2).map((a) => `${a.name} (${Math.round((a.rate || 0) * 100)}%)`).join(' and ');
    parts.push(`${top} are named to this buyer more often than ${brand} (${Math.round(rate * 100)}%).`);
  }

  if (sources.length) {
    const top = sources.slice(0, 3).map((s) => s.domain).join(', ');
    parts.push(
      `Answers to this audience are built from ${top}${sources.length > 3 ? ' and others' : ''}, and none of them cite you. Getting onto one of those is usually faster than ranking a new page.`
    );
  }

  if (lost.length) {
    parts.push(
      `${lost.length} of their questions never mention you at all, starting with "${String(lost[0].text).slice(0, 80)}".`
    );
  }

  return parts.join(' ') || 'Not enough measured yet for this audience to say what is missing.';
}
