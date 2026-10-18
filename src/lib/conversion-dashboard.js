import {createConversionStore} from './conversion.js';
import {emailHash} from './conversion-followups.js';

// One row per attributed account, plus anonymous browser journeys and direct signups.
export async function conversionRows(db, days=30, orgId=null) {
  const {many}=createConversionStore(db);
  const rows=await many(`WITH first_journey AS (
    SELECT DISTINCT ON(org_id) * FROM demo_journeys WHERE org_id IS NOT NULL AND registered_at IS NOT NULL
    ORDER BY org_id,registered_at,id
  ), cohort AS (
    SELECT j.id AS journey_id,j.org_id,j.domain,j.attribution,j.demo_summary,j.result_at,j.started_at AS cohort_at
    FROM demo_journeys j LEFT JOIN first_journey f ON f.id=j.id
    WHERE j.result_at IS NOT NULL AND (j.org_id IS NULL OR f.id IS NOT NULL)
    UNION ALL
    SELECT NULL,o.id,NULL,'{}'::jsonb,'{}'::jsonb,NULL,o.created_at FROM orgs o
    WHERE NOT EXISTS(SELECT 1 FROM first_journey j WHERE j.org_id=o.id)
  ) SELECT c.*,o.name AS org_name,o.internal,o.conversion_test,o.conversion_existing_customer,
    s.plan,s.status AS subscription_status,
    u.id AS user_id,u.email,u.email_verified_at,u.marketing_opt_in_at,u.email_suppressed_at,
    (SELECT MIN(occurred_at) FROM conversion_events e WHERE e.org_id=c.org_id AND event_name='signup_completed') AS signup_at,
    (SELECT MIN(occurred_at) FROM conversion_events e WHERE e.org_id=c.org_id AND event_name='project_created') AS project_at,
    (SELECT MIN(occurred_at) FROM conversion_events e WHERE e.org_id=c.org_id AND event_name='first_report_completed') AS report_at,
    (SELECT MAX(occurred_at) FROM conversion_events e WHERE e.org_id=c.org_id AND event_name='pricing_viewed') AS pricing_at,
    (SELECT MAX(occurred_at) FROM conversion_events e WHERE e.org_id=c.org_id AND event_name='checkout_started') AS checkout_at,
    (SELECT MAX(occurred_at) FROM conversion_events e WHERE e.org_id=c.org_id AND event_name='checkout_completed') AS checkout_completed_at,
    (SELECT MIN(paid_at) FROM conversion_payments p WHERE p.org_id=c.org_id AND p.livemode) AS paid_at,
    EXISTS(SELECT 1 FROM conversion_payments p WHERE p.org_id=c.org_id AND NOT p.livemode) AS has_test_payment,
    COALESCE((SELECT json_agg(json_build_object('rule',m.rule,'at',m.created_at,'status',m.status)) FROM conversion_messages m WHERE m.org_id=c.org_id),'[]') AS messages
  FROM cohort c LEFT JOIN orgs o ON o.id=c.org_id
  LEFT JOIN subscriptions s ON s.org_id=c.org_id
  LEFT JOIN LATERAL(SELECT * FROM users WHERE org_id=c.org_id ORDER BY created_at,id LIMIT 1) u ON true
  WHERE c.cohort_at>=now()-($1::int*interval '1 day')
  AND ($2::int IS NULL OR c.org_id=$2)
  AND (c.org_id IS NULL OR (NOT o.internal AND NOT o.conversion_test))
  ORDER BY c.cohort_at DESC`,[days,orgId]);
  const hashes=rows.filter(r=>r.email).map(r=>emailHash(r.email));
  const suppressed=new Set(hashes.length?(await many('SELECT email_hash FROM conversion_suppressions WHERE email_hash=ANY($1::text[])',[hashes])).map(r=>r.email_hash):[]);
  return rows.map(r=>({...r,suppressed:r.email?suppressed.has(emailHash(r.email)):false}));
}

export function funnelMetrics(rows) {
  const demos=rows.filter(r=>r.result_at);
  const signed=rows.filter(r=>r.signup_at);
  const project=signed.filter(r=>r.project_at && new Date(r.project_at)>=new Date(r.signup_at));
  const report=project.filter(r=>r.report_at && new Date(r.report_at)>=new Date(r.project_at));
  const paid=rows.filter(r=>r.paid_at&&!r.conversion_existing_customer);
  const rate=(n,d)=>({converted:n,total:d,percent:d?Math.round(1000*n/d)/10:null});
  return {demos:demos.length,signups:signed.length,projects:project.length,reports:report.length,
    pricing:rows.filter(r=>r.pricing_at).length,checkouts:rows.filter(r=>r.checkout_at).length,
    payingCustomers:paid.length,
    demoToSignup:rate(demos.filter(r=>r.signup_at).length,demos.length),
    signupToProject:rate(project.length,signed.length),
    projectToReport:rate(report.length,project.length),
    reportToPaid:rate(report.filter(r=>r.paid_at&&!r.conversion_existing_customer&&new Date(r.paid_at)>=new Date(r.report_at)).length,report.length),
    demoToPaid:rate(demos.filter(r=>r.paid_at&&!r.conversion_existing_customer).length,demos.length)};
}

export async function conversionDashboard(db,days=30) {
  const rows=await conversionRows(db,days);
  // Any Stripe test-mode customer is excluded until explicitly classified with conversion_test.
  const production=rows.filter(r=>!r.has_test_payment);
  const group=key=>{
    const groups=new Map();
    for(const row of production){const name=key(row);if(!groups.has(name))groups.set(name,[]);groups.get(name).push(row);}
    return [...groups].map(([name,items])=>({name,...funnelMetrics(items)}));
  };
  const ids=production.filter(r=>r.result_at&&r.org_id&&!r.conversion_existing_customer).map(r=>r.org_id);
  const {many}=createConversionStore(db);
  const revenue=ids.length?await many(`WITH receipts AS (
    SELECT currency,SUM(amount_paid) AS gross FROM conversion_payments WHERE org_id=ANY($1::int[]) AND livemode GROUP BY currency
  ), refunds AS (
    SELECT r.currency,SUM(r.amount) AS refunded FROM conversion_refunds r
    WHERE r.org_id=ANY($1::int[]) AND r.livemode AND r.status='succeeded' AND EXISTS(
      SELECT 1 FROM conversion_payments p WHERE p.org_id=r.org_id AND p.livemode AND p.currency=r.currency
      AND (r.charge_id=p.charge_id OR r.payment_intent_id=ANY(p.payment_intent_ids))) GROUP BY r.currency
  ) SELECT receipts.currency,receipts.gross::text AS gross_minor,COALESCE(refunds.refunded,0)::text AS refunded_minor
    FROM receipts LEFT JOIN refunds USING(currency)`,[ids]):[];
  const {followupDecision}=await import('./conversion-followups.js');
  return {days,asOf:new Date().toISOString(),metrics:funnelMetrics(production),revenue,
    eligibleFollowups:production.filter(r=>followupDecision(r).status==='eligible').length,
    bySource:group(r=>r.attribution?.utm_source||r.attribution?.source||(r.result_at?'unknown':'direct / unattributed')),
    byEngine:group(r=>r.demo_summary?.engine||(r.result_at?'unknown':'no demo')),
    leads:production.slice(0,200).map(r=>({...r,followup:followupDecision(r)})),
    rowCount:production.length,shown:Math.min(200,production.length),excludedTestAccounts:rows.length-production.length,
    notes:'Completed browser demo journeys, not unique people. Rates use the same acquisition cohort and observed downstream events. A tested domain does not identify its owner. Cookie loss and other browsers may prevent attribution. Payments are observed receipts, not estimated plan value. Existing customers and test/internal accounts are excluded from new-customer totals.'};
}

export async function conversionJourney(db,{orgId,journeyId}) {
  const {one,many}=createConversionStore(db);
  const journey=orgId?await one('SELECT * FROM demo_journeys WHERE org_id=$1 ORDER BY registered_at LIMIT 1',[orgId]):await one('SELECT * FROM demo_journeys WHERE id=$1',[journeyId]);
  const id=orgId||journey?.org_id;
  if(!id&&!journey)return null;
  const events=await many(`SELECT event_name,occurred_at,detail FROM conversion_events
    WHERE ($1::int IS NOT NULL AND org_id=$1) OR ($2::uuid IS NOT NULL AND journey_id=$2)
    ORDER BY occurred_at,id`,[id||null,journey?.id||null]);
  const payments=id?await many(`SELECT invoice_id,currency,amount_paid,billing_reason,paid_at,livemode,
    CASE billing_reason WHEN 'subscription_update' THEN 'plan_change' WHEN 'subscription_cycle' THEN 'renewal'
      WHEN 'subscription_create' THEN 'subscription_start' ELSE billing_reason END AS payment_kind,
    row_number() OVER(PARTITION BY livemode ORDER BY paid_at,invoice_id)=1
      AND NOT (SELECT conversion_existing_customer FROM orgs WHERE id=$1) AS first_customer_payment
    FROM conversion_payments WHERE org_id=$1 ORDER BY paid_at`,[id]):[];
  const refunds=id?await many('SELECT refund_id,currency,amount,status,occurred_at FROM conversion_refunds WHERE org_id=$1 ORDER BY occurred_at',[id]):[];
  return {journey,events,payments,refunds};
}
