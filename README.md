# Cited

Answer engine visibility tracking that tells you what to do, not just where you stand.

Live at **https://cited.ae**. A Sandstorm Digital production.

Cited asks the questions your buyers actually type into ChatGPT, Gemini and Perplexity, reads every answer, records whether you were named and in what position, captures which domains the engines cited instead, joins that to your GA4 AI Assistant traffic, and then writes a prioritised action list from the gaps it finds.

The action list is the product. The dashboard is how you check its working.

---

## Quick start (10 minutes, no API spend)

```bash
git clone <your-repo> cited && cd cited
npm install
cp .env.example .env      # set DATABASE_URL and SESSION_SECRET, leave MOCK_MODE=true
npm run migrate
npm run seed              # creates the login and the sandstormdigital.com project
npm run cycle             # simulated answers, zero spend
npm run dev               # http://localhost:3000
```

Sign in with the credentials `npm run seed` prints. You will see visibility scores, the run strip, share of voice, cited sources and a full recommendation list, all built from simulated answers. This exists so you can judge the product before spending anything.

To switch to live data, set `MOCK_MODE=false` and add your DataForSEO credentials.

---

## Deploying to Render

1. Push this repo to GitHub.
2. In Render: **New > Blueprint**, select the repo. `render.yaml` provisions a web service, a Postgres database, and a weekly cron job.
3. Set the secret env vars on the web service (`DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, `ANTHROPIC_API_KEY`, and the Google ones when you get to GA4).
4. Open a Render shell on the web service and run `npm run seed` once.
5. Flip `MOCK_MODE` to `false` when you are ready to spend.

### Connecting a subdomain

Live at **https://cited.ae**.

In Render, open the web service, go to **Settings > Custom Domains**, and add both `cited.ae` and `www.cited.ae`. Render gives you a target for each. The apex needs an ALIAS or ANAME record if your DNS provider supports one, or an A record to the address Render gives you; `www` takes a plain CNAME. Render issues the TLS certificate automatically once the records resolve.

Set one as canonical and redirect the other, otherwise both versions get indexed. `www` to apex is the usual choice, and the canonical tag in `landing.html` already points at the apex.

---

## How the measurement works

**Non-determinism is handled, not hidden.** The same question asked twice gives different answers, so every prompt runs `runs_per_cycle` times per engine and visibility is reported as a percentage of answers, never a binary rank. The run strip on the Questions tab shows each individual run as a tick so the variance is visible.

**Fewer prompts run more times beats more prompts run once.** 25 prompts at 5 runs is a more trustworthy number than 125 at 1, for the same money.

**Pin your models.** Set `MODEL_*` in the env so week-on-week comparisons are like for like. An unpinned model family silently changes underneath you and looks like a ranking movement.

---

## The recommendations engine

`src/lib/recommend.js`. Ten rules, each fired by measured evidence, each producing a named action with `priority = impact / effort`.

| Rule | Fires when | Action |
|---|---|---|
| `content_gap` | zero mentions on a question with volume | write or rewrite a page that answers it directly |
| `citable_asset` | named in answers but your domain never cited | add a quotable fact, table or methodology |
| `entity_authority` | cited as a source but the brand does not survive into the answer | Organization schema, sameAs, consistent naming |
| `ordinal_push` | named but averaging third or later | earn corroborating references |
| `competitor_comparison` | a rival leads you by 40+ points | build an honest comparison page |
| `source_gap` | a domain shapes several answers and you are absent | claim the profile or earn the mention |
| `engine_gap` | strong on one engine, invisible on another | engine-specific crawler and freshness fixes |
| `sentiment_correction` | an answer characterises you badly | fix it at the source |
| `decline_alert` | visibility dropped 20+ points since last cycle | investigate the change |
| `replicate_winner` | a page converts AI traffic above average | copy its structure onto the gap pages |

Add rules by appending to the array in `buildRecommendations`. Each recommendation carries a stable `fingerprint`, so re-running a cycle updates the evidence without wiping the status a human set.

---

## GA4

Connected per project through OAuth, so an agency can attach a different Google account to each client. Refresh tokens are encrypted at rest with AES-256-GCM using `TOKEN_KEY`.

### Setting up the Google OAuth client

1. Google Cloud Console, create or pick a project, and enable both the **Google Analytics Data API** and the **Google Analytics Admin API**.
2. Create an OAuth client of type **Web application**.
3. Add `https://cited.ae/api/ga4/callback` as an authorised redirect URI, plus `http://localhost:3000/api/ga4/callback` for local work.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. On the OAuth consent screen, add the scope `.../auth/analytics.readonly`. While the app is in Testing you must list each Google account as a test user; publishing needs Google verification, which takes weeks, so start it before you need it.

The customer then presses Connect on the Traffic tab, approves read-only access, and picks which GA4 property measures the site.

`GOOGLE_REFRESH_TOKEN` and `GA4_PROPERTY_ID` still work as a single-tenant fallback for any project without its own connection.

### Two series are pulled deliberately:

- **native** filters on `sessionMedium = 'ai-assistant'`, Google's AI Assistant channel added in May 2026. Accurate, but not retroactive: sessions processed before the rollout still sit in Referral.
- **derived** classifies `sessionSource` against our own domain map in `src/lib/ga4.js`. This works on historical data, so a new customer gets a real trend line on day one instead of one starting mid-2026. It also catches platforms Google has not yet recognised.

Some AI traffic arrives with no referrer and lands in Direct. Both series are a floor, and the UI says so. Being explicit about the gap is worth more than a confident wrong number.

---

## Cost control

**Verified against a live call, August 2026:** one ChatGPT `llm_responses` request with `web_search: true` and `max_output_tokens: 400` cost **$0.0296**. Of that, DataForSEO's own task fee was about $0.0006 and the rest was the LLM charge. The driver is not the model, it is the web search tool fee, visible as an `input_tokens` count of 8,174 for a 60-character prompt.

You cannot switch web search off. Without it there are no citations and no grounding, which is the whole product.

| Setup | Calls per cycle | Cost per month, weekly cadence |
|---|---|---|
| 20 questions x 3 engines x 5 runs | 300 | ~$39 |
| 20 x 3 x 3 | 180 | ~$23 |
| 20 x 2 x 3 | 120 | ~$16 |

Price accordingly. A £29/month tier is not viable. £59 works at three engines and three runs.

The levers, in order of effect:

- `ENGINES` - each engine multiplies everything. Three is usually enough.
- `runs_per_cycle` on the project - the accuracy dial, editable per site in the Setup tab.
- Cycle cadence - weekly in `render.yaml`. Daily costs seven times as much and should be a paid upgrade.
- `MAX_OUTPUT_TOKENS` - helps least, since output is a small share of the bill.

**Worth testing before you scale:** the LLM Scraper endpoints were priced around $0.0012 to $0.002 per page rather than three cents. If their ChatGPT output carries citations, they change the economics entirely. Cost per cycle is recorded on every run and shown on the dashboard.

## Fan-out queries

`fan_out_queries` in the response holds the searches the engine actually ran to build its answer. A real example:

> Question asked: *Which SEO agency is best for a UK ecommerce brand?*
> Engine searched: *best SEO agency for UK ecommerce brand 2024*

That second string is an ordinary Google query, which means classic SEO applies to it directly. If you do not rank for it, you are not in the candidate set the model reads from, and rewriting the page for the conversational question will not help. The `fanout_target` rule turns this into a keyword target automatically.

No competitor tool surfaces this. It is the bridge between GEO and the SEO work you already do.

## The category landscape and the UAE index

Both read DataForSEO's LLM Mentions corpus rather than asking questions live.

**Cost, measured not estimated: $0.20 per call.** That is two orders of magnitude above what the row-based pricing implied, so:

- The in-app Landscape tab makes one call per keyword, capped at two, and caches for 30 minutes.
- The public index at `/uae` is served entirely from stored snapshots. Visitors never trigger a call.
- A full index refresh is 25 sectors x 3 calls x $0.20 = about **$15**. Weekly is sensible; on every deploy is not.
- Two of those calls measure citations, the third reads the answer text so the page can tell "named in the answer" from "cited as a source". They are different findings and conflating them overstates the result.

### What the API actually returns

`target` must be an array of objects, each with exactly one of `keyword` or `domain`:

```json
{ "platform": "google", "location_name": "United Arab Emirates",
  "language_code": "en", "target": [{ "keyword": "banks uae" }] }
```

`top_mentioned_brands` returns nothing: `brand_entities_title` is empty in the corpus. The brand ranking therefore comes from `top_mentioned_domains`, where `aggregated_metrics.sources_domain` gives the domains cited most for the category. Those domains are the brands, with platforms such as YouTube and Wikipedia filtered out of the ranking but kept in the full source list.

If the shape changes again, `npm run probe` tries a dozen request variations and reports which return rows. That is how the shape above was found.

## Reading a customer's site

The scan escalates only as far as it needs to:

1. **A polite identified request** as `CitedBot`, which most sites allow.
2. **The same request with normal browser headers**, for sites that reject anything self-identifying as a bot.
3. **DataForSEO's OnPage `instant_pages` endpoint**, which renders JavaScript and comes from addresses sites do not block. No extra vendor, since you already have the credentials, and it costs a fraction of a cent per page.
4. **A headless browser**, only if `BROWSERLESS_URL` is set. Rarely needed after step three.

If all four fail, the scan returns `manual: true` and the interface tells the person to fill the fields in by hand. Everything downstream works identically; the scan is a convenience, not a dependency.

The route taken is returned as `via`, and shown in the interface when it was not the direct one, so a customer understands why a scan took longer.

## Model names

`model_name` is **required** on every LLM Responses call. DataForSEO reports a missing required field as `Invalid Field: 'model_name'`, which reads like the field is not allowed. It is, and omitting it fails every LLM engine at once.

Rather than hard-coding names that go stale, the client asks DataForSEO which models exist, using their free per-engine models endpoint, and caches the answer for six hours. Selection prefers, in order: web search supported (no web search means no citations, which is the whole product), non-reasoning (cheaper, no better here), a stable alias over a dated snapshot, and a cheap tier such as mini, flash, haiku or sonar.

To see what is available and what would be chosen:

```bash
npm run models
```

Free to run, and the fastest way to diagnose a model failure. To pin one yourself, set `MODEL_CHATGPT`, `MODEL_GEMINI`, `MODEL_CLAUDE` or `MODEL_PERPLEXITY`; an explicit value always wins over the resolver. Only do that if you have a reason, since a pinned name will eventually be retired.

## Verify the response parser once

`src/lib/dataforseo.js` walks the response tree rather than hard-coding a path, because DataForSEO's payload shape moves. On your first live run, log one raw payload and confirm the text and citation extraction is catching everything:

```js
console.log(JSON.stringify(json, null, 2));
```

Tighten `collectText` and `collectUrls` to the real paths once you have seen them.

---

## Layout

```
src/
  db/schema.sql      tables
  lib/dataforseo.js  engine calls, defensive parsing, mock mode
  lib/prompts.js     prompt set generation
  lib/analyze.js     mention detection, ordinal, sentiment
  lib/recommend.js   the rules engine
  lib/ga4.js         native + derived traffic classification
  jobs/runCycle.js   the scheduled measurement run
  server.js          auth, API, dashboard
  public/            dashboard, login, styles
scripts/
  migrate.js
  seed.js            edit CONFIG here to point at another domain
```

## Billing

Plans live in `src/lib/plans.js`, which is the single source of truth. Limits are derived from one measured number: an engine call with web search costs about `COST_PER_CALL`, currently $0.03.

| Plan | Price | Sites | Questions | Engines | Runs | Checks/mo | Cost at full use | Margin |
|---|---|---|---|---|---|---|---|---|
| Free | $0 | 1 | 10 | 1 | 1 | 40 | $1.20 | - |
| Starter | $79 | 1 | 25 | 2 | 3 | 700 | $21 | 73% |
| Growth | $199 | 3 | 40 | 3 | 3 | 2,000 | $60 | 70% |
| Agency | $499 | 10 | 60 | 4 | 5 | 5,000 | $150 | 70% |

Annual is priced at ten months, so two months free. There is a test asserting every paid plan clears a 60% gross margin at full usage, which will fail loudly if you change a price without checking the maths.

### Stripe setup

Stripe is optional. With no keys set every org sits on Free and the product works end to end, which keeps local development simple.

1. In Stripe, create a product per paid plan with a monthly price and a yearly price.
2. Set these env vars on the web service:

```
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_STARTER_ANNUAL=price_...
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_GROWTH_ANNUAL=price_...
STRIPE_PRICE_AGENCY=price_...
STRIPE_PRICE_AGENCY_ANNUAL=price_...
```

3. Add a webhook endpoint pointing at `https://cited.ae/api/stripe/webhook`, subscribed to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Enable the Customer Portal in Stripe settings, which is what the Manage billing button opens.

Test locally with `stripe listen --forward-to localhost:3000/api/stripe/webhook`, and card `4242 4242 4242 4242`.

### Reconciling estimates against reality

The estimate on the Setup tab uses per-surface costs measured from this account's own runs, falling back to deliberate ceilings until a surface has run at least three times. Ceilings run high on purpose, because DataForSEO takes a prepayment per LLM task and refunds the unused part, so a new account's first cycles come in well under the quote.

To check the accounting against your actual prepaid balance:

```sql
SELECT cycle_date, engine, COUNT(*) AS calls,
       ROUND(SUM(cost_usd)::numeric, 4) AS recorded,
       ROUND(AVG(cost_usd)::numeric, 5) AS avg_each
FROM runs
WHERE cycle_date = CURRENT_DATE
GROUP BY 1, 2
ORDER BY recorded DESC;
```

Compare the recorded total with the drop in your DataForSEO balance. If they agree, only the forward estimate was high and it will converge on its own. If they disagree, the recording is wrong and the plan spend caps are running off a bad number, which needs fixing before it reaches customers.

Once you have a few hundred real runs, set `WORST_CASE_CALL` in `plans.js` from the highest observed `avg_each` rather than the current $0.03. If ChatGPT really settles near $0.011, every allowance can roughly double at the same margin.

### How enforcement works

The database is the source of truth for what an org may do, not Stripe. Webhooks write into `subscriptions`; every limit check reads from it. A Stripe outage therefore degrades to "nobody can change plan" rather than "nobody can work".

- Adding a site or a question returns HTTP 402 with a message written for the person, and the interface links to the Plan tab.
- A cycle clamps engines and runs down to the plan before it starts, so a downgrade takes effect immediately.
- If the remaining monthly allowance is smaller than the cycle, the cycle **trims itself to fit** and says so, rather than refusing or overspending.
- When the allowance is gone, cycles stop until the 1st. Usage is recorded in `usage_monthly` per calendar month.

Webhook handling is idempotent via the `billing_events` table, because Stripe retries.

## Before you take payment

- Rate limit `/api/login` and `/api/register`.
- Move session storage off cookies if you start storing anything sensitive.
- Add per-project spend caps so a runaway cron cannot empty the DataForSEO balance.
- Google OAuth verification for GA4 scopes takes weeks. Start it before you need it.
