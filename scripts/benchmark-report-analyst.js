import 'dotenv/config';
import {one,pool} from '../src/db/index.js';
import {packetHash} from '../src/lib/report-analyst.js';
import {BENCHMARK_MODELS,benchmarkArm,ANALYST_SYSTEM} from '../src/lib/report-analyst-benchmark.js';

// Dry run by default. Never edits drafts, approvals, snapshots or measurements.
let [projectId,draftId,...flags]=process.argv.slice(2);
try{
 if(!/^\d+$/.test(projectId||'')||!(draftId==='latest'||/^\d+$/.test(draftId||''))||flags.some(f=>!['--apply','--results'].includes(f)))throw Error('Usage: node scripts/benchmark-report-analyst.js PROJECT_ID DRAFT_ID [--apply|--results]');
 if(draftId==='latest'){const latest=await one('SELECT id FROM report_analyst_drafts WHERE project_id=$1 ORDER BY id DESC LIMIT 1',[projectId]);if(!latest)throw Error('No saved draft found.');draftId=String(latest.id);}
 const source=await one('SELECT id,packet FROM report_analyst_drafts WHERE project_id=$1 AND id=$2',[projectId,draftId]);
 if(!source?.packet?.records?.length)throw Error('Saved evidence not found for this project and draft.');
 const existing=await one('SELECT * FROM report_analyst_benchmarks WHERE project_id=$1 AND source_draft_id=$2',[projectId,draftId]);
 if(existing){console.log(JSON.stringify(flags.includes('--results')?existing:{id:existing.id,status:existing.status,results:existing.results},null,2));}
 else if(flags.includes('--results'))throw Error('No benchmark has been started for this draft.');
 else if(!flags.includes('--apply'))console.log(JSON.stringify({projectId,draftId,models:BENCHMARK_MODELS,characters:JSON.stringify(source.packet).length,evidenceHash:packetHash(source.packet),requests:2,maxOutputTokensEach:6000,message:'Add --apply for two paid requests. Results stay private in a separate benchmark table. No automatic retries or model switch. Candidate cost estimate may be unavailable; actual usage is recorded.'},null,2));
 else{
  if(!process.env.ANTHROPIC_API_KEY)throw Error('Anthropic API key is not configured.');
  if(JSON.stringify(source.packet).length>110000)throw Error('Saved packet exceeds the analyst input limit.');
  const db=await pool.connect();let run;
  try{
   await db.query('BEGIN');
   await db.query('SELECT pg_advisory_xact_lock(853002)');
   const recent=await db.query("SELECT count(*)::int AS total FROM report_analyst_benchmarks WHERE created_at>now()-interval '24 hours'");
   if(recent.rows[0].total>=5)throw Error('Daily benchmark limit reached (five pairs).');
   const inserted=await db.query("INSERT INTO report_analyst_benchmarks(project_id,source_draft_id,evidence_hash,packet,system_prompt,status) VALUES($1,$2,$3,$4,$5,'running') ON CONFLICT(project_id,source_draft_id) DO NOTHING RETURNING id",[projectId,draftId,packetHash(source.packet),source.packet,ANALYST_SYSTEM]);
   if(!inserted.rows.length)throw Error('This benchmark already exists. Rerun without --apply to read it.');
   run=inserted.rows[0];await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  console.log(`Benchmark ${run.id}. Two paid requests, no retries. Production model unchanged.`);
  const results=[];
  for(const model of BENCHMARK_MODELS){
   const result=await benchmarkArm(source.packet,model);
   results.push({requestedModel:model,...result});
   await pool.query('UPDATE report_analyst_benchmarks SET results=$2 WHERE id=$1',[run.id,JSON.stringify(results)]);
   console.log(JSON.stringify({model,...result},null,2));
  }
  await pool.query("UPDATE report_analyst_benchmarks SET status='complete' WHERE id=$1",[run.id]);
  console.log('Comparison stored. Complete means both attempts finished, not that the findings are approved. Review both analyses, caveats, token usage and timings before choosing a model.');
 }
}catch(error){console.error(error.message);process.exitCode=1;}finally{await pool.end();}
