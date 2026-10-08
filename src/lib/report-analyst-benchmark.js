import {reviewSavedAnalysis,QUALITY_BENCHMARK_VERSION} from './report-analyst-quality.js';
import {createHash} from 'node:crypto';
import {ANALYST_MAX_OUTPUT_TOKENS,ANALYST_SYSTEM,requestAnalysis,validateAnalysis,analystCost,analysisReviewWarnings,analystOutputSchema,analystModelSettings} from './report-analyst.js';
export const BENCHMARK_MODELS=['claude-sonnet-4-5-20250929','claude-sonnet-5-5'];
export const benchmarkSettings=analystModelSettings;
export function benchmarkPlan(packet,{candidateOnly=false}={}){
 const models=candidateOnly?[BENCHMARK_MODELS[1]]:[...BENCHMARK_MODELS];
 const configuration={qualityBenchmark:QUALITY_BENCHMARK_VERSION,models,settings:models.map(benchmarkSettings),outputSchema:analystOutputSchema(packet),maxOutputTokens:ANALYST_MAX_OUTPUT_TOKENS,system:ANALYST_SYSTEM};
 const evaluationKey=createHash('sha256').update(JSON.stringify({packet,configuration})).digest('hex');
 return {models,evaluationKey,maxOutputTokensEach:ANALYST_MAX_OUTPUT_TOKENS,requests:models.length};
}
// Explicit candidate effort. Both arms use the same evidence, prompt and token ceiling.
// Candidate thinking consumes part of that ceiling and is included in provider usage.
export async function benchmarkArm(packet,model,{fetcher=fetch,key=process.env.ANTHROPIC_API_KEY}={}){
 if(!BENCHMARK_MODELS.includes(model))throw Error('Unsupported benchmark model.');
 const started=Date.now();
 let response;
 const settings=benchmarkSettings(model);
 try{
  response=await requestAnalysis(packet,{model,key,fetcher:(url,options)=>{const body=JSON.parse(options.body);return fetcher(url,{...options,body:JSON.stringify({...body,...settings,output_config:{...body.output_config,...settings.output_config}})});}});
  if(response.stop_reason!=='end_turn')throw Error(`Incomplete response: ${response.stop_reason||'unknown'}`);
  const value=JSON.parse(response.raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  const analysis=validateAnalysis(value,packet);
  return {status:'complete',settings,response,analysis,quality:reviewSavedAnalysis({packet,raw_response:response.raw,stop_reason:response.stop_reason}),warnings:analysis.findings.map(analysisReviewWarnings),elapsedMs:Date.now()-started,cost:analystCost(response.model,response.usage)};
 }catch(error){
  return {status:'failed',settings,response:response||null,quality:response?reviewSavedAnalysis({packet,raw_response:response.raw,stop_reason:response.stop_reason}):null,error:error.message,elapsedMs:Date.now()-started,cost:response?analystCost(response.model,response.usage):null};
 }
}
export {ANALYST_SYSTEM};
