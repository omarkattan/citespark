/** Collection settings only. Never used to normalise brand detection. */
export function googleLanguage(prompt) {
  const text=String(prompt || '');
  const arabic=(text.match(/[\u0621-\u064a\u066e-\u06d3]/g)||[]).length;
  const latin=(text.match(/[a-z]/gi)||[]).length;
  return arabic > latin ? 'ar' : 'en';
}
export function googleLocale(prompt, market, locationName, locations) {
  const location = locationName || locations[String(market || '').toUpperCase()];
  if (!location) throw new Error(`Google search location is not configured for ${market || 'this market'}. Choose a supported location before measuring.`);
  return {location_name:location, language_code:googleLanguage(prompt)};
}
const OLD_COUNTRIES=new Set('AE SA QA KW BH OM EG GB US IN DE FR ES IT NL CA AU IE ZA SG PK TR MY ID PH NG KE'.split(' '));
export function historicalGoogleWarnings(measurement, questions) {
  if (!measurement || measurement.legacy || measurement.settings?.googleLocalePolicy) return [];
  const s=measurement.settings || {};
  if (!(s.engines || []).some(e=>e==='ai_mode'||e==='ai_overview')) return [];
  const warnings=[];
  if (s.market && !s.locationName && !OLD_COUNTRIES.has(s.market)) warnings.push(`Google collection used the old UAE fallback instead of the selected market (${s.market}). Do not use these Google results as a baseline for that market.`);
  if (questions.some(q=>googleLanguage(q.text)==='ar')) warnings.push('Arabic questions were collected with English Google search settings. A new measurement with matching language settings is needed.');
  return warnings;
}
