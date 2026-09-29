import 'dotenv/config';
import {pool} from '../src/db/index.js';
import {repairQuestionSample} from '../src/lib/repair-question-sample.js';
const args=process.argv.slice(2);
if(args.length<2 || args.length>3 || !/^[1-9]\d*$/.test(args[0]) || !/^[1-9]\d*$/.test(args[1]) || (args[2] && args[2]!=='--apply')){
 console.error('Usage: node scripts/repair-question-sample.js <project-id> <measurement-id> [--apply]');await pool.end();process.exit(1);
}
const db=await pool.connect();
try{
 const r=await repairQuestionSample(db,Number(args[0]),Number(args[1]),{apply:args[2]==='--apply'});
 console.log(JSON.stringify(r,null,2));
 console.log(r.applied?'Corrected snapshot published. Rebuild this project’s action list next. Original evidence and provider costs are unchanged. No engine calls.':'Preview only, or no correction needed. No changes made.');
}catch(e){console.error(e.message);process.exitCode=1;}
finally{db.release();await pool.end();}
