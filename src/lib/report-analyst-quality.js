import {analystContext} from './report-analyst-context.js';
import {createHash} from 'node:crypto';
import {validateAnalysis} from './report-analyst.js';
export const QUALITY_BENCHMARK_VERSION='2026-10-08-v2';
// Review signals, not semantic proof. Passing these checks never approves copy.
export const QUALITY_RUBRIC=[
 {id:'facts',pass:'Every count, date, entity and engine outcome agrees with the cited saved record.',fail:'Any invented count, credential, cause, date or platform behaviour.'},
 {id:'comparisons',pass:'Question cohort, engines, settings and periods support each comparison. Zero baselines use counts or percentage points.',fail:'Revised questions called like-for-like, overlapping periods called independent, or percentage growth from zero.'},
 {id:'interpretation',pass:'Observed absence is limited to the measured sample. Possible explanations are explicitly unverified.',fail:'Zero naming proves a content defect, or a cited page proves why an engine selected it.'},
 {id:'action',pass:'One specific, proportionate next step follows from evidence, with a completion check that permits finding no defect.',fail:'Generic SEO audit, invented tracking implementation, or methodology filler presented as a business opportunity.'},
 {id:'readability',pass:'Client-facing terms, concise wording and no internal keys. Method limitations remain clear.',fail:'Raw field names, repeated caveats or operational details obscure the decision.'}
];
const rules=[
 ['ga4-identifiers',/property ID.{0,90}(?:matches?|same as|equals?).{0,50}measurement ID/i,'A numeric GA4 property ID is not the website measurement ID. Verify their association, not equality.'],
 ['changed-cohort',/(?:revised|additional|expanded) questions?[\s\S]{0,180}like.for.like/i,'Revised questions require a separate baseline.'],
 ['historical-window',/(?:repeat|re.query) (?:the )?(?:same|identical) (?:historical )?date range.{0,90}after/i,'The same historical dates cannot measure the effect of later changes.'],
 ['invented-comparability',/(?:platform|Cited) (?:will )?(?:calculates?|compares?).{0,100}(?:intersection|engine overlap)/i,'Confirm actual comparison logic. Do not invent an engine-intersection policy.'],
 ['attributed-selection',/(?:patterns|features|signals) that engines favou?red/i,'An answer mentioning features does not establish why an engine selected a business.'],
 ['zero-proves-defect',/(?:zero (?:naming|visibility)|absence).{0,50}(?:proves?|demonstrates?|confirms?).{0,60}(?:weak|insufficient|inadequate|missing)/i,'A sampled absence does not prove weak content or authority.'],
 ['nonzero-required',/(?:complete|successful|working).{0,70}(?:requires?|must (?:show|have|return)).{0,30}non.zero/i,'Successful collection may legitimately return zero.'],
 ['tracking-prescription',/(?:implement|configure|add).{0,35}(?:custom referrer parsing|manual AI UTM)/i,'Disconnected GA4 alone does not justify custom tracking changes.'],
 ['internal-fields',/supportedChange|coveredFrom|coveredTo|detailRowSum|periodAggregate|comparableCount|named\.answers/,'Replace internal data fields with readable definitions.']
];
function record(packet,id){try{return JSON.parse(packet.records.find(r=>r.id===id)?.text||'null');}catch{return null;}}
export function qualityReference(packet){
 const scope=record(packet,'scope'),summary=record(packet,'question-summary'),traffic=record(packet,'traffic');
 return {measurement:scope?.measurement??null,cycle:scope?.cycle??null,
  naming:summary?.all?.named??null,citation:summary?.all?.cited??null,
  engineCoverage:scope?.engineCoverage??null,trend:record(packet,'trend'),
  traffic:traffic?{state:traffic.state,from:traffic.from,to:traffic.to,coveredFrom:traffic.coveredFrom,coveredTo:traffic.coveredTo}:null,
  collectionNotes:record(packet,'collection-notes'),
  unknown:'Absent fields are unknown. Do not fill them from memory or another project.'};
}
export function qualitySignals(analysis,packet){
 const flags=[];
 const context=analystContext(packet);
 const prose=[...(analysis?.findings||[]).map(f=>Object.values(f).filter(v=>typeof v==='string').join(' ')),...(analysis?.limitations||[])].join(' ');
 if(/unmeasured[\s\S]{0,80}(?:plus|additional|another)[\s\S]{0,30}no.overview/i.test(prose))flags.push({finding:null,rule:'no-overview-double-count',message:'No-overview outcomes are included in unmeasured checks, not an additional category.'});
 const names={ai_mode:/Google AI Mode|ai_mode/i,ai_overview:/Google AI Overview|ai_overview/i,chatgpt:/ChatGPT/i,gemini:/Gemini/i,claude:/Claude/i,perplexity:/Perplexity/i};
 for(const e of context.coverage.enginesWithFailedRequests)if(analysis?.limitations?.length&&names[e.engine]&&!names[e.engine].test(prose))flags.push({finding:null,rule:'omitted-failing-engine',message:`Coverage review: ${e.engine} has ${e.failed} failed requests but is not named in the analysis.`});
 for(const [index,f] of (analysis?.findings||[]).entries()){
  const text=['title','observation','implication','action','done_when','follow_up'].map(k=>f[k]||'').join(' ');
  for(const [rule,re,message] of rules)if(re.test(text))flags.push({finding:index+1,rule,message});
  if(/(?:clicks?|events?).{0,60}(?:recorded|occurred|fired).{0,20}on (?:the |a )?[^.]{0,60}page/i.test(text)&&record(packet,'traffic')?.state==='ready')flags.push({finding:index+1,rule:'landing-page-event-location',message:'Landing-page rows do not identify where an event fired. Describe events associated with sessions beginning on that page.'});
  const denominator=context.analytics.rateDenominatorSessions;
  if(/\d+(?:\.\d+)?%/.test(text)&&/sessions.{0,45}(?:triggering|key event)|session.key.event/i.test(text)&&denominator!==null&&!new RegExp(String.raw`\b${String(denominator)}\b`).test(text.replace(/,/g,'')))flags.push({finding:index+1,rule:'missing-session-denominator',message:'State the known session denominator beside the session key-event rate.'});
  const coverage=record(packet,'scope')?.engineCoverage;
  if(coverage?.length&&coverage.filter(r=>Number(r.failed)>0).length<=2&&/several other engines.{0,80}(?:failures|failed)/i.test(text))flags.push({finding:index+1,rule:'extra-engine-failures',message:'Check engine-by-engine counts. The supplied coverage does not support several additional failing engines.'});
 }
 return flags;
}
export function reviewSavedAnalysis(row){
 const packet=row.packet||{records:[]};let value,validationError=null;
 if(row.stop_reason!=='end_turn')validationError='Provider response did not finish normally.';
 try{value=JSON.parse((row.raw_response||'').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{validationError ||= 'Saved response is not valid JSON.';}
 if(value&&!validationError)try{validateAnalysis(value,packet);}catch(e){validationError=e.message;}
 return {benchmark:QUALITY_BENCHMARK_VERSION,draftId:row.id,
  responseHash:createHash('sha256').update(row.raw_response||'').digest('hex'),
  evidenceHash:createHash('sha256').update(JSON.stringify(packet)).digest('hex'),
  structuralStatus:validationError?'blocked':'passed',validationError,
  signals:qualitySignals(value,packet),reference:qualityReference(packet),
  editorialStatus:'not_reviewed',rubric:QUALITY_RUBRIC,
  releaseRule:'All five rubric checks must be reviewed and pass. Any factual or comparison error blocks release. No automatic score or approval.',
  limitations:'Pattern-based signals are incomplete and can flag qualified statements. An empty signals list is not a quality pass.'};
}
