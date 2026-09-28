import { hasAnswerText } from './answer-quality.js';
import { questionRole } from './search-evidence.js';

export function evidenceUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Review instructions and source examples, never a new measurement/detection pass. */
export function reportActions(summary, rows) {
  const clean = q => q.measured > 0 && q.engines.length >= 2 && !q.failed && !q.unmeasured && !q.missing && !q.possiblyTruncated;
  const buyerFirst = (a,b) => Number(questionRole(b.text)==='Buyer decision') - Number(questionRole(a.text)==='Buyer decision');
  const candidates = summary.questions.filter(clean);
  const weak = candidates.filter(q=>q.named < q.measured).sort((a,b)=>buyerFirst(a,b) || a.named/a.measured-b.named/b.measured || b.measured-a.measured || a.id-b.id)[0];
  const asset = candidates.filter(q=>q.cited > 0 && q.id !== weak?.id).sort((a,b)=>buyerFirst(a,b) || b.cited/b.measured-a.cited/a.measured || b.measured-a.measured || a.id-b.id)[0];
  const plan = summary.priorities.filter(p=>p.owner==='Measurement owner');
  const evidence = q => {
    // Same eligibility rules as the summary. Unmatched/failed rows never count as absences.
    const answers = rows.filter(r=>r.prompt_id===q.id && r.ok && hasAnswerText(r.response_text) && r.mentioned != null);
    const pages = new Map();
    const engines = new Map();
    for (const row of answers) {
      const engine = engines.get(row.engine) || {engine:row.engine,measured:0,named:0,cited:0,runIds:[]};
      engine.measured++; engine.named+=Number(Boolean(row.mentioned)); engine.cited+=Number(Boolean(row.cited));
      if(Number.isInteger(Number(row.id)) && Number(row.id)>0) engine.runIds.push(Number(row.id));
      engines.set(row.engine,engine);
      const seen = new Set();
      for (const source of row.source_links || []) {
        const url = evidenceUrl(source.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const page = pages.get(url) || {url,owned:source.owned===true,answers:0};
        page.answers++; pages.set(url,page);
      }
    }
    const ranked=[...pages.values()].sort((a,b)=>b.answers-a.answers || a.url.localeCompare(b.url));
    return {question:q.text,questionId:q.id,measured:q.measured,named:q.named,cited:q.cited,
      engines:[...engines.values()].sort((a,b)=>a.engine.localeCompare(b.engine)),
      ownPages:ranked.filter(p=>p.owned).slice(0,3),otherPages:ranked.filter(p=>!p.owned).slice(0,3)};
  };
  if(weak) plan.push({
    do: weak.named===0 && weak.cited>0 ? 'Review a question where your site is cited but your brand is not named.' : 'Compare the answers that omit your brand.',
    because:`For “${weak.text}”, ${weak.measured-weak.named} of ${weak.measured} measured answers did not name the brand. The website was cited in ${weak.cited} of ${weak.measured}. This is a review opportunity in the sampled answers, not proof that a page is missing.`,
    steps:['Open the stored answers below and check whether the question fits a customer and product you serve.',
      'Compare the cited pages with your closest relevant page. Record the exact answer, eligibility detail, fee explanation or next step a customer needs. Confirm any factual claims against your own approved information.',
      'Choose an existing-page change only if the comparison reveals a specific omission. Propose a new page only if no suitable page exists. If no change is justified, record that finding.'],
    owner:'SEO and product/content lead',done:'A page URL, evidence from a stored answer, an agreed edit (or no-change decision), and a named owner are recorded.',evidence:evidence(weak)
  });
  if(asset) plan.push({do:'Protect a page already being cited.',
    because:`For “${asset.text}”, your website was cited in ${asset.cited} of ${asset.measured} measured answers. Start with the recorded pages below. A citation does not establish why a page was selected.`,
    steps:['Open the cited pages and compare their actual wording with the stored answers. Check any rates, fees, eligibility or other time-sensitive claims with the product owner.',
      'Check that the page names the relevant brand and product clearly and provides the appropriate customer next step. Keep useful content that is already accurate.',
      'Record any approved corrections and the publication date, then repeat the same measurement settings on a later day.'],
    owner:'Product/content owner',done:'The cited URLs are checked, approved corrections or a no-change decision are recorded, and a comparable follow-up is scheduled.',evidence:evidence(asset)
  });
  return plan.length ? plan.slice(0,3) : summary.priorities;
}
