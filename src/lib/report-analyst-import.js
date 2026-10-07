import {packetHash,validateAnalysis} from './report-analyst.js';
import {isDeepStrictEqual} from 'node:util';
// Import is a private draft operation. It never approves, generates or changes a model.
export function prepareBenchmarkDraft(benchmark,currentPacket,model){
 if(!benchmark||!['complete','failed'].includes(benchmark.status))throw Error('Benchmark has not completed.');
 if(packetHash(currentPacket)!==benchmark.evidence_hash)throw Error('Report evidence has changed. This benchmark cannot become a current draft.');
 // The original hash was taken before storing JSONB. PostgreSQL may reorder object
 // keys on retrieval. Check that hash against the freshly rebuilt packet, then
 // compare the stored JSON values without relying on object key insertion order.
 // JSON serialization matches persistence (undefined properties are omitted).
 // Arrays, source text, values and types must still match exactly.
 if(!benchmark.packet||!isDeepStrictEqual(benchmark.packet,JSON.parse(JSON.stringify(currentPacket))))throw Error('Saved benchmark evidence failed its integrity check.');
 const arm=benchmark.results?.find(r=>r.requestedModel===model);
 if(!['complete','failed'].includes(arm?.status)||arm.response?.stop_reason!=='end_turn'||!arm.response.provider_id)throw Error('A completed, traceable response was not found for this model.');
 const response=arm.response;
 let raw;try{raw=JSON.parse(response.raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw Error('Saved response is not valid JSON.');}
 const analysis=validateAnalysis(raw,benchmark.packet);
 validateAnalysis(analysis,currentPacket);
 return {analysis,packet:benchmark.packet,evidenceHash:benchmark.evidence_hash,requestedModel:model,response,cost:arm.cost||null};
}
