import 'dotenv/config';
import { one, many, query } from '../db/index.js';
import { PLANS, planFor, stripePriceId, COST_PER_CALL } from './plans.js';

/**
 * Billing.
 *
 * Stripe is optional. With no keys set, every org sits on the free plan and
 * the product works end to end, which keeps local development and the demo
 * environment simple. Once STRIPE_SECRET_KEY is present the checkout and
 * portal routes light up.
 *
 * The source of truth for what an org may do is this database, not Stripe.
 * Webhooks write into it. Every limit check reads from it. That way a Stripe
 * outage degrades to "nobody can change plan" rather than "nobody can work".
 */

export const stripeEnabled = Boolean(process.env.STRIPE_SECRET_KEY);

let stripe = null;
export async function getStripe() {
  if (!stripeEnabled) return null;
  if (stripe) return stripe;
  const { default: Stripe } = await import('stripe');
  // No apiVersion pin: use whatever the account is configured for, so this
  // keeps working as Stripe moves versions forward.
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Current subscription for an org, creating a free row the first time. */
export async function getSubscription(orgId) {
  let sub = await one('SELECT * FROM subscriptions WHERE org_id = $1', [orgId]);
  if (!sub) {
    sub = await one(
      'INSERT INTO subscriptions (org_id) VALUES ($1) ON CONFLICT (org_id) DO UPDATE SET updated_at = now() RETURNING *',
      [orgId]
    );
  }
  // A subscription that has lapsed drops to free rather than locking anyone out.
  const active = ['active', 'trialing', 'past_due'].includes(sub.status);
  return { ...sub, effectivePlan: active ? sub.plan : 'free' };
}

export async function getUsage(orgId) {
  const row = await one('SELECT * FROM usage_monthly WHERE org_id = $1 AND month = $2', [orgId, monthKey()]);
  return { calls: row?.calls || 0, spend: Number(row?.spend_usd || 0), month: monthKey() };
}

export async function recordUsage(orgId, calls, spendUsd) {
  await query(
    `INSERT INTO usage_monthly (org_id, month, calls, spend_usd)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, month) DO UPDATE
       SET calls = usage_monthly.calls + EXCLUDED.calls,
           spend_usd = usage_monthly.spend_usd + EXCLUDED.spend_usd`,
    [orgId, monthKey(), calls, spendUsd]
  );
}

/** Everything the UI and the enforcement checks need, in one read. */
export async function getEntitlements(orgId) {
  const sub = await getSubscription(orgId);
  const plan = planFor(sub.effectivePlan);
  const usage = await getUsage(orgId);
  const counts = await one(
    `SELECT
       (SELECT COUNT(*)::int FROM projects WHERE org_id = $1) AS sites,
       (SELECT COUNT(*)::int FROM prompts p JOIN projects pr ON pr.id = p.project_id
         WHERE pr.org_id = $1 AND p.active) AS questions`,
    [orgId]
  );

  const remaining = Math.max(0, plan.monthlyCalls - usage.calls);
  return {
    plan,
    status: sub.status,
    interval: sub.interval,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    currentPeriodEnd: sub.current_period_end,
    hasStripeCustomer: Boolean(sub.stripe_customer_id),
    usage: {
      calls: usage.calls,
      remaining,
      limit: plan.monthlyCalls,
      spend: usage.spend,
      percent: plan.monthlyCalls ? Math.min(100, Math.round((usage.calls / plan.monthlyCalls) * 100)) : 0
    },
    counts: { sites: counts.sites, questions: counts.questions }
  };
}

/**
 * Limit checks. Each returns null when allowed, or a message written for the
 * person hitting the limit rather than for a log file.
 */
/** "1 site" not "1 sites". Small thing, but it is the first sentence a
 *  customer reads at the exact moment we are asking them for money. */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export async function checkCanAddSite(orgId) {
  const e = await getEntitlements(orgId);
  if (e.counts.sites >= e.plan.sites) {
    return e.plan.sites === 1
      ? `The ${e.plan.name} plan covers one site, and you are already tracking it. Upgrade to add another, or delete the current one from its Setup tab.`
      : `The ${e.plan.name} plan covers ${plural(e.plan.sites, 'site')} and you are using all of them. Upgrade to add more, or remove one first.`;
  }
  return null;
}

export async function checkCanAddQuestions(orgId, projectId, adding = 1) {
  const e = await getEntitlements(orgId);
  const row = await one(
    'SELECT COUNT(*)::int AS n FROM prompts WHERE project_id = $1 AND active',
    [projectId]
  );
  if (row.n + adding > e.plan.questions) {
    return `The ${e.plan.name} plan allows ${plural(e.plan.questions, 'active question')} per site. Pause or delete one, or upgrade for more.`;
  }
  return null;
}

/** Called before a cycle. Returns the shape the cycle is allowed to run at. */
export async function budgetForCycle(orgId, { questions, engines, runs }) {
  const e = await getEntitlements(orgId);
  const allowedEngines = engines.slice(0, e.plan.engines);
  const allowedRuns = Math.min(runs, e.plan.runs);
  const wanted = questions * allowedEngines.length * allowedRuns;

  if (e.usage.remaining <= 0) {
    return {
      ok: false,
      reason: `You have used all ${e.plan.monthlyCalls} answer checks on the ${e.plan.name} plan this month. The allowance resets on the 1st, or you can upgrade now.`,
      entitlements: e
    };
  }

  // Rather than refusing outright, run what the remaining budget covers and
  // say so. A partial cycle is more useful than none.
  const trimmed = wanted > e.usage.remaining;
  return {
    ok: true,
    trimmed,
    engines: allowedEngines,
    runs: allowedRuns,
    maxCalls: Math.min(wanted, e.usage.remaining),
    estimateUsd: Math.round(Math.min(wanted, e.usage.remaining) * COST_PER_CALL * 100) / 100,
    entitlements: e
  };
}

/* ---------------- Stripe ---------------- */

/** True when Stripe says the object belongs to the other mode, or is gone. */
function isMissingObject(err) {
  const msg = String(err?.message || '');
  return (
    err?.code === 'resource_missing' ||
    /No such customer|No such subscription|similar object exists in (test|live) mode/i.test(msg)
  );
}

async function createCustomer(orgId, email) {
  const s = await getStripe();
  const customer = await s.customers.create({ email, metadata: { org_id: String(orgId) } });
  await query(
    `UPDATE subscriptions SET stripe_customer_id = $2, stripe_subscription_id = NULL, updated_at = now()
     WHERE org_id = $1`,
    [orgId, customer.id]
  );
  return customer.id;
}

/**
 * Stored customer IDs are mode-specific. Switching between test and live keys,
 * or restoring a backup, leaves an ID pointing at a customer the current key
 * cannot see. Rather than dead-ending, verify it and mint a new one if needed.
 */
export async function ensureCustomer(orgId, email) {
  const s = await getStripe();
  if (!s) return null;
  const sub = await getSubscription(orgId);
  if (!sub.stripe_customer_id) return createCustomer(orgId, email);

  try {
    const existing = await s.customers.retrieve(sub.stripe_customer_id);
    if (existing && !existing.deleted) return sub.stripe_customer_id;
  } catch (err) {
    if (!isMissingObject(err)) throw err;
    console.warn(`Stripe customer ${sub.stripe_customer_id} not visible to this key, creating a new one for org ${orgId}`);
  }
  return createCustomer(orgId, email);
}

export async function createCheckoutSession({ orgId, email, planId, interval, origin }) {
  const s = await getStripe();
  if (!s) throw new Error('Billing is not configured on this deployment');

  const priceId = stripePriceId(planId, interval);
  if (!priceId) throw new Error(`No Stripe price configured for ${planId} ${interval}ly`);

  const customerId = await ensureCustomer(orgId, email);
  return s.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${origin}/app?checkout=done`,
    cancel_url: `${origin}/app?checkout=cancelled`,
    subscription_data: { metadata: { org_id: String(orgId), plan: planId } },
    metadata: { org_id: String(orgId), plan: planId }
  });
}

export async function createPortalSession({ orgId, origin }) {
  const s = await getStripe();
  if (!s) throw new Error('Billing is not configured on this deployment');
  const sub = await getSubscription(orgId);
  if (!sub.stripe_customer_id) throw new Error('No billing account yet. Choose a plan first.');

  try {
    return await s.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${origin}/app`
    });
  } catch (err) {
    if (!isMissingObject(err)) throw err;
    // The stored customer belongs to the other Stripe mode. Clear it and drop
    // to free, so the account can start again cleanly rather than being stuck.
    await query(
      `UPDATE subscriptions SET plan = 'free', status = 'active',
         stripe_customer_id = NULL, stripe_subscription_id = NULL,
         current_period_end = NULL, cancel_at_period_end = false, updated_at = now()
       WHERE org_id = $1`,
      [orgId]
    );
    throw new Error('That billing account is no longer valid, so it has been reset. Choose a plan to start again.');
  }
}

/** Map a Stripe price back to one of our plans. */
function planFromPrice(priceId) {
  for (const id of Object.keys(PLANS)) {
    if (stripePriceId(id, 'month') === priceId) return { plan: id, interval: 'month' };
    if (stripePriceId(id, 'year') === priceId) return { plan: id, interval: 'year' };
  }
  return null;
}

/**
 * current_period_end moved from the subscription object down onto the
 * subscription items in Stripe's 2025 API versions. Read whichever is
 * present so the renewal date is right on old and new accounts alike.
 */
function periodEnd(subscription) {
  return (
    subscription.current_period_end ||
    subscription.items?.data?.[0]?.current_period_end ||
    subscription.billing_cycle_anchor ||
    Math.floor(Date.now() / 1000)
  );
}

async function applySubscription(subscription) {
  const orgId = Number(subscription.metadata?.org_id);
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const mapped = planFromPrice(priceId);

  const target = orgId
    ? await one('SELECT org_id FROM subscriptions WHERE org_id = $1', [orgId])
    : await one('SELECT org_id FROM subscriptions WHERE stripe_customer_id = $1', [customerId]);

  if (!target) {
    console.warn('Stripe event for an unknown org', { orgId, customerId });
    return;
  }

  const cancelled = ['canceled', 'incomplete_expired', 'unpaid'].includes(subscription.status);
  await query(
    `UPDATE subscriptions SET
       plan = $2, status = $3, interval = $4,
       stripe_subscription_id = $5, stripe_customer_id = COALESCE(stripe_customer_id, $6),
       current_period_end = to_timestamp($7),
       cancel_at_period_end = $8,
       updated_at = now()
     WHERE org_id = $1`,
    [
      target.org_id,
      cancelled ? 'free' : mapped?.plan || 'free',
      subscription.status,
      mapped?.interval || 'month',
      subscription.id,
      customerId,
      periodEnd(subscription),
      Boolean(subscription.cancel_at_period_end)
    ]
  );
}

/** Idempotent webhook handling. Stripe retries, so events are deduped by ID. */
export async function handleWebhook(event) {
  const seen = await one('SELECT id FROM billing_events WHERE id = $1', [event.id]);
  if (seen) return { duplicate: true };
  await query('INSERT INTO billing_events (id, type) VALUES ($1,$2) ON CONFLICT DO NOTHING', [event.id, event.type]);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.subscription) {
        const s = await getStripe();
        const subscription = await s.subscriptions.retrieve(session.subscription);
        subscription.metadata = { ...subscription.metadata, org_id: session.metadata?.org_id };
        await applySubscription(subscription);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(event.data.object);
      break;
    default:
      break;
  }
  return { handled: true };
}
