import 'dotenv/config';
import {one,pool} from '../src/db/index.js';
import {buildReport} from '../src/lib/report.js';
import {reportPacket} from '../src/lib/report-analyst-store.js';
import {prepareBenchmarkDraft} from '../src/lib/report-analyst-import.js';
const [projectId,benchmarkId,email,...flags]=process.argv.slice(2);
try{
 if(!/^\d+$/.test(projectId||'')||!/^\d+$/.test(benchmarkId||'')||!email||flags.some(f=>f!=='--apply'))throw Error('Usage: node scripts/import-analyst-benchmark.js PROJECT_ID BENCHMARK_ID ACCOUNT_EMAIL [--apply]');
 const user=await one('SELECT u.id FROM users u JOIN projects p ON p.org_id=u.org_id WHERE p.id=$1 AND lower(u.email)=lower($2)',[projectId,email]);
 if(!user)throw Error('Account does not belong to this project organization.');
 const benchmark=await one('SELECT * FROM report_analyst_benchmarks WHERE id=$1 AND project_id=$2',[benchmarkId,projectId]);
 if(!benchmark)throw Error('Benchmark not found for this project.');
 const scope=JSON.parse(benchmark.packet.records.find(r=>r.id==='scope')?.text||'{}');
 const period=scope.period?.chosen?{from:scope.period.from,to:scope.period.to}:{};
 const report=await buildReport(Number(projectId),period,{presentationOnly:true});
 if(report.executive.localeWarnings?.length)throw Error('Correct the measurement settings before importing analysis.');
 const prepared=prepareBenchmarkDraft(benchmark,await reportPacket(report),'claude-sonnet-5-5');
 if(!flags.includes('--apply'))console.log(JSON.stringify({projectId,benchmarkId,model:prepared.requestedModel,formatUpdate:prepared.provenance,findings:prepared.analysis.findings.map(f=>f.title),message:'Add --apply to save this existing response as a private, unapproved draft. No AI request or model switch.'},null,2));
 else{
  const db=await pool.connect();let row,reused=false;
  try{
   await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(853001)');
   const existing=await db.query('SELECT id FROM report_analyst_drafts WHERE project_id=$1 AND provider_id=$2 ORDER BY id LIMIT 1',[projectId,prepared.response.provider_id]);
   if(existing.rows.length){row=existing.rows[0];reused=true;}
   else{
    const r=prepared.response;
    const inserted=await db.query(`INSERT INTO report_analyst_drafts
     (project_id,evidence_hash,packet,status,requested_model,created_by,returned_model,usage,provider_id,stop_reason,raw_response,cost_estimate,analysis,created_at,import_provenance)
     VALUES($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
     [projectId,prepared.evidenceHash,prepared.packet,prepared.requestedModel,user.id,r.model,r.usage,r.provider_id,r.stop_reason,r.raw,prepared.cost,prepared.analysis,benchmark.created_at,prepared.provenance]);
    row=inserted.rows[0];
   }
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  console.log(JSON.stringify({draftId:row.id,reused,message:'Saved response available for editorial review. No new AI request. Nothing approved or published. Production model unchanged.',reviewUrl:`https://cited.ae/api/projects/${projectId}/report/analyst`},null,2));
 }
}catch(error){console.error(error.message);process.exitCode=1;}finally{await pool.end();}
