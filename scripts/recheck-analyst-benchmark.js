import 'dotenv/config';
import {one,pool} from '../src/db/index.js';
import {validateAnalysis} from '../src/lib/report-analyst.js';
import {reviewSavedAnalysis} from '../src/lib/report-analyst-quality.js';
const [projectId,benchmarkId,...extra]=process.argv.slice(2);
try{
 if(!/^\d+$/.test(projectId||'')||!/^\d+$/.test(benchmarkId||'')||extra.length)throw Error('Usage: node scripts/recheck-analyst-benchmark.js PROJECT_ID BENCHMARK_ID');
 const b=await one('SELECT * FROM report_analyst_benchmarks WHERE project_id=$1 AND id=$2',[projectId,benchmarkId]);
 if(!b)throw Error('Benchmark not found for this project.');
 for(const arm of b.results||[]){
  const r=arm.response;
  const review=reviewSavedAnalysis({packet:b.packet,raw_response:r?.raw,stop_reason:r?.stop_reason});
  let analysis=null;
  if(review.structuralStatus==='passed')analysis=validateAnalysis(JSON.parse(r.raw.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')),b.packet);
  console.log(JSON.stringify({benchmarkId:b.id,model:arm.requestedModel,originalStatus:arm.status,review,analysis,
   trafficEvidence:b.packet.records.find(x=>x.id==='traffic')??null},null,2));
 }
 console.log('Read-only recheck of saved evidence and responses. No AI requests, imports, report changes or approvals. This is not a current-report freshness check.');
}catch(e){console.error(e.message);process.exitCode=1;}finally{await pool.end();}
