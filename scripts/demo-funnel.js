import {one,pool} from '../src/db/index.js';
try{
 const days=Number(process.argv[2]||30);
 if(!Number.isInteger(days)||days<1||days>365)throw Error('Choose 1–365 days.');
 const r=await one(`SELECT count(*)::int AS started_sessions,
 count(*) FILTER(WHERE result_at IS NOT NULL)::int AS result_sessions,
 count(*) FILTER(WHERE signup_view_at IS NOT NULL)::int AS signup_page_sessions,
 count(*) FILTER(WHERE registered_at IS NOT NULL)::int AS registration_sessions,
 count(DISTINCT j.org_id) FILTER(WHERE registered_at IS NOT NULL)::int AS registered_organisations,
 count(DISTINCT j.org_id) FILTER(WHERE registered_at IS NOT NULL AND EXISTS(SELECT 1 FROM projects p JOIN reporting_runs r ON r.project_id=p.id WHERE p.org_id=j.org_id AND r.ok AND r.created_at>=j.registered_at))::int AS organisations_with_successful_answer,
 count(DISTINCT j.org_id) FILTER(WHERE registered_at IS NOT NULL AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.org_id=j.org_id AND s.plan<>'free' AND s.status='active'))::int AS currently_active_paid_plan_organisations
 FROM demo_journeys j WHERE j.started_at>=now()-($1 || ' days')::interval`,[String(days)]);
 console.log(JSON.stringify({cohortDays:days,asOf:new Date().toISOString(),...r},null,2));
 console.log('Starts are recorded anonymous browser sessions, not unique visitors. Existing signed-in accounts are excluded. Collection begins with Batch 112, not historical backfill. Cookie loss or another browser breaks attribution. Later stages can be absent or bypassed. Active paid plan is current subscription status, not verified payment or proof the demo caused a sale. Successful answer is not a completed full cycle.');
}finally{await pool.end();}
