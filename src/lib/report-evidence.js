import { looksTruncated } from './analyze.js';

/** Shared report facts from persisted measurements, never a second detection pass. */
export function summariseEvidence(rows, { maxTokens = 2000 } = {}) {
  const questions = new Map();
  const totals = { attempted: rows.length, measured: 0, named: 0, cited: 0, failed: 0, unmeasured: 0, possiblyTruncated: 0 };
  for (const row of rows) {
    if (!questions.has(row.prompt_id)) questions.set(row.prompt_id, { id: row.prompt_id, text: row.text, source: row.source,
      measured: 0, named: 0, cited: 0, failed: 0, unmeasured: 0, possiblyTruncated: 0, engines: new Set() });
    const q = questions.get(row.prompt_id);
    if (!row.ok) { totals.failed++; q.failed++; continue; }
    if (row.mentioned == null) { totals.unmeasured++; q.unmeasured++; continue; }
    totals.measured++; q.measured++; q.engines.add(row.engine);
    if (row.mentioned) { totals.named++; q.named++; }
    if (row.cited) { totals.cited++; q.cited++; }
    if (looksTruncated(row.response_text, maxTokens)) { totals.possiblyTruncated++; q.possiblyTruncated++; }
  }
  const list = [...questions.values()].map(q => ({ ...q, engines: [...q.engines].sort() }));
  const supported = list.filter(q => q.measured > 0);
  const strongest = supported.filter(q => q.named > 0).sort((a,b) => b.named/b.measured-a.named/a.measured || b.measured-a.measured || a.id-b.id)[0] || null;
  // A partial, failed or unmeasured sample cannot support a confident gap action.
  const gaps = supported.filter(q => !q.named && !q.cited && !q.possiblyTruncated && !q.failed && !q.unmeasured && q.engines.length >= 2)
    .sort((a,b) => b.measured-a.measured || a.id-b.id);
  const citationAsset = supported.filter(q => q.cited > 0).sort((a,b) => b.cited/b.measured-a.cited/a.measured || b.measured-a.measured || a.id-b.id)[0] || null;
  const priorities = [];
  if (totals.possiblyTruncated || totals.failed || totals.unmeasured) priorities.push({
    do: 'Resolve incomplete evidence before interpreting gaps.',
    because: `${totals.possiblyTruncated} measured answers may be cut short, ${totals.failed} calls failed and ${totals.unmeasured} successful answers have no brand measurement. Review those stored answers before treating absence as a content gap.`,
    owner: 'Measurement owner', done: 'Affected questions have a reviewed, complete measurement or a clearly recorded limitation.'
  });
  if (gaps[0]) priorities.push({ do: 'Review a buyer question with no recorded presence.',
    because: `For “${gaps[0].text}”, the brand was neither named nor cited in ${gaps[0].measured} measured samples across ${gaps[0].engines.length} engines. Confirm business relevance, then compare the cited answers with existing content before deciding what to change.`,
    owner: 'Marketing and content lead', done: 'The question is confirmed relevant and an existing page improvement or a justified new asset is specified.' });
  if (citationAsset) priorities.push({ do: 'Build on content already being cited.',
    because: `For “${citationAsset.text}”, your site was cited in ${citationAsset.cited} of ${citationAsset.measured} measured answers. Review those sources for accuracy, freshness and a useful next step. A citation does not establish why the page was selected.`,
    owner: 'Content lead', done: 'The cited pages are reviewed and any factual, navigation or conversion changes are recorded.' });
  if (!priorities.length) priorities.push({ do: totals.measured ? 'Review this baseline and repeat the same question set.' : 'Collect a measured baseline.',
    because: totals.measured ? 'There is not enough evidence here for a specific content recommendation. Confirm the question set and inspect the stored answers before scheduling a comparable repeat.' : 'No owned-brand measurements are available in this selected cycle. Missing measurements are not zero visibility.',
    owner: 'Marketing lead', done: 'The agreed buyer questions have a measured baseline with recorded collection settings.' });
  return { totals, questions: list, strongest, citationAsset, priorities: priorities.slice(0,3),
    coveredQuestions: supported.filter(q => q.named || q.cited).length, measuredQuestions: supported.length };
}

export async function reportEvidence(projectId, period, many) {
  const rows = await many(`WITH latest AS (
    SELECT MAX(cycle_date) AS day FROM runs WHERE project_id=$1 AND ok
      AND ($2::date IS NULL OR cycle_date >= $2) AND ($3::date IS NULL OR cycle_date <= $3)
  )
  SELECT r.id, r.cycle_date, r.prompt_id, r.engine, r.ok, r.response_text,
         p.text, p.source, m.mentioned,
         EXISTS (SELECT 1 FROM citations c WHERE c.run_id=r.id
           AND lower(regexp_replace(c.domain, '^www\\.', '')) = lower(regexp_replace(pr.domain, '^www\\.', ''))) AS cited
  FROM runs r JOIN latest l ON r.cycle_date=l.day
  JOIN projects pr ON pr.id=r.project_id JOIN prompts p ON p.id=r.prompt_id
  LEFT JOIN mentions m ON m.run_id=r.id AND m.entity_id=(SELECT id FROM entities WHERE project_id=$1 AND kind='owned' ORDER BY id LIMIT 1)
  WHERE r.project_id=$1 ORDER BY p.id,r.engine,r.run_index`, [projectId, period.from, period.to]);
  const result = summariseEvidence(rows, { maxTokens: Number(process.env.MAX_OUTPUT_TOKENS || 2000) });
  return { ...result, cycle: rows[0]?.cycle_date || null };
}
