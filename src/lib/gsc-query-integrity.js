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
  // Do not infer that a named app is a banking app from the customer's sector.
  const app=/تطبيق|\bapp(?:lication)?\b/i;
  const banking=/بنك|بنوك|بنكي|مصرف|\bbank(?:ing)?\b/i;
  if(app.test(original) && !banking.test(original) && banking.test(rewritten)) return false;
  return typeof rewritten==='string' && queryLanguage(original)===queryLanguage(rewritten) && numbers(original)===numbers(rewritten);
}
