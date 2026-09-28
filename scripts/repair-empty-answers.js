import 'dotenv/config';
import {pool} from '../src/db/index.js';
import {repairEmptyAnswers} from '../src/lib/repair-empty-answers.js';
// Preview by default. No engine calls, token changes or model changes.
const args=process.argv.slice(2), ids=args.filter(a=>/^\d+$/.test(a));
if(ids.length!==1 || Number(ids[0])<1 || args.some(a=>a!=='--apply'&&!/^\d+$/.test(a))){
 console.error('Usage: node scripts/repair-empty-answers.js <project-id> [--apply]');await pool.end();process.exit(1);
}
const db=await pool.connect();
try{
 const apply=args.includes('--apply'),s=await repairEmptyAnswers(db,Number(ids[0]),{apply,maxTokens:Number(process.env.MAX_OUTPUT_TOKENS || 2000)});
 console.log(`${s.name}: ${s.runs} empty answer records, ${s.rows} derived verdicts ${apply?'removed and archived':'would be removed'}. Engines: ${s.engines.join(', ')||'none'}.`);
 console.log(`Completeness review: ${s.reviewed} retained answers, runtime review limit ${Number(process.env.MAX_OUTPUT_TOKENS || 2000)} tokens. Historical collection limits remain unknown.`);
 console.log(apply?'Raw answers and citations retained. No engine calls.':'Preview only. Nothing was written.');
}catch(e){console.error(e.message);process.exitCode=1;}
finally{db.release();await pool.end();}
