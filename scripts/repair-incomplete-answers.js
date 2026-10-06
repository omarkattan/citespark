import {pool} from '../src/db/index.js';
import {repairIncompleteAnswers} from '../src/lib/repair-incomplete-answers.js';
const [project,list,...flags]=process.argv.slice(2);
if(!/^[1-9]\d*$/.test(project||'')||!/^\d+(,\d+)*$/.test(list||'')||flags.some(f=>f!=='--apply')){
 console.error('Usage: node scripts/repair-incomplete-answers.js <project-id> <run-id,run-id> [--apply]');await pool.end();process.exit(1);
}
const db=await pool.connect();
try{console.log(JSON.stringify(await repairIncompleteAnswers(db,Number(project),[...new Set(list.split(',').map(Number))],{apply:flags.includes('--apply')}),null,2));console.log('Original evidence and costs retained. No engine calls. Rebuild project actions after applying. Fixed report snapshots remain unchanged.');}
catch(e){console.error(e.message);process.exitCode=1;}finally{db.release();await pool.end();}
