import { randomUUID } from 'node:crypto';

export const CONSENT_VERSION = 'conversion-help-v1';
const EVENTS = new Set(['demo_completed','signup_completed','email_verified','project_created',
  'first_report_completed','pricing_viewed','checkout_started','checkout_completed',
  'checkout_expired','payment_completed','payment_failed','subscription_changed','refund_updated']);

// Campaign labels only. Never retain full URLs, search terms, email addresses or arbitrary query strings.
export function cleanAttribution(input = {}) {
  const out = {};
  for (const key of ['source','utm_source','utm_medium','utm_campaign','utm_content']) {
    const value = input[key];
    if (typeof value === 'string' && /^[a-z][a-z0-9 _.-]{0,79}$/i.test(value) && !/\d{7}/.test(value)) out[key] = value;
  }
  return out;
}

export function captureAcquisition(req, _res, next) {
  if (!req.session?.userId && req.method === 'GET' && ['/', '/login', '/uae', '/mena'].includes(req.path)) {
    const old = req.session.acquisition;
    if (!old || Date.now() - old.at > 30 * 86400000) {
      req.session.acquisition = { at: Date.now(), data: cleanAttribution({
        ...req.query, source: req.query.from || (req.path === '/uae' ? 'uae' : req.path === '/mena' ? 'mena' : 'direct')
      }) };
    }
  }
  next();
}

export function createConversionStore(db) {
  const one = async (sql, args=[]) => (await db.query(sql, args)).rows[0] || null;
  const many = async (sql, args=[]) => (await db.query(sql, args)).rows;
  async function event({name, orgId=null, journeyId=null, key, detail={}, at=null}) {
    if (!EVENTS.has(name) || !key || (!orgId && !journeyId)) throw Error('Invalid conversion event');
    return one(`INSERT INTO conversion_events(org_id,journey_id,event_name,dedupe_key,detail,occurred_at)
      VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now())) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
    [orgId,journeyId,name,key,JSON.stringify(detail),at]);
  }
  async function milestone(req, stage, context=null) {
    if (stage === 'started') {
      if (req.session?.userId) return;
      const site = typeof context === 'object' ? context : {domain:context};
      const previous = req.session.demoJourney && await one('SELECT * FROM demo_journeys WHERE id=$1',[req.session.demoJourney]);
      if (!previous || previous.org_id || previous.domain !== site.domain || Date.now()-new Date(previous.started_at)>30*86400000) {
        req.session.demoJourney=randomUUID();
      }
      const setup = Object.fromEntries(['domain','brandName','category','qualifier','market'].map(k=>[k,String(site[k]||'').slice(0,k==='domain'?200:500)]));
      await db.query(`INSERT INTO demo_journeys(id,domain,attribution,setup_context) VALUES($1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET setup_context=EXCLUDED.setup_context`,
      [req.session.demoJourney,setup.domain,JSON.stringify(cleanAttribution(req.session.acquisition?.data||{source:req.body?.source||'landing'})),JSON.stringify(setup)]);
      return;
    }
    const id=req.session?.demoJourney;
    if(!id)return;
    if(stage==='result'){
      if(req.session.userId)return;
      const d=context||{};
      const summary={question:String(d.question||'').slice(0,500),engine:String(d.engine||'').slice(0,40),
        runs:Number.isInteger(d.runs)?d.runs:null,mentions:Number.isInteger(d.mentions)?d.mentions:null,
        status:d.status==='inconclusive'?'inconclusive':'complete',cached:Boolean(d.cached),collectedAt:d.collectedAt||null};
      const row=await one(`UPDATE demo_journeys SET result_at=COALESCE(result_at,now()),demo_summary=$2
        WHERE id=$1 AND org_id IS NULL RETURNING id`,[id,JSON.stringify(summary)]);
      if(row)await event({name:'demo_completed',journeyId:id,key:`demo:${id}`});
    }else if(stage==='signup_view'){
      await db.query('UPDATE demo_journeys SET signup_view_at=COALESCE(signup_view_at,now()) WHERE id=$1 AND org_id IS NULL',[id]);
    }else if(stage==='registered'){
      // Attribution belongs to one new account, within 30 days, and is never inferred from a domain/email match.
      const row=await one(`UPDATE demo_journeys SET registered_at=now(),org_id=$2 WHERE id=$1 AND org_id IS NULL
        AND result_at IS NOT NULL AND started_at>now()-interval '30 days'
        AND NOT EXISTS(SELECT 1 FROM demo_journeys WHERE org_id=$2) RETURNING id`,[id,req.session.orgId]);
      if(row)await db.query('UPDATE conversion_events SET journey_id=$1 WHERE dedupe_key=$2',[id,`signup:${req.session.orgId}`]);
    }
  }
  async function report(orgId, projectId, report) {
    const measured=Number(report?.executive?.totals?.measured ?? 0);
    if(measured>0)await event({name:'first_report_completed',orgId,key:`report:${orgId}`,detail:{projectId,measuredAnswers:measured}});
  }
  async function pricing(req, surface) {
    const orgId=req.session?.orgId||null,journeyId=orgId?null:req.session?.demoJourney||null;
    if(!orgId&&!journeyId)return;
    if(journeyId&&!orgId&&!await one('SELECT id FROM demo_journeys WHERE id=$1',[journeyId]))return;
    const day=new Date().toISOString().slice(0,10);
    await event({name:'pricing_viewed',orgId,journeyId,key:`pricing:${orgId?'org:'+orgId:'demo:'+journeyId}:${day}`,detail:{surface}});
  }
  async function handoff(req) {
    if(!req.session?.orgId)return null;
    const row=await one(`SELECT setup_context,demo_summary,result_at FROM demo_journeys
      WHERE org_id=$1 AND setup_context ? 'domain' AND result_at>now()-interval '30 days' ORDER BY registered_at LIMIT 1`,[req.session.orgId]);
    return row ? {site:row.setup_context,results:[row.demo_summary],savedAt:new Date(row.result_at).getTime(),serverSaved:true} : null;
  }
  async function safe(fn) {
    try{return await fn();}catch(error){console.error('Conversion recording unavailable:',/^[A-Z0-9_]{2,30}$/.test(error.code||'')?error.code:'database_error');return null;}
  }
  return {event,milestone,report,pricing,handoff,safe,one,many};
}
