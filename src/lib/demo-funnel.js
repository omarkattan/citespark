import {randomUUID} from 'node:crypto';
import {query} from '../db/index.js';
// Operational milestones only. No IP, email, answer text or third-party analytics.
export async function demoMilestone(req,stage,domain=null){
 try{
  if(stage==='started'){
   if(req.session?.userId)return; // Existing accounts, including internal tests, are not acquisition leads.
   if(!req.session.demoJourney){req.session.demoJourney=randomUUID();}
   await query('INSERT INTO demo_journeys(id,domain) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[req.session.demoJourney,String(domain||'').slice(0,200)]);
   return;
  }
  const fields={result:'result_at',signup_view:'signup_view_at',registered:'registered_at'};
  if(!fields[stage]||!req.session?.demoJourney)return;
  await query(`UPDATE demo_journeys SET ${fields[stage]}=COALESCE(${fields[stage]},now()),org_id=COALESCE(org_id,$2) WHERE id=$1`,[req.session.demoJourney,stage==='registered'?req.session.orgId:null]);
 }catch(error){console.error('Demo milestone unavailable:',error.message);}
}
