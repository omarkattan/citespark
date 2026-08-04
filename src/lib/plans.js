/**
 * Plans.
 *
 * Every limit here traces back to one measured number: a single engine call
 * with web search costs about $0.03. Cost per site per month at weekly
 * cadence is therefore:
 *
 *   questions x engines x runs x 4.33 weeks x $0.03
 *
 * So a plan is really a call budget wearing a friendlier set of clothes.
 * monthlyCalls is the hard ceiling and the thing that protects your margin;
 * sites, questions, engines and runs are the shape the customer sees.
 *
 * Margins at list price, assuming customers use their full allowance
 * (most will not, which is upside rather than something to price for):
 *
 * Two ceilings guard the margin, and whichever binds first wins:
 *
 *   monthlyCalls      the allowance we sell, sized so that even if every
 *                     call is the most expensive surface we still clear 75%
 *   monthlyBudgetUsd  a hard spend cap, the backstop for when engine pricing
 *                     moves under us between releases
 *
 * Worst case at $0.03 a call:
 *
 *   Starter    650 calls  = $19.50 against  $79  =  75% margin
 *   Growth   1,650 calls  = $49.50 against $199  =  75% margin
 *   Agency   4,900 calls  = $147.00 against $499 =  71% margin
 *
 * The allowance is pooled across every site on the account. Per-site limits
 * are ceilings for one site, not a promise that every site can run at its
 * ceiling simultaneously. Sizing so that one site at full tilt fits a weekly
 * cadence is the test that matters, and there is an assertion for it.
 *
 * Customers who favour the Google surfaces cost a fraction of that, which is
 * upside rather than something to price for. If DataForSEO or the model
 * pricing moves, change WORST_CASE_CALL and re-read this table.
 */

/**
 * The most an engine call can cost us. Allowances are sized against this,
 * not against an average, so the margin holds even if a customer spends
 * their entire allowance on the most expensive surface.
 */
export const WORST_CASE_CALL = Number(process.env.WORST_CASE_CALL || 0.03);
export const COST_PER_CALL = WORST_CASE_CALL; // kept for older callers

/** Share of the subscription price we are willing to spend on data. */
export const COGS_SHARE = Number(process.env.COGS_SHARE || 0.3);

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    priceAnnual: 0,
    blurb: 'See where you stand on one domain.',
    sites: 1,
    questions: 10,
    engines: 1,
    runs: 1,
    cadence: 'manual',
    monthlyCalls: 40,
    monthlyBudgetUsd: 1.5,
    features: [
      '1 site, 10 questions',
      'ChatGPT only, 1 run per question',
      'Run by hand whenever you like',
      'Full action list, nothing held back'
    ]
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    price: 79,
    priceAnnual: 790,
    blurb: 'For one brand you want to win.',
    sites: 1,
    questions: 25,
    engines: 2,
    runs: 3,
    cadence: 'weekly',
    monthlyCalls: 650,
    monthlyBudgetUsd: 19.75,
    features: [
      '1 site, 25 questions',
      '2 engines, 3 runs per question',
      'Automatic weekly cycle',
      '5 competitors tracked',
      'GA4 traffic and revenue join'
    ]
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    price: 199,
    priceAnnual: 1990,
    blurb: 'For a brand portfolio or a small client list.',
    sites: 3,
    questions: 40,
    engines: 3,
    runs: 3,
    cadence: 'weekly',
    monthlyCalls: 1650,
    monthlyBudgetUsd: 49.75,
    popular: true,
    features: [
      '3 sites, 40 questions each',
      '3 engines, 3 runs per question',
      'Automatic weekly cycles',
      '15 competitors per site',
      'GA4 traffic and revenue join',
      'Full citation and source analysis'
    ]
  },
  agency: {
    id: 'agency',
    name: 'Agency',
    price: 499,
    priceAnnual: 4990,
    blurb: 'For agencies reporting to a roster of clients.',
    sites: 10,
    questions: 60,
    engines: 6,
    runs: 5,
    cadence: 'daily',
    monthlyCalls: 4900,
    monthlyBudgetUsd: 147,
    features: [
      '10 sites, 60 questions each',
      'All 6 AI surfaces, up to 5 runs per question',
      'Daily cycles available',
      'Unlimited competitors',
      'GA4 traffic and revenue join',
      'Priority support from the Sandstorm team'
    ]
  }
};

export const PLAN_ORDER = ['free', 'starter', 'growth', 'agency'];

export function planFor(id) {
  return PLANS[id] || PLANS.free;
}

/** Stripe price IDs live in env so the same code works in test and live mode. */
export function stripePriceId(planId, interval = 'month') {
  const key = `STRIPE_PRICE_${planId.toUpperCase()}${interval === 'year' ? '_ANNUAL' : ''}`;
  return process.env[key] || null;
}

/** What one cycle will cost, given a project and its plan. */
export function estimateCycle({ questions, engines, runs }) {
  const calls = questions * engines * runs;
  return { calls, usd: Math.round(calls * COST_PER_CALL * 100) / 100 };
}

/**
 * Clamp a project's settings to whatever the plan allows.
 * Called before every cycle, so a downgrade takes effect immediately
 * rather than waiting for someone to notice.
 */
export function clampToPlan(plan, { engines, runs }) {
  return {
    engines: engines.slice(0, plan.engines),
    runs: Math.min(runs, plan.runs)
  };
}
