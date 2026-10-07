import 'dotenv/config';
import {one,pool} from '../src/db/index.js';
import {reviewSavedAnalysis} from '../src/lib/report-analyst-quality.js';
const [projectId,draftId='latest',...extra]=process.argv.slice(2);
try{
 if(!/^\d+$/.test(projectId||'')||!(draftId==='latest'||/^\d+$/.test(draftId))||extra.length)throw Error('Usage: node scripts/review-analyst-quality.js PROJECT_ID [DRAFT_ID|latest]');
 const row=draftId==='latest'
  ?await one('SELECT id,packet,raw_response,stop_reason FROM report_analyst_drafts WHERE project_id=$1 ORDER BY id DESC LIMIT 1',[projectId])
  :await one('SELECT id,packet,raw_response,stop_reason FROM report_analyst_drafts WHERE project_id=$1 AND id=$2',[projectId,draftId]);
 if(!row)throw Error('No saved response for this project.');
 console.log(JSON.stringify(reviewSavedAnalysis(row),null,2));
 console.log('Read-only. No AI requests, report edits, approvals or measurement changes.');
}catch(e){console.error(e.message);process.exitCode=1;}finally{await pool.end();}
