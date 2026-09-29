/** Conservative search grouping. Never used for answer/brand detection. */
export function queryKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/gu,' ').replace(/[?؟]+$/u,'').trim();
}
export function containsSearchBrand(text, names) {
  const query=queryKey(text);
  return names.filter(Boolean).some(name=>{
    const literal=queryKey(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return literal && new RegExp(`(^|[^\\p{L}\\p{N}])${literal}($|[^\\p{L}\\p{N}])`,'u').test(query);
  });
}
export function queryLanguage(text) {
  const arabic=(String(text).match(/[\u0621-\u064a\u066e-\u06d3]/g)||[]).length;
  const latin=(String(text).match(/[a-z]/gi)||[]).length;
  return arabic > latin ? 'ar' : 'en';
}
const numbers=text=>(String(text).replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).match(/\d+(?:[.,]\d+)*/g)||[]).sort().join('|');
export function preservesQueryBasics(original, rewritten) {
  if (typeof rewritten !== 'string') return false;
  // Narrow, deterministic guards. These do not certify semantic equivalence.
  if (queryKey(original).split(' ').length < 2) return false;
  for (const pattern of SOURCE_QUALIFIERS) {
    if (pattern.test(original) !== pattern.test(rewritten)) return false;
  }
  // Do not infer that a named app is a banking app from the customer's sector.
  const app=/تطبيق|\bapp(?:lication)?\b/i;
  const banking=/بنك|بنوك|بنكي|مصرف|\bbank(?:ing)?\b/i;
  if(app.test(original) && !banking.test(original) && banking.test(rewritten)) return false;
  return typeof rewritten==='string' && queryLanguage(original)===queryLanguage(rewritten) && numbers(original)===numbers(rewritten);
}

// Keep named restrictions and common product/location qualifiers on both sides.
// Deliberately separate from brand detection and historical answer matching.
const SOURCE_QUALIFIERS = [
  /\bpersonal\b|شخصي/i,
  /\bsavings?\b|توفير|ادخار/i,
  /\bcurrent account\b|حساب(?:ات)? جار/i,
  /\b(?:salary|payroll)\b|راتب|رواتب/i,
  /\b(?:best|top|lowest|cheapest)\b|أفضل|افضل|أرخص|ارخص|الأقل|الاقل/i,
  /\b(?:Jordan|Jordanian)\b|الأردن|الاردن|أردني|اردني/i,
  /\b(?:Dubai)\b|دبي/i,
  /\b(?:Saudi|KSA)\b|السعودي/i,
  /\b(?:UAE|Emirates|Emirati)\b|الإمارات|الامارات|إماراتي|اماراتي/i,
  /\b(?:without|no) (?:a )?guarantor\b|بدون كفيل|دون كفيل/i,
  /\b(?:without|no) salary transfer\b|بدون تحويل راتب|دون تحويل راتب/i,
  /\bsame[ -]day\b|نفس اليوم/i,
];

/** Find previous imports by evidence, even if their question wording changed.
 * Includes paused/history rows so users manage those instead of reimporting.
 * Legacy examples are positive evidence only, never proof of complete coverage.
 */
export function existingGscQuestion(candidate, prompts, property) {
  const keys = new Set((candidate.querySet || candidate.examples || []).map(queryKey));
  return prompts.find(p => {
    if (queryKey(p.text) === queryKey(candidate.text)) return true;
    const origin = p.origin_details || {};
    if (!String(p.source || '').startsWith('gsc') || origin.property !== property) return false;
    const queries = [...(origin.querySet || []), ...(origin.queryExamples || [])];
    return queries.some(q => keys.has(queryKey(q)));
  });
}

/** Question form only, not a grammar or source-intent verdict.
 * A question mark cannot turn a keyword fragment into a buyer question.
 */
export function isBuyerQuestion(text) {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  if (value.length < 12 || value.length > 300 || /[\r\n]/u.test(value)) return false;
  const words = value.match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length < 2) return false;
  if (queryLanguage(value) === 'ar') {
    // Ignore vowel marks for this form check only. Stored text stays literal.
    const plain = value.replace(/[\u064b-\u065f\u0670]/gu, '');
    return /^(?:كيف|هل|ما|ماذا|أين|اين|متى|لماذا|كم|أي|اي|من|بأي|باي|لأي|لاي|بكم|لمن)\s+\S/u.test(plain);
  }
  return /^(?:who|what|which|when|where|why|how|is|are|am|can|could|should|would|will|does|do|did|has|have)\s+\S/iu.test(value);
}
