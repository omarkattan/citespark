import 'dotenv/config';
import {pool} from '../src/db/index.js';
import {buildReport} from '../src/lib/report.js';
import {reportPacket} from '../src/lib/report-analyst-store.js';
const id=process.argv[2];
try{
 if(!/^\d+$/.test(id||''))throw Error('Usage: node scripts/review-analyst-evidence.js PROJECT_ID');
 const report=await buildReport(Number(id),{},{presentationOnly:true});
 const packet=await reportPacket(report);
 const record=packet.records.find(r=>r.id==='question-summary');
 if(!record)throw Error('Calculated question totals were not included.');
 console.log(JSON.stringify({project:report.project.name,policy:packet.analysisPolicy,summary:JSON.parse(record.text)},null,2));
 console.log('Read-only check. No AI requests, report edits or measurement changes. Source groups are not intent classifications.');
}catch(error){console.error(error.message);process.exitCode=1;}finally{await pool.end();}
