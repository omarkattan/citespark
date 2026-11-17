// Verified 2026-11-16 against bank websites and Jordan's central-bank directory:
// https://www.cbj.gov.jo/ar/Pages/Bankingsectorguide
// https://hbtf.com/ar/about-the-housing-bank https://www.cab.jo/ar/اتصل-بنا
// https://ahli.com/?lang=ar https://www.jordanislamicbank.com https://www.jkb.com
export const JORDAN_BANK_NAMES = {
 'bankaletihad.com':['Bank al Etihad','بنك الاتحاد'],
 'bankofjordan.com':['Bank of Jordan','بنك الأردن'],
 'capitalbank.jo':['Capital Bank','Capital Bank of Jordan','كابيتال بنك','بنك المال الأردني'],
 'arabbank.jo':['Arab Bank','البنك العربي'],
 'arabbank.com.jo':['Arab Bank','البنك العربي'],
 'hbtf.com':['Housing Bank for Trade and Finance','The Housing Bank','بنك الإسكان','بنك الإسكان للتجارة والتمويل'],
 'cab.jo':['Cairo Amman Bank','بنك القاهرة عمان'],
 'ahli.com':['Jordan Ahli Bank','البنك الأهلي الأردني'],
 'jordanislamicbank.com':['Jordan Islamic Bank','البنك الإسلامي الأردني'],
 'jkb.com':['Jordan Kuwait Bank','البنك الأردني الكويتي']
};
const exclusions={
 'bankofjordan.com':['Central Bank of Jordan','البنك المركزي الأردني'],
 'arabbank.jo':['Islamic International Arab Bank','International Islamic Arab Bank','البنك العربي الإسلامي الدولي'],
 'arabbank.com.jo':['Islamic International Arab Bank','International Islamic Arab Bank','البنك العربي الإسلامي الدولي']
};
export function reviewedEntityNames(entity) {
 const key=String(entity.domain||'').toLowerCase().replace(/^www\./,'');
 if(!JORDAN_BANK_NAMES[key])return entity;
 return {...entity,aliases:[...new Set([...(entity.aliases||[]),...JORDAN_BANK_NAMES[key].filter(n=>n!==entity.name)])],
  exclusions:[...new Set([...(entity.exclusions||[]),...(exclusions[key]||[])])],aliasPolicy:'jo-bank-names-2026-11-16'};
}
export const normaliseArabic=value=>String(value||'').normalize('NFKC').replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي');
