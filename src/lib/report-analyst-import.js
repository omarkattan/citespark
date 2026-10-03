import {packetHash,validateAnalysis} from './report-analyst.js';
// Import is a private draft operation. It never approves, generates or changes a model.
export function prepareBenchmarkDraft(benchmark,currentPacket,model){
 if(!benchmark||benchmark.status!=='complete')throw Error('Benchmark has not completed.');
 if(!benchmark.packet||benchmark.evidence_hash!==packetHash(benchmark.packet))throw Error('Saved benchmark evidence failed its integrity check.');
 if(packetHash(currentPacket)!==benchmark.evidence_hash)throw Error('Report evidence has changed. This benchmark cannot become a current draft.');
 const arm=benchmark.results?.find(r=>r.requestedModel===model);
 if(arm?.status!=='complete'||arm.response?.stop_reason!=='end_turn'||!arm.response.provider_id)throw Error('A completed, traceable response was not found for this model.');
 const response=arm.response;
 let raw;try{raw=JSON.parse(response.raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw Error('Saved response is not valid JSON.');}
 const analysis=validateAnalysis(raw,benchmark.packet);
 validateAnalysis(analysis,currentPacket);
 return {analysis,packet:benchmark.packet,evidenceHash:benchmark.evidence_hash,requestedModel:model,response,cost:arm.cost||null};
}
