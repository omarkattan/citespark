import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {PLANS} from './plans.js';

const HOUR=3600000;
export const emailHash=email=>createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
export function unsubscribeToken(userId,secret){
  if(!secret||secret==='change-me-in-env')throw Error('A secure SESSION_SECRET is required');
  const id=String(userId);
  return id+'.'+createHmac('sha256',secret).update('conversion-unsubscribe:'+id).digest('base64url');
}
export function unsubscribeUser(token,secret){
  if(!/^\d+\.[A-Za-z0-9_-]{43}$/.test(String(token||''))||!secret)return null;
  const id=String(token).split('.')[0],expected=unsubscribeToken(id,secret);
  return expected.length===token.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(token))?Number(id):null;
}

export function followupDecision(r, now=new Date()) {
  const wait=(at,h)=>at&&now-new Date(at)>=h*HOUR;
  if(!r.org_id)return {status:'anonymous',reason:'Show signup CTA. No verified, permissioned contact.'};
  if(r.internal||r.conversion_test||r.has_test_payment)return {status:'suppressed',reason:'Internal or test account'};
  if(!r.email_verified_at)return {status:'suppressed',reason:'Email not verified'};
  if(r.email_suppressed_at||r.suppressed)return {status:'suppressed',reason:'Unsubscribed or delivery suppressed'};
  let rule,at;
  if(r.paid_at){rule='customer_welcome';at=r.paid_at;if(!wait(at,1))return {status:'waiting',reason:'Customer onboarding in one hour'};}
  else {
    if(r.conversion_existing_customer || (r.plan&&r.plan!=='free'&&['active','trialing','past_due'].includes(r.subscription_status)))return {status:'suppressed',reason:'Existing subscription. No prospect emails.'};
    if(!r.marketing_opt_in_at)return {status:'suppressed',reason:'No opt-in for onboarding and upgrade emails'};
    if(r.checkout_completed_at)return {status:'suppressed',reason:'Checkout complete, awaiting confirmed payment. No recovery email.'};
    if(r.checkout_at){rule='checkout_help';at=r.checkout_at;if(!wait(at,2))return {status:'waiting',reason:'Checkout reminder after two hours'};}
    else if(r.pricing_at){rule='pricing_help';at=r.pricing_at;if(!wait(at,24))return {status:'waiting',reason:'Pricing reminder after one day'};}
    else if(r.report_at){rule='report_upgrade';at=r.report_at;if(!wait(at,24))return {status:'waiting',reason:'Report follow-up after one day'};}
    else if(r.project_at){rule='first_report';at=r.project_at;if(!wait(at,48))return {status:'waiting',reason:'First-report help after two days'};}
    else {rule='first_project';at=r.signup_at;if(!wait(at,24))return {status:'waiting',reason:'Setup help after one day'};}
  }
  const messages=r.messages||[];
  if(messages.some(m=>m.rule===rule))return {status:'suppressed',reason:'This follow-up has already been reserved or sent'};
  if(messages.some(m=>now-new Date(m.at)<72*HOUR)||messages.filter(m=>now-new Date(m.at)<7*24*HOUR).length>=2)
    return {status:'waiting',reason:'Frequency cap: at least 72 hours apart and at most two per week'};
  if(rule!=='customer_welcome'&&messages.filter(m=>m.rule!=='customer_welcome').length>=3)return {status:'suppressed',reason:'Three prospect follow-ups maximum'};
  if(rule!=='customer_welcome'&&now-new Date(r.signup_at)>30*24*HOUR)return {status:'suppressed',reason:'Onboarding sequence ended after 30 days'};
  return {status:'eligible',rule,reason:{customer_welcome:'Payment confirmed. Help the customer use the plan.',checkout_help:'Checkout started without a confirmed payment.',pricing_help:'Pricing viewed without checkout.',report_upgrade:'First report generated. Explain additional coverage.',first_report:'Project exists but no measured report has been opened.',first_project:'Account created but no project saved.'}[rule]};
}

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function followupTemplate(rule,row,{origin='https://cited.ae',unsubscribeUrl}={}) {
  const starter=PLANS.starter,free=PLANS.free;
  const templates={
    first_project:['Your next step in Cited','Add the domain you want to analyse, review your buyer questions, then run your first measurement. Your tested domain does not need to be a company you own.','Set up your project','/app'],
    first_report:['Ready for your first Cited report?','Your project is saved. Review the questions, run a measurement, then open your report to inspect the answers, citations and suggested actions. Failed or incomplete checks are shown separately.','Continue your project','/app'],
    report_upgrade:['Go beyond your first AI visibility report',`Your free plan includes ${free.questions} questions on one engine. Starter offers up to ${starter.questions} questions, ${starter.engines} engines and ${starter.monthlyCalls} answer checks a month for $${starter.price}/month, excluding applicable tax. More coverage helps you compare questions and engines. It does not guarantee better visibility.`,'Compare plans','/app?view=billing'],
    pricing_help:['Choose the coverage you need',`Start with the questions that matter to your buyers. Starter includes ${starter.questions} questions and ${starter.monthlyCalls} monthly answer checks for $${starter.price}/month, excluding applicable tax. You can keep using the free plan if its coverage is enough.`,'Review plans','/app?view=billing'],
    checkout_help:['Need help choosing your Cited plan?','You opened checkout, but we have not recorded a completed payment. Review your billing status before trying again. If your bank shows a payment, contact support so we can check it.','Review billing','/app?view=billing'],
    customer_welcome:['Your Cited payment is confirmed','Your payment is recorded. Review your plan in Billing, choose the buyer questions and engines you want to measure, and open a report after your next measurement. You control when checks run.','Open Cited','/app']
  };
  const copy=templates[rule];if(!copy)throw Error('Unknown follow-up rule');
  const sample=row.demo_summary;
  const context=sample?.question?`Your demo tested “${sample.question}” on ${sample.engine||'one engine'}. It was a limited sample, not an overall visibility score.`:'';
  const [subject,body,action,route]=copy;
  const text=[body,context,`${action}: ${origin}${route}`,unsubscribeUrl?`Stop these emails: ${unsubscribeUrl}`:'Preview only. No email will be sent.'].filter(Boolean).join('\n\n');
  const html=`<div style="font-family:system-ui;max-width:540px;margin:auto;padding:24px;color:#17221b"><p>Cited</p><h1 style="font-size:23px">${esc(subject)}</h1><p>${esc(body)}</p>${context?`<p>${esc(context)}</p>`:''}<p><a href="${esc(origin+route)}">${esc(action)}</a></p>${unsubscribeUrl?`<p><a href="${esc(unsubscribeUrl)}">Stop these emails</a></p>`:'<p>Preview only. No email will be sent.</p>'}<p>Sandstorm Digital FZ LLC, Dubai, UAE · <a href="${esc(origin)}/privacy">Privacy</a></p></div>`;
  return {subject,text,html};
}
