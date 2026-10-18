import express from 'express';
import {createConversionStore,CONSENT_VERSION} from './conversion.js';
import {conversionDashboard,conversionJourney,conversionRows} from './conversion-dashboard.js';
import {emailHash,unsubscribeUser,followupTemplate,followupDecision} from './conversion-followups.js';

export function conversionRoutes({db,requireAuth,requireAdmin,secret}) {
  const router=express.Router(),store=createConversionStore(db);
  const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  const json=(req,res,next)=>{
    if(!req.is('application/json'))return res.status(415).json({error:'Send a JSON request'});
    if(req.get('origin')&&req.get('origin')!==`${req.protocol}://${req.get('host')}`)return res.status(403).end();
    next();
  };
  router.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
  router.post('/api/conversion/pricing',json,wrap(async(req,res)=>{
    if(!['landing','billing','upgrade'].includes(req.body?.surface))return res.status(400).end();
    await store.safe(()=>store.pricing(req,req.body.surface));res.json({ok:true});
  }));
  router.get('/api/conversion/handoff',requireAuth,wrap(async(req,res)=>res.json(await store.handoff(req))));
  router.post('/api/conversion/handoff/discard',requireAuth,json,wrap(async(req,res)=>{
    await db.query("UPDATE demo_journeys SET setup_context='{}',demo_summary=demo_summary-'question' WHERE org_id=$1",[req.session.orgId]);
    res.json({ok:true});
  }));
  router.get('/api/email-preferences',requireAuth,wrap(async(req,res)=>{
    const u=await store.one('SELECT marketing_opt_in_at,email_suppressed_at FROM users WHERE id=$1',[req.session.userId]);
    res.json({optedIn:Boolean(u?.marketing_opt_in_at)&&!u?.email_suppressed_at});
  }));
  router.post('/api/email-preferences',requireAuth,json,wrap(async(req,res)=>{
    if(typeof req.body?.optedIn!=='boolean')return res.status(400).end();
    const u=await store.one('SELECT email FROM users WHERE id=$1',[req.session.userId]);
    if(req.body.optedIn){
      const suppressed=await store.one('SELECT reason FROM conversion_suppressions WHERE email_hash=$1',[emailHash(u.email)]);
      if(suppressed&&suppressed.reason!=='unsubscribe')return res.status(409).json({error:'Email delivery is suppressed. Contact support to review it.'});
      await db.query("DELETE FROM conversion_suppressions WHERE email_hash=$1 AND reason='unsubscribe'",[emailHash(u.email)]);
      await db.query('UPDATE users SET marketing_opt_in_at=now(),marketing_consent_version=$2,email_suppressed_at=NULL,email_suppression_reason=NULL WHERE id=$1',[req.session.userId,CONSENT_VERSION]);
    }else await suppress(req.session.userId,'unsubscribe');
    res.json({ok:true});
  }));
  async function suppress(id,reason){
    const u=await store.one('SELECT email FROM users WHERE id=$1',[id]);if(!u)return;
    await db.query(`INSERT INTO conversion_suppressions(email_hash,reason) VALUES($1,$2)
      ON CONFLICT(email_hash) DO UPDATE SET reason=EXCLUDED.reason`,[emailHash(u.email),reason]);
    await db.query('UPDATE users SET email_suppressed_at=now(),email_suppression_reason=$2,marketing_opt_in_at=NULL WHERE id=$1',[id,reason]);
  }
  router.get('/email/unsubscribe',wrap(async(req,res)=>{
    const id=unsubscribeUser(String(req.query.t||''),secret);
    if(!id)return res.status(400).send('Invalid unsubscribe link. You can change email preferences in Billing.');
    // GET is safe for security scanners and mail-client previews. POST performs the opt-out.
    res.set('Referrer-Policy','no-referrer');
    res.type('html').send('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Cited email preferences</title><main style="max-width:520px;margin:10vh auto;font:18px system-ui;padding:24px"><h1>Stop Cited follow-up emails?</h1><p>Your account and essential security emails stay active.</p><form method="post"><button style="font:inherit;padding:12px">Unsubscribe</button></form></main></html>');
  }));
  router.post('/email/unsubscribe',wrap(async(req,res)=>{
    const id=unsubscribeUser(String(req.query.t||''),secret);if(!id)return res.status(400).send('Invalid link');
    await suppress(id,'unsubscribe');res.type('html').send('<!doctype html><title>Unsubscribed</title><h1>You are unsubscribed</h1><p>Cited follow-up emails have been stopped.</p>');
  }));
  router.get('/api/admin/conversions',requireAdmin,wrap(async(req,res)=>{
    const days=Number(req.query.days||30);if(!Number.isInteger(days)||days<1||days>365)return res.status(400).end();
    res.json(await conversionDashboard(db,days));
  }));
  router.get('/api/admin/conversions/journey',requireAdmin,wrap(async(req,res)=>{
    const orgId=/^\d+$/.test(String(req.query.org||''))?Number(req.query.org):null;
    const journeyId=/^[0-9a-f-]{36}$/i.test(String(req.query.demo||''))?req.query.demo:null;
    if(!orgId&&!journeyId)return res.status(400).end();
    const journey=await conversionJourney(db,{orgId,journeyId});
    if(!journey)return res.status(404).end();res.json(journey);
  }));
  router.get('/api/admin/conversions/:orgId/preview',requireAdmin,wrap(async(req,res)=>{
    const row=(await conversionRows(db,365,Number(req.params.orgId))).find(r=>r.org_id===Number(req.params.orgId));
    if(!row)return res.status(404).end();
    const decision=followupDecision(row);
    if(!decision.rule)return res.json({decision,template:null});
    res.json({decision,template:followupTemplate(decision.rule,row)});
  }));
  router.post('/api/admin/conversions/:orgId/suppress',requireAdmin,json,wrap(async(req,res)=>{
    if(!['bounce','complaint','manual'].includes(req.body?.reason))return res.status(400).end();
    const users=await store.many('SELECT id FROM users WHERE org_id=$1',[Number(req.params.orgId)]);
    for(const u of users)await suppress(u.id,req.body.reason);
    res.json({ok:true});
  }));
  return router;
}
