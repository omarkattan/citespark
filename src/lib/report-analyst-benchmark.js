import {createHash} from 'node:crypto';
import {ANALYST_MAX_OUTPUT_TOKENS,ANALYST_SYSTEM,requestAnalysis,validateAnalysis,analystCost,analysisReviewWarnings} from './report-analyst.js';
export const BENCHMARK_MODELS=['claude-sonnet-4-5-20250929','claude-sonnet-5-5'];
export const benchmarkSettings=model=>model==='claude-sonnet-5-5'?{output_config:{effort:'medium'}}:{};
export function benchmarkPlan(packet,{candidateOnly=false}={}){
 const models=candidateOnly?[BENCHMARK_MODELS[1]]:[...BENCHMARK_MODELS];
 const configuration={models,settings:models.map(benchmarkSettings),maxOutputTokens:ANALYST_MAX_OUTPUT_TOKENS,system:ANALYST_SYSTEM};
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
  response=await requestAnalysis(packet,{model,key,fetcher:(url,options)=>fetcher(url,{...options,body:JSON.stringify({...JSON.parse(options.body),...settings})})});
  if(response.stop_reason!=='end_turn')throw Error(`Incomplete response: ${response.stop_reason||'unknown'}`);
  const value=JSON.parse(response.raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  const analysis=validateAnalysis(value,packet);
  return {status:'complete',settings,response,analysis,warnings:analysis.findings.map(analysisReviewWarnings),elapsedMs:Date.now()-started,cost:analystCost(response.model,response.usage)};
 }catch(error){
  return {status:'failed',settings,response:response||null,error:error.message,elapsedMs:Date.now()-started,cost:response?analystCost(response.model,response.usage):null};
 }
}
export {ANALYST_SYSTEM};
