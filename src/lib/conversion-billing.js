import {createConversionStore} from './conversion.js';
const id=value=>typeof value==='string'?value:value?.id||null;
export const invoiceSubscription=invoice=>id(invoice.subscription)||id(invoice.parent?.subscription_details?.subscription);

// Called only after the Stripe signature is verified, inside the billing transaction.
export async function recordBillingConversion(event,{db,stripe}) {
  const store=createConversionStore(db),object=event.data.object;
  const byCustomer=customer=>store.one('SELECT org_id FROM subscriptions WHERE stripe_customer_id=$1',[id(customer)]);
  if(event.type==='invoice.payment_succeeded'){
    let invoice=await stripe.invoices.retrieve(object.id);
    if(invoice.parent?.subscription_details&&!invoice.payments)invoice=await stripe.invoices.retrieve(object.id,{expand:['payments']});
    const subscription=invoiceSubscription(invoice);
    // A free invoice, trial, manually marked invoice or checkout redirect is not cash received.
    if(!subscription||invoice.status!=='paid'||invoice.paid_out_of_band||!Number.isSafeInteger(invoice.amount_paid)||invoice.amount_paid<=0)return {};
    const target=await byCustomer(invoice.customer);if(!target)return {};
    const intents=[...new Set([id(invoice.payment_intent),...(invoice.payments?.data||[]).filter(p=>p.status==='paid').map(p=>id(p.payment?.payment_intent))].filter(Boolean))];
    if(invoice.payments?.has_more)throw Error('Invoice payment pagination requires reconciliation');
    let charge=id(invoice.charge);
    if(!charge&&intents.length===1)charge=id((await stripe.paymentIntents.retrieve(intents[0])).latest_charge);
    const paidAt=new Date((invoice.status_transitions?.paid_at||event.created)*1000).toISOString();
    const receipt=await store.one(`INSERT INTO conversion_payments(invoice_id,org_id,subscription_id,payment_intent_ids,charge_id,currency,amount_paid,billing_reason,paid_at,livemode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(invoice_id) DO NOTHING RETURNING *`,
    [invoice.id,target.org_id,subscription,intents,charge,invoice.currency,invoice.amount_paid,invoice.billing_reason||'unknown',paidAt,event.livemode===true]);
    if(receipt){
      await store.event({name:'payment_completed',orgId:target.org_id,key:`payment:${invoice.id}`,at:paidAt,
        detail:{invoiceId:invoice.id,currency:invoice.currency,amountMinor:invoice.amount_paid,billingReason:invoice.billing_reason,livemode:event.livemode===true}});
      return {receipt};
    }
  }else if(['refund.created','refund.updated','refund.failed'].includes(event.type)){
    const refund=await stripe.refunds.retrieve(object.id);
    const charge=refund.charge?await stripe.charges.retrieve(id(refund.charge)):null;
    const target=charge&&await byCustomer(charge.customer);if(!target)return {};
    await store.one(`INSERT INTO conversion_refunds(refund_id,org_id,payment_intent_id,charge_id,currency,amount,status,livemode,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9)) ON CONFLICT(refund_id) DO UPDATE
      SET status=EXCLUDED.status,amount=EXCLUDED.amount RETURNING refund_id`,
    [refund.id,target.org_id,id(refund.payment_intent),id(refund.charge),refund.currency,refund.amount,refund.status,event.livemode===true,refund.created]);
    await store.event({name:'refund_updated',orgId:target.org_id,key:`refund-event:${event.id}`,at:new Date(event.created*1000).toISOString(),
      detail:{refundId:refund.id,status:refund.status,amountMinor:refund.amount,currency:refund.currency}});
  }else if(['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired'].includes(event.type)){
    const target=await byCustomer(object.customer);if(!target)return {};
    const name=event.type==='checkout.session.expired'?'checkout_expired':'checkout_completed';
    await store.event({name,orgId:target.org_id,key:`${name}:${object.id}`,detail:{paymentStatus:object.payment_status},at:new Date(event.created*1000).toISOString()});
  }else if(event.type==='invoice.payment_failed'){
    const target=await byCustomer(object.customer);if(target)await store.event({name:'payment_failed',orgId:target.org_id,key:`payment-failed:${event.id}`,at:new Date(event.created*1000).toISOString()});
  }
  return {};
}

export async function transactionalWebhook(event,{pool,stripe,applySubscription}) {
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    // Low-volume billing only. Serializes duplicate deliveries, subscription state and refund corrections.
    await db.query("SELECT pg_advisory_xact_lock(18732026)");
    const seen=await db.query('SELECT id FROM billing_events WHERE id=$1',[event.id]);
    if(seen.rows.length){await db.query('COMMIT');return {duplicate:true};}
    const object=event.data.object;
    if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)){
      // Retrieve current state to avoid an older webhook restoring an obsolete plan.
      await applySubscription(await stripe.subscriptions.retrieve(object.id),db);
    }else if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)&&object.subscription){
      await applySubscription(await stripe.subscriptions.retrieve(id(object.subscription)),db);
    }
    const result=await recordBillingConversion(event,{db,stripe});
    await db.query('INSERT INTO billing_events(id,type) VALUES($1,$2)',[event.id,event.type]);
    await db.query('COMMIT');return {handled:true,...result};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
