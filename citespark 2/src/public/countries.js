/* ISO 3166-1 alpha-2 codes, used for web_search_country_iso_code.
   GCC and the wider region first since that is where most projects sit,
   then the other large search markets, then alphabetical.
   Not every engine honours every country, and coverage outside the
   top markets is patchy, so treat results from small markets carefully. */
window.COUNTRIES = [
  ['AE', 'United Arab Emirates'],
  ['SA', 'Saudi Arabia'],
  ['QA', 'Qatar'],
  ['KW', 'Kuwait'],
  ['BH', 'Bahrain'],
  ['OM', 'Oman'],
  ['EG', 'Egypt'],
  ['GB', 'United Kingdom'],
  ['US', 'United States'],
  ['IN', 'India'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['--', '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'],
  ['AR', 'Argentina'],
  ['AU', 'Australia'],
  ['AT', 'Austria'],
  ['BD', 'Bangladesh'],
  ['BE', 'Belgium'],
  ['BG', 'Bulgaria'],
  ['BR', 'Brazil'],
  ['CH', 'Switzerland'],
  ['CL', 'Chile'],
  ['CN', 'China'],
  ['CO', 'Colombia'],
  ['CR', 'Costa Rica'],
  ['CY', 'Cyprus'],
  ['CZ', 'Czechia'],
  ['DK', 'Denmark'],
  ['EC', 'Ecuador'],
  ['EE', 'Estonia'],
  ['FI', 'Finland'],
  ['GR', 'Greece'],
  ['HK', 'Hong Kong'],
  ['HR', 'Croatia'],
  ['HU', 'Hungary'],
  ['ID', 'Indonesia'],
  ['IL', 'Israel'],
  ['IS', 'Iceland'],
  ['JO', 'Jordan'],
  ['JP', 'Japan'],
  ['KE', 'Kenya'],
  ['KR', 'South Korea'],
  ['LK', 'Sri Lanka'],
  ['LT', 'Lithuania'],
  ['LU', 'Luxembourg'],
  ['LV', 'Latvia'],
  ['MA', 'Morocco'],
  ['MT', 'Malta'],
  ['MX', 'Mexico'],
  ['MY', 'Malaysia'],
  ['NG', 'Nigeria'],
  ['NO', 'Norway'],
  ['PE', 'Peru'],
  ['PH', 'Philippines'],
  ['PK', 'Pakistan'],
  ['PL', 'Poland'],
  ['PT', 'Portugal'],
  ['RO', 'Romania'],
  ['RS', 'Serbia'],
  ['SE', 'Sweden'],
  ['SG', 'Singapore'],
  ['SI', 'Slovenia'],
  ['SK', 'Slovakia'],
  ['TH', 'Thailand'],
  ['TR', 'Turkey'],
  ['TW', 'Taiwan'],
  ['UA', 'Ukraine'],
  ['UY', 'Uruguay'],
  ['VN', 'Vietnam']
];

window.DEFAULT_COUNTRY = 'AE';

window.countryOptions = function (selected) {
  const pick = selected || window.DEFAULT_COUNTRY;
  return window.COUNTRIES.map(([code, name]) =>
    code === '--'
      ? `<option disabled>${name}</option>`
      : `<option value="${code}" ${code === pick ? 'selected' : ''}>${name}</option>`
  ).join('');
};
