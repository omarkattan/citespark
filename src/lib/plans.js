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
 *   Starter   700 calls   ~$21 cost   $79   73%
 *   Growth  2,000 calls   ~$60 cost  $199   70%
 *   Agency  5,000 calls  ~$150 cost  $499   70%
 *
 * If DataForSEO or the underlying model pricing moves, change COST_PER_CALL
 * and re-read this table before touching the prices.
 */

export const COST_PER_CALL = Number(process.env.COST_PER_CALL || 0.03);

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
    monthlyCalls: 700,
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
    monthlyCalls: 2000,
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
    monthlyCalls: 5000,
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
