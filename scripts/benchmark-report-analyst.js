import 'dotenv/config';
import {one,pool} from '../src/db/index.js';
import {packetHash} from '../src/lib/report-analyst.js';
import {benchmarkPlan,benchmarkArm,ANALYST_SYSTEM} from '../src/lib/report-analyst-benchmark.js';

// Dry run by default. Never edits drafts, approvals, snapshots or measurements.
let [projectId,draftId,...flags]=process.argv.slice(2);
try{
 if(!/^\d+$/.test(projectId||'')||!(draftId==='latest'||/^\d+$/.test(draftId||''))||flags.some(f=>!['--apply','--results','--current','--candidate'].includes(f)))throw Error('Usage: node scripts/benchmark-report-analyst.js PROJECT_ID DRAFT_ID [--current] [--candidate] [--apply|--results]');
 if(draftId==='latest'){const latest=await one('SELECT id FROM report_analyst_drafts WHERE project_id=$1 ORDER BY id DESC LIMIT 1',[projectId]);if(!latest)throw Error('No saved draft found.');draftId=String(latest.id);}
 const source=await one('SELECT id,packet FROM report_analyst_drafts WHERE project_id=$1 AND id=$2',[projectId,draftId]);
 if(!source?.packet?.records?.length)throw Error('Saved evidence not found for this project and draft.');
 if(flags.includes('--apply')&&flags.includes('--results'))throw Error('Choose --apply or --results, not both.');
 let packet=source.packet;
 if(flags.includes('--current')&&!flags.includes('--results')){
  const {buildReport}=await import('../src/lib/report.js');
  const {reportPacket}=await import('../src/lib/report-analyst-store.js');
  const scope=JSON.parse(source.packet.records.find(r=>r.id==='scope')?.text||'{}');
  const period=scope.period?.chosen?{from:scope.period.from,to:scope.period.to}:{};
  const report=await buildReport(Number(projectId),period,{presentationOnly:true});
  if(!report.executive.totals.measured)throw Error('Collect a measured baseline before testing analysis.');
  if(report.executive.localeWarnings?.length)throw Error('Correct the measurement settings before testing analysis.');
  packet=await reportPacket(report);
 }
 const plan=benchmarkPlan(packet,{candidateOnly:flags.includes('--candidate')});
 const existing=flags.includes('--results')
  ?await one('SELECT * FROM report_analyst_benchmarks WHERE project_id=$1 AND source_draft_id=$2 ORDER BY id DESC LIMIT 1',[projectId,draftId])
  :await one('SELECT * FROM report_analyst_benchmarks WHERE project_id=$1 AND source_draft_id=$2 AND evaluation_key=$3',[projectId,draftId,plan.evaluationKey]);
 if(existing){console.log(JSON.stringify(flags.includes('--results')?existing:{id:existing.id,status:existing.status,results:existing.results},null,2));}
 else if(flags.includes('--results'))throw Error('No benchmark has been started for this draft.');
 else if(!flags.includes('--apply'))console.log(JSON.stringify({projectId,draftId,...plan,characters:JSON.stringify(packet).length,evidenceHash:packetHash(packet),evidenceMode:flags.includes('--current')?'current report':'saved draft',message:'Add --apply for the listed paid requests. Results stay private in a separate benchmark table. No automatic retries or model switch. Candidate cost estimate may be unavailable; actual usage is recorded.'},null,2));
 else{
  if(!process.env.ANTHROPIC_API_KEY)throw Error('Anthropic API key is not configured.');
  if(JSON.stringify(packet).length>110000)throw Error('Saved packet exceeds the analyst input limit.');
  const db=await pool.connect();let run;
  try{
   await db.query('BEGIN');
   await db.query('SELECT pg_advisory_xact_lock(853002)');
   const recent=await db.query("SELECT count(*)::int AS total FROM report_analyst_benchmarks WHERE created_at>now()-interval '24 hours'");
   if(recent.rows[0].total>=5)throw Error('Daily benchmark limit reached (five runs, at most two requests each).');
   const inserted=await db.query("INSERT INTO report_analyst_benchmarks(project_id,source_draft_id,evidence_hash,packet,system_prompt,status,evaluation_key) VALUES($1,$2,$3,$4,$5,'running',$6) ON CONFLICT(project_id,source_draft_id,evaluation_key) DO NOTHING RETURNING id",[projectId,draftId,packetHash(packet),packet,ANALYST_SYSTEM,plan.evaluationKey]);
   if(!inserted.rows.length)throw Error('This benchmark already exists. Rerun without --apply to read it.');
   run=inserted.rows[0];await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  console.log(`Benchmark ${run.id}. ${plan.requests} paid request(s), no retries. Production model unchanged.`);
  const results=[];
  for(const model of plan.models){
   const result=await benchmarkArm(packet,model);
   results.push({requestedModel:model,...result});
   await pool.query('UPDATE report_analyst_benchmarks SET results=$2 WHERE id=$1',[run.id,JSON.stringify(results)]);
   console.log(JSON.stringify({model,...result},null,2));
  }
  await pool.query("UPDATE report_analyst_benchmarks SET status='complete' WHERE id=$1",[run.id]);
  console.log('Comparison stored. Complete means the requested attempts finished, not that the findings are approved. Review both analyses, caveats, token usage and timings before choosing a model.');
 }
}catch(error){console.error(error.message);process.exitCode=1;}finally{await pool.end();}
