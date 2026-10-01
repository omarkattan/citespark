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

/** Editorial triage only. These rules never change stored intent or measurements. */
export function questionRole(text) {
  const wording = String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا');
  const provider = /\b(providers?|firms?|companies|banks?|lenders?|brokers?|advis[oe]rs?|wealth managers?|asset managers?|family offices?)\b|بنك|بنوك|مصارف|شركات|مزودي|مدير(?:ي|و)? الثروات|ادارة الثروات/.test(wording);
  const offering = provider || /\b(accounts?|cards?|mortgages?|loans?|insurance|wealth management|banking|financial services|investment services)\b|حساب|بطاق|قرض|قروض|تمويل|تامين/.test(wording);
  // Property selection is a buyer decision too. Keep this separate from brand
  // detection and retain a wording signal so definitions are not treated as purchase intent.
  const property = /\b(real estate|properties|property|apartments?|villas?|homes?|houses?|residences?|residential (?:communities|developments?)|developers?)\b|عقار|شقق|شقة|فلل|فيلا|مساكن|سكن|المطور|مطورين/.test(wording);
  const selection = /\b(which|who|where|best|top|choose|choosing|compare|comparison|versus|vs)\b|افضل|اختار|اختيار|مقارنة|اي بنك|اي البنوك|اي شركات|من يقدم|اين/.test(wording);
  const terms = /\b(fees?|costs?|minimum|eligible|eligibility|requirements?|interest rates?)\b|رسوم|تكلف|الحد الادنى|شروط|متطلبات|الفائدة/.test(wording);
  const action = /\b(open|apply|switch|transfer|hire)\b|افتح|فتح|اتقدم|التقدم|احول|تحويل/.test(wording);
  const propertyDecision = selection || terms
    || /\b(buy|buying|purchase|purchasing|rent|renting|payment plans?|handover|worth|trade-offs?|available)\b|شراء|للبيع|للايجار|استئجار|خطط سداد|خطط السداد|خطط دفع|خطط الدفع|تستحق|مقارنة|اقارن|الفروق|تختلف|الخيارات المتاحة|ما (?:المشاريع|المجمعات|المطورون|المطورين)/.test(wording);
  return (offering && (selection || terms || action)) || (property && propertyDecision)
    ? 'Buyer decision' : 'Topic to qualify';
}
export function reviewShortlist(questions) {
  const candidates = questions.filter(q => questionRole(q.text) === 'Buyer decision');
  const present = q => q.measured > 0 && Boolean(q.cited || q.named);
  const rate = (q, key) => q.measured > 0 ? q[key] / q.measured : 0;
  // Prefer more than one measured engine, then citation rate, naming rate and sample size.
  const strengths = candidates.filter(present).sort((a,b) =>
    Number((b.engines?.length || 0) >= 2) - Number((a.engines?.length || 0) >= 2)
    || rate(b,'cited') - rate(a,'cited') || rate(b,'named') - rate(a,'named')
    || b.measured - a.measured || a.id - b.id);
  const issues = q => (q.failed || 0) + (q.missing || 0) + (q.unmeasured || 0) + (q.possiblyTruncated || 0);
  const investigate = candidates.filter(q=>!present(q)).sort((a,b) =>
    Number(b.measured > 0) - Number(a.measured > 0) || issues(a) - issues(b)
    || b.measured - a.measured || a.id - b.id);
  // Reserve space for both an observed strength and a question needing investigation.
  // Missing evidence is a review task, never an asserted content gap.
  const selected = [strengths.shift(), investigate.shift()].filter(Boolean);
  return [...selected, ...strengths, ...investigate].slice(0,3);
}
