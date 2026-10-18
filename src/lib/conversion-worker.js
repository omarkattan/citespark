import {conversionRows} from './conversion-dashboard.js';
import {followupDecision,followupTemplate,emailHash,unsubscribeToken} from './conversion-followups.js';

export function liveEmailReady(env=process.env){
  return env.CONVERSION_EMAIL_MODE==='live'&&env.CONVERSION_EMAIL_APPROVED==='true'&&
    Number.isFinite(Date.parse(env.CONVERSION_EMAIL_START_AT||''))&&
    Boolean(env.RESEND_API_KEY&&env.RESEND_WEBHOOK_SECRET&&env.SESSION_SECRET&&env.SESSION_SECRET!=='change-me-in-env'&&env.CANONICAL_HOST);
}

export async function processConversionFollowups({db,send=false,env=process.env,transport=fetch,now=new Date()}) {
  const candidates=await conversionRows(db,365);
  const summary={mode:send?'live':'preview',eligible:0,sent:0,suppressed:0,uncertain:0};
  if(send&&!liveEmailReady(env))throw Error('Live conversion email is not approved or fully configured');
  for(const row of candidates){
    const decision=followupDecision(row,now);
    if(decision.status!=='eligible')continue;
    const suppressed=await db.query('SELECT 1 FROM conversion_suppressions WHERE email_hash=$1',[emailHash(row.email)]);
    if(suppressed.rows.length){summary.suppressed++;continue;}
    summary.eligible++;
    if(!send)continue;
    // No automatic catch-up campaign to old accounts on first activation.
    if(new Date(row.signup_at)<new Date(env.CONVERSION_EMAIL_START_AT)){summary.suppressed++;continue;}
    const client=await db.connect();let reservation=null;
    try{
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(18732026)');
      const fresh=(await conversionRows(client,365,row.org_id))[0];
      const checked=fresh&&followupDecision(fresh,now);
      if(checked?.status==='eligible'&&checked.rule===decision.rule){
        reservation=(await client.query(`INSERT INTO conversion_messages(org_id,user_id,rule) VALUES($1,$2,$3)
          ON CONFLICT(org_id,rule) DO NOTHING RETURNING id`,[row.org_id,row.user_id,decision.rule])).rows[0];
      }
      await client.query('COMMIT');
      if(!reservation)continue;
      // Reservation is durable before any external side effect. A crash/timeout cannot send twice next run.
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(18732026)');
      const freshAgain=(await conversionRows(client,365,row.org_id))[0];
      if(freshAgain)freshAgain.messages=freshAgain.messages.filter(m=>m.rule!==decision.rule);
      const finalDecision=freshAgain&&followupDecision(freshAgain,now);
      const finalSuppression=await client.query('SELECT 1 FROM conversion_suppressions WHERE email_hash=$1',[emailHash(row.email)]);
      if(finalDecision?.status!=='eligible'||finalDecision.rule!==decision.rule||finalSuppression.rows.length){
        await client.query("UPDATE conversion_messages SET status='suppressed' WHERE id=$1",[reservation.id]);
        await client.query('COMMIT');summary.suppressed++;continue;
      }
      const origin=`https://${env.CANONICAL_HOST}`;
      const unsubscribeUrl=`${origin}/email/unsubscribe?t=${unsubscribeToken(row.user_id,env.SESSION_SECRET)}`;
      const template=followupTemplate(decision.rule,freshAgain,{origin,unsubscribeUrl});
      const response=await transport('https://api.resend.com/emails',{
        method:'POST',signal:AbortSignal.timeout(10000),
        headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`cited-conversion/${reservation.id}`},
        body:JSON.stringify({from:env.NOTIFY_FROM||'Cited <notifications@cited.ae>',to:[row.email],...template,
          headers:{'List-Unsubscribe':`<${unsubscribeUrl}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}})
      });
      if(!response.ok)throw Error('Email provider rejected request');
      const result=await response.json();
      await client.query("UPDATE conversion_messages SET status='sent',provider_id=$2,sent_at=now() WHERE id=$1",[reservation.id,result.id]);
      await client.query('COMMIT');summary.sent++;
    }catch(error){
      await client.query('ROLLBACK');
      if(reservation)await client.query("UPDATE conversion_messages SET status='uncertain' WHERE id=$1",[reservation.id]);
      summary.uncertain++;
      console.error('Conversion delivery needs review'); // No address, response body or token in logs.
    }finally{client.release();}
  }
  return summary;
}

export async function expireConversionContext(db){
  await db.query("DELETE FROM demo_journeys WHERE org_id IS NULL AND started_at<now()-interval '90 days'");
  await db.query("UPDATE demo_journeys SET setup_context='{}',demo_summary=demo_summary-'question' WHERE org_id IS NOT NULL AND started_at<now()-interval '90 days' AND (setup_context<>'{}' OR demo_summary ? 'question')");
}
