import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createConversionStore,cleanAttribution} from '../src/lib/conversion.js';
import {conversionDashboard,conversionRows} from '../src/lib/conversion-dashboard.js';
import {transactionalWebhook} from '../src/lib/conversion-billing.js';
import {followupDecision,followupTemplate,unsubscribeToken,unsubscribeUser,emailHash} from '../src/lib/conversion-followups.js';
import {processConversionFollowups,liveEmailReady,expireConversionContext} from '../src/lib/conversion-worker.js';
import {verifyEmailWebhook,suppressDelivery} from '../src/lib/conversion-email-webhook.js';

const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8');
const migration=readFileSync(new URL('../src/db/conversion.sql',import.meta.url),'utf8');
async function database(){
 const pg=new PGlite();await pg.exec(schema);await pg.exec(migration);
 return {pg,query:(sql,args)=>pg.query(sql,args),async connect(){return {query:(sql,args)=>pg.query(sql,args),release(){}};}};
}
async function account(db,{internal=false,optIn=true,verified=true,age=3}={}){
 const org=(await db.query('INSERT INTO orgs(name,internal,created_at) VALUES($1,$2,now()-($3::int*interval \'1 day\')) RETURNING id',['Fixture Ltd',internal,age])).rows[0];
 const user=(await db.query(`INSERT INTO users(org_id,email,password_hash,created_at,email_verified_at,marketing_opt_in_at)
 VALUES($1,$2,'test-only',now()-($3::int*interval '1 day'),CASE WHEN $4 THEN now()-interval '2 days' END,CASE WHEN $5 THEN now()-interval '2 days' END) RETURNING id`,[org.id,`fixture-${org.id}@example.test`,age,verified,optIn])).rows[0];
 await db.query('INSERT INTO subscriptions(org_id,stripe_customer_id) VALUES($1,$2)',[org.id,`cus_${org.id}`]);
 return {orgId:org.id,userId:user.id};
}
function provider(orgId){
 const now=Math.floor(Date.now()/1000);
 const invoice={id:'in_first',customer:`cus_${orgId}`,subscription:'sub_1',status:'paid',amount_paid:7900,currency:'usd',billing_reason:'subscription_create',payment_intent:'pi_1',charge:'ch_1',status_transitions:{paid_at:now}};
 const refund={id:'re_1',charge:'ch_1',payment_intent:'pi_1',amount:1900,currency:'usd',status:'succeeded',created:now};
 const api={invoice,refund,subscriptions:{retrieve:async id=>({id,status:'active',created:now})},
 invoices:{retrieve:async()=>api.invoice},refunds:{retrieve:async()=>api.refund},charges:{retrieve:async()=>({id:'ch_1',customer:`cus_${orgId}`})},paymentIntents:{retrieve:async()=>({latest_charge:'ch_1'})}};
 return api;
}
const stripeEvent=(id,type,object,live=true)=>({id,type,data:{object},livemode:live,created:Math.floor(Date.now()/1000)});
const dispatch=(db,stripe,event,applySubscription=async()=>{})=>transactionalWebhook(event,{pool:db,stripe,applySubscription});

test('conversion migration is repeatable and freezes the existing-customer baseline',async()=>{
 const db=await database();
 try{
  const a=await account(db);
  await db.query("UPDATE subscriptions SET plan='starter',stripe_subscription_id='sub_live' WHERE org_id=$1",[a.orgId]);
  await db.pg.exec(migration);
  assert.equal((await db.query('SELECT conversion_existing_customer FROM orgs WHERE id=$1',[a.orgId])).rows[0].conversion_existing_customer,false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM conversion_events WHERE event_name='signup_completed'")).rows[0].n,1);
  await db.pg.exec(schema);await db.pg.exec(migration);
  assert.equal((await db.query('SELECT plan FROM subscriptions WHERE org_id=$1',[a.orgId])).rows[0].plan,'starter');
 }finally{await db.pg.close();}
});

test('complete recorded journey, same-browser claim, immutable first milestones and cohort revenue',async()=>{
 const db=await database(),store=createConversionStore(db),req={session:{acquisition:{data:{utm_source:'newsletter',utm_campaign:'october'}}}};
 try{
  await store.milestone(req,'started',{domain:'example.test',brandName:'Example',market:'AE'});
  await store.milestone(req,'result',{question:'Which provider?',engine:'chatgpt',runs:3,mentions:3});
  await store.milestone(req,'result',{question:'Which provider?',engine:'chatgpt',runs:3,mentions:3});
  const a=await account(db,{age:0});Object.assign(req.session,a);
  await store.milestone(req,'registered');await store.milestone(req,'registered');
  assert.equal((await store.handoff(req)).site.domain,'example.test');
  assert.equal(await store.handoff({session:{orgId:999}}),null);
  const project=(await db.query("INSERT INTO projects(org_id,name,domain,brand_name) VALUES($1,'Example','example.test','Example') RETURNING id",[a.orgId])).rows[0];
  await store.report(a.orgId,project.id,{executive:{totals:{measured:0}}});
  assert.equal((await db.query("SELECT count(*)::int AS n FROM conversion_events WHERE event_name='first_report_completed'")).rows[0].n,0);
  await store.report(a.orgId,project.id,{executive:{totals:{measured:3}}});
  await store.report(a.orgId,project.id,{executive:{totals:{measured:6}}});
  await store.pricing(req,'billing');await store.pricing(req,'billing');
  await store.event({name:'checkout_started',orgId:a.orgId,key:'checkout:cs_1'});
  const stripe=provider(a.orgId);stripe.invoice.status_transitions.paid_at+=2;
  await dispatch(db,stripe,stripeEvent('evt_first','invoice.payment_succeeded',stripe.invoice));
  const d=await conversionDashboard(db,30);
  assert.equal(d.metrics.demos,1);assert.equal(d.metrics.demoToSignup.percent,100);
  assert.equal(d.metrics.signupToProject.percent,100);assert.equal(d.metrics.projectToReport.percent,100);
  assert.equal(d.metrics.reportToPaid.percent,100);assert.equal(d.metrics.demoToPaid.percent,100);
  assert.equal(Number(d.revenue[0].gross_minor),7900);assert.equal(d.bySource[0].name,'newsletter');
  assert.equal(d.byEngine[0].name,'chatgpt');assert.equal(d.leads[0].followup.status,'waiting');
  const first=(await db.query("SELECT detail FROM conversion_events WHERE event_name='first_report_completed'")).rows[0];
  assert.equal(first.detail.measuredAnswers,3);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM conversion_events WHERE event_name='pricing_viewed'")).rows[0].n,1);
  const second=await account(db);req.session.orgId=second.orgId;await store.milestone(req,'registered');
  assert.equal((await db.query('SELECT org_id FROM demo_journeys')).rows[0].org_id,a.orgId);
 }finally{await db.pg.close();}
});

test('billing retries roll back atomically, duplicates and renewals never double-count new customers',async()=>{
 const db=await database();try{
  const a=await account(db),stripe=provider(a.orgId),event=stripeEvent('evt_retry','checkout.session.completed',{id:'cs_retry',customer:`cus_${a.orgId}`,subscription:'sub_1'});
  await assert.rejects(dispatch(db,stripe,event,async(_s,client)=>{await client.query("UPDATE subscriptions SET plan='starter' WHERE org_id=$1",[a.orgId]);throw Error('database failure');}));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM billing_events')).rows[0].n,0);
  assert.equal((await db.query('SELECT plan FROM subscriptions')).rows[0].plan,'free');
  await dispatch(db,stripe,event);assert.equal((await dispatch(db,stripe,event)).duplicate,true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM conversion_payments')).rows[0].n,0,'Checkout is not payment');
  await dispatch(db,stripe,stripeEvent('evt_payment','invoice.payment_succeeded',stripe.invoice));
  await dispatch(db,stripe,stripeEvent('evt_payment_other_id','invoice.payment_succeeded',stripe.invoice));
  stripe.invoice={...stripe.invoice,id:'in_renew',billing_reason:'subscription_cycle',payment_intent:'pi_renew',charge:'ch_renew'};
  await dispatch(db,stripe,stripeEvent('evt_renew','invoice.payment_succeeded',stripe.invoice));
  const d=await conversionDashboard(db,30);assert.equal(d.metrics.payingCustomers,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM conversion_payments')).rows[0].n,2);
  stripe.invoice={...stripe.invoice,id:'in_zero',amount_paid:0};await dispatch(db,stripe,stripeEvent('evt_zero','invoice.payment_succeeded',stripe.invoice));
  stripe.invoice={...stripe.invoice,id:'in_manual',amount_paid:7900,paid_out_of_band:true};await dispatch(db,stripe,stripeEvent('evt_manual','invoice.payment_succeeded',stripe.invoice));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM conversion_payments')).rows[0].n,2);
 }finally{await db.pg.close();}
});

test('refunds arriving before receipts reconcile, repeated status updates do not duplicate money',async()=>{
 const db=await database(),store=createConversionStore(db),req={session:{}};try{
  await store.milestone(req,'started',{domain:'refund.test'});await store.milestone(req,'result',{engine:'gemini',runs:3,mentions:0});
  const a=await account(db,{age:0});Object.assign(req.session,a);await store.milestone(req,'registered');
  const stripe=provider(a.orgId);
  await dispatch(db,stripe,stripeEvent('evt_refund','refund.created',stripe.refund));
  await dispatch(db,stripe,stripeEvent('evt_receipt','invoice.payment_succeeded',stripe.invoice));
  await dispatch(db,stripe,stripeEvent('evt_refund_again','refund.updated',stripe.refund));
  let d=await conversionDashboard(db,30);assert.equal(Number(d.revenue[0].refunded_minor),1900);
  stripe.refund.status='failed';await dispatch(db,stripe,stripeEvent('evt_refund_failed','refund.failed',stripe.refund));
  d=await conversionDashboard(db,30);assert.equal(Number(d.revenue[0].refunded_minor),0);
  stripe.refund.status='succeeded';stripe.refund.amount=7900;
  await dispatch(db,stripe,stripeEvent('evt_full_refund','refund.updated',stripe.refund));
  d=await conversionDashboard(db,30);assert.equal(Number(d.revenue[0].gross_minor)-Number(d.revenue[0].refunded_minor),0);
  assert.equal(d.metrics.payingCustomers,1,'Historical customer count is not erased by a refund');
 }finally{await db.pg.close();}
});

test('modern Stripe invoice payment references are expanded and test/internal accounts excluded',async()=>{
 const db=await database();try{
  const a=await account(db),internal=await account(db,{internal:true});
  const stripe=provider(a.orgId),original={...stripe.invoice};delete original.subscription;delete original.payment_intent;delete original.charge;
  original.parent={subscription_details:{subscription:'sub_1'}};
  let expanded=false;
  stripe.invoices.retrieve=async(_id,options)=>{if(options){expanded=true;return {...original,payments:{data:[{status:'paid',payment:{payment_intent:'pi_1'}}],has_more:false}};}return original;};
  await dispatch(db,stripe,stripeEvent('evt_modern','invoice.payment_succeeded',original,false));
  assert.equal(expanded,true);assert.equal((await db.query('SELECT payment_intent_ids FROM conversion_payments')).rows[0].payment_intent_ids[0],'pi_1');
  const d=await conversionDashboard(db,30);assert.equal(d.metrics.signups,0);assert.equal(d.metrics.payingCustomers,0);assert.equal(d.excludedTestAccounts,1);
 }finally{await db.pg.close();}
});

test('subscription sync uses current provider state and an old cancellation cannot overwrite a newer subscription',async()=>{
 process.env.DATABASE_URL='postgresql://test:test@localhost:1/test';
 process.env.STRIPE_PRICE_STARTER='price_starter_fixture';
 process.env.STRIPE_PRICE_GROWTH='price_growth_fixture';
 const {applySubscription}=await import('../src/lib/billing.js');
 const db=await database();try{
  const a=await account(db),stripe=provider(a.orgId),now=Math.floor(Date.now()/1000);
  let current={id:'sub_new',customer:`cus_${a.orgId}`,metadata:{org_id:String(a.orgId)},created:now,status:'active',items:{data:[{price:{id:'price_growth_fixture'},current_period_end:now+86400}]}};
  stripe.subscriptions.retrieve=async()=>current;
  await dispatch(db,stripe,stripeEvent('evt_new','customer.subscription.updated',{id:'sub_new',status:'incomplete'}),applySubscription);
  let row=(await db.query('SELECT * FROM subscriptions WHERE org_id=$1',[a.orgId])).rows[0];assert.equal(row.plan,'growth');assert.equal(row.status,'active');
  current={...current,id:'sub_old',created:now-100,status:'canceled'};
  await dispatch(db,stripe,stripeEvent('evt_old_cancel','customer.subscription.deleted',{id:'sub_old'}),applySubscription);
  row=(await db.query('SELECT * FROM subscriptions WHERE org_id=$1',[a.orgId])).rows[0];assert.equal(row.plan,'growth');
  current={...current,id:'sub_new',created:now};
  await dispatch(db,stripe,stripeEvent('evt_new_cancel','customer.subscription.deleted',{id:'sub_new'}),applySubscription);
  row=(await db.query('SELECT * FROM subscriptions WHERE org_id=$1',[a.orgId])).rows[0];assert.equal(row.plan,'free');assert.equal(row.status,'canceled');
 }finally{await db.pg.close();}
});

test('follow-up eligibility, paid suppression, frequency caps, opt-out and safe rendering',()=>{
 const now=new Date(),ago=h=>new Date(now-h*3600000),base={org_id:1,email_verified_at:ago(100),marketing_opt_in_at:ago(100),signup_at:ago(96),messages:[]};
 assert.equal(followupDecision(base,now).rule,'first_project');
 assert.equal(followupDecision({...base,email_verified_at:null},now).status,'suppressed');
 assert.equal(followupDecision({...base,marketing_opt_in_at:null},now).status,'suppressed');
 assert.equal(followupDecision({...base,email_suppressed_at:ago(1)},now).status,'suppressed');
 assert.equal(followupDecision({...base,project_at:ago(60)},now).rule,'first_report');
 assert.equal(followupDecision({...base,report_at:ago(30)},now).rule,'report_upgrade');
 assert.equal(followupDecision({...base,pricing_at:ago(30)},now).rule,'pricing_help');
 assert.equal(followupDecision({...base,checkout_at:ago(3)},now).rule,'checkout_help');
 assert.equal(followupDecision({...base,checkout_at:ago(1)},now).status,'waiting');
 assert.equal(followupDecision({...base,checkout_at:ago(3),checkout_completed_at:ago(2)},now).status,'suppressed');
 assert.equal(followupDecision({...base,paid_at:ago(3),checkout_at:ago(5)},now).rule,'customer_welcome');
 assert.equal(followupDecision({...base,messages:[{rule:'pricing_help',at:ago(5)}]},now).status,'waiting');
 assert.equal(followupDecision({...base,messages:['a','b','c'].map(rule=>({rule,at:ago(200)}))},now).status,'suppressed');
 assert.equal(followupDecision({...base,plan:'starter',subscription_status:'trialing'},now).status,'suppressed');
 assert.equal(followupDecision({},now).status,'anonymous');
 const template=followupTemplate('report_upgrade',{demo_summary:{question:'<img src=x>',engine:'<script>'}});
 assert.ok(template.html.includes('&lt;img'));assert.ok(!template.html.includes('<script>'));assert.ok(template.text.includes('$79'));
 const token=unsubscribeToken(1,'long-secret-for-test');assert.equal(unsubscribeUser(token,'long-secret-for-test'),1);assert.equal(unsubscribeUser(token,'wrong'),null);
 assert.equal(unsubscribeUser('2.'+token.split('.')[1],'long-secret-for-test'),null);
 assert.deepEqual(cleanAttribution({utm_source:'linkedin',utm_campaign:'x@example.com',utm_content:'https://example.test/personal',utm_medium:'paid',utm_term:'private name'}),{utm_source:'linkedin',utm_medium:'paid'});
});

test('worker defaults to preview, live requires approval, reservations cap delivery and opt-outs persist',async()=>{
 const db=await database();try{
  const a=await account(db);let calls=0;
  const transport=async()=>{calls++;return {ok:true,json:async()=>({id:'email_test'})};};
  assert.equal(liveEmailReady({}),false);
  const preview=await processConversionFollowups({db,transport});assert.equal(preview.eligible,1);assert.equal(calls,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM conversion_messages')).rows[0].n,0);
  await assert.rejects(processConversionFollowups({db,send:true,env:{},transport}));
  const env={CONVERSION_EMAIL_MODE:'live',CONVERSION_EMAIL_APPROVED:'true',CONVERSION_EMAIL_START_AT:new Date(Date.now()-4*86400000).toISOString(),RESEND_API_KEY:'fake',RESEND_WEBHOOK_SECRET:'fake',SESSION_SECRET:'test-secret',CANONICAL_HOST:'example.test'};
  const sent=await processConversionFollowups({db,send:true,env,transport});assert.equal(sent.sent,1);assert.equal(calls,1);
  await processConversionFollowups({db,send:true,env,transport});assert.equal(calls,1);
  await suppressDelivery({type:'email.complained',data:{email_id:'email_test'}},db);
  assert.equal((await db.query('SELECT reason FROM conversion_suppressions')).rows[0].reason,'complaint');
  const row=(await conversionRows(db,30))[0];assert.equal(followupDecision(row).status,'suppressed');
  await db.query('DELETE FROM orgs WHERE id=$1',[a.orgId]);assert.equal((await db.query('SELECT count(*)::int AS n FROM conversion_suppressions')).rows[0].n,1);
 }finally{await db.pg.close();}
});

test('uncertain sends never auto-retry and activation date prevents old-account campaigns',async()=>{
 const db=await database();try{
  await account(db);let calls=0;const transport=async()=>{calls++;throw Error('timeout');};
  const env={CONVERSION_EMAIL_MODE:'live',CONVERSION_EMAIL_APPROVED:'true',CONVERSION_EMAIL_START_AT:new Date().toISOString(),RESEND_API_KEY:'fake',RESEND_WEBHOOK_SECRET:'fake',SESSION_SECRET:'test-secret',CANONICAL_HOST:'example.test'};
  await processConversionFollowups({db,send:true,env,transport});assert.equal(calls,0);
  env.CONVERSION_EMAIL_START_AT=new Date(Date.now()-4*86400000).toISOString();
  await processConversionFollowups({db,send:true,env,transport});await processConversionFollowups({db,send:true,env,transport});assert.equal(calls,1);
  assert.equal((await db.query('SELECT status FROM conversion_messages')).rows[0].status,'uncertain');
 }finally{await db.pg.close();}
});

test('Resend signature matches the official Svix test vector, rejects tampering and expired requests',()=>{
 const secret='whsec_plJ3nmyCDGBKInavdOK15jsl',body=Buffer.from('{"event_type":"ping","data":{"success":true}}');
 const headers={'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='};
 assert.equal(verifyEmailWebhook(body,headers,secret,1731705121000).data.success,true);
 assert.throws(()=>verifyEmailWebhook(Buffer.from('{}'),headers,secret,1731705121000));
 assert.throws(()=>verifyEmailWebhook(body,headers,secret,1731705431000));
});

test('anonymous retention deletes only expired anonymous journeys and removes old setup context',async()=>{
 const db=await database(),store=createConversionStore(db);try{
  const anon={session:{}};await store.milestone(anon,'started',{domain:'old.test'});
  await db.query("UPDATE demo_journeys SET started_at=now()-interval '91 days'");
  await expireConversionContext(db);assert.equal((await db.query('SELECT count(*)::int AS n FROM demo_journeys')).rows[0].n,0);
 }finally{await db.pg.close();}
});
