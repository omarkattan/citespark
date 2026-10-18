import {createHmac,timingSafeEqual} from 'node:crypto';
import {emailHash} from './conversion-followups.js';

export function verifyEmailWebhook(body,headers,secret,now=Date.now()) {
  if(!secret?.startsWith('whsec_')||!Buffer.isBuffer(body))throw Error('Invalid webhook');
  const timestamp=String(headers['svix-timestamp']||''),id=String(headers['svix-id']||'');
  if(!/^\d+$/.test(timestamp)||Math.abs(now/1000-Number(timestamp))>300||!id||id.length>200)throw Error('Invalid webhook');
  const expected=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${timestamp}.`).update(body).digest();
  const valid=String(headers['svix-signature']||'').split(' ').some(item=>{
    const [version,value]=item.split(',');if(version!=='v1'||!value)return false;
    const actual=Buffer.from(value,'base64');return actual.length===expected.length&&timingSafeEqual(actual,expected);
  });
  if(!valid)throw Error('Invalid webhook');
  return JSON.parse(body.toString('utf8'));
}

export async function suppressDelivery(event,db){
  if(!['email.bounced','email.complained'].includes(event.type))return;
  const id=event.data?.email_id;if(typeof id!=='string')return;
  const recipients=(Array.isArray(event.data?.to)?event.data.to:[]).filter(v=>typeof v==='string'&&v.length<=254).map(v=>v.toLowerCase().trim());
  // The authenticated delivery event may arrive before the send response is saved. Match its exact
  // recipient against an existing account as well, never against a researched company contact.
  const rows=(await db.query(`SELECT id,email FROM users WHERE lower(email)=ANY($2::text[])
    OR id IN(SELECT user_id FROM conversion_messages WHERE provider_id=$1)`,[id,recipients])).rows;
  const reason=event.type==='email.complained'?'complaint':'bounce';
  for(const row of rows){
    await db.query(`INSERT INTO conversion_suppressions(email_hash,reason) VALUES($1,$2)
      ON CONFLICT(email_hash) DO UPDATE SET reason=EXCLUDED.reason`,[emailHash(row.email),reason]);
    await db.query('UPDATE users SET email_suppressed_at=now(),email_suppression_reason=$2,marketing_opt_in_at=NULL WHERE id=$1',[row.id,reason]);
  }
}
