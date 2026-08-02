# CiteSpark

Answer engine visibility tracking that tells you what to do, not just where you stand. A Sandstorm Digital production.

CiteSpark asks the questions your buyers actually type into ChatGPT, Gemini and Perplexity, reads every answer, records whether you were named and in what position, captures which domains the engines cited instead, joins that to your GA4 AI Assistant traffic, and then writes a prioritised action list from the gaps it finds.

The action list is the product. The dashboard is how you check its working.

---

## Quick start (10 minutes, no API spend)

```bash
git clone <your-repo> citespark && cd citespark
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

In Render, open the web service, go to **Settings > Custom Domains**, add `citespark.sandstormdigital.com`. Render gives you a CNAME target. Add that CNAME at your DNS provider and Render issues the TLS certificate automatically, usually within a few minutes. Use a subdomain rather than the apex so you avoid ALIAS record faff.

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

Two series are pulled deliberately:

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

## Before you take payment

- Rate limit `/api/login` and `/api/register`.
- Move session storage off cookies if you start storing anything sensitive.
- Add per-project spend caps so a runaway cron cannot empty the DataForSEO balance.
- Google OAuth verification for GA4 scopes takes weeks. Start it before you need it.
