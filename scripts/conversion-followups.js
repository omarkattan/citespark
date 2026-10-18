import {pool} from '../src/db/index.js';
import {processConversionFollowups} from '../src/lib/conversion-worker.js';
try{console.log(JSON.stringify(await processConversionFollowups({db:pool,send:process.argv.includes('--send')})));}
finally{await pool.end();}
