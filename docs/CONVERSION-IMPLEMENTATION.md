# Cited demo-to-paid implementation

Prepared 18 October 2026. Based on `omarkattan/citespark` main commit `0d6a780c9c84562056537451ae8772f0417d0a32`.

## Status

Implemented on `codex/demo-to-paid-conversion`. Not merged or deployed. No production database, Stripe configuration or live prospect email automation was changed. No customer emails were sent. Tests use isolated data and mocked payment/email providers.

## Concise audit

| Area | Existing capability | Finding and change |
| --- | --- | --- |
| Application | Express, PostgreSQL, static JS, Render | Reused. No replacement app, CRM, new hosting service or runtime dependency. |
| Public demo | Signed question tokens, rate/spend caps, cached samples, stored `demo_runs`, internal notifications | Preserved. A successful 3/3 sample remains one question on one engine, with no ownership claim. |
| Demo conversion | `demo_journeys` recorded start, result, signup-page visit and registration | Extended with campaign labels, server-held setup context, downstream events and account linkage. |
| Result page | Signup CTA below evidence | Added a prominent CTA immediately after the result and before detailed evidence, with mobile-width styling and clear free-plan limits. |
| Signup | Email/password, immediate session, hashed verification tokens, verification required before paid AI calls | Preserved. Added a separate unchecked email opt-in. Signup is still available without marketing consent. |
| Setup continuity | Local demo notes for 24 hours, project details prefilled, selected question import | Preserved and added account-based recovery. Imported questions remain unmeasured. No demo answers become project evidence. |
| Email leads | Legacy `/api/demo/lead` stores an unverified email/domain | Kept outside automation. No email-address research, ownership assumptions or anonymous-demo outreach. |
| Reports | Standard report generation, measured evidence, optional analyst work | First report event requires a generated report with measured answers. Existing reports remain available on Free. |
| Billing | Stripe Checkout, customer portal, subscriptions table, signed webhook | Existing handler recorded event IDs before processing and had no receipt/refund ledger. Replaced with transactional processing and confirmed-invoice receipts. |
| Upgrades | Paid users could open another subscription Checkout | Existing subscribers now use the customer portal to change plan. The server rejects a duplicate active paid-subscription checkout. |
| Admin | Account list, verification, usage and current plan | Extended with funnel rates, attributed receipts, sources/engines, anonymous vs identified journeys and follow-up previews. |
| Jobs | Existing daily digest and overdue-task cron | Daily digest runs conversion retention and a preview-only follow-up evaluation by default. No new cron service. |
| Analytics | First-party demo milestones, no third-party website analytics | Application database remains the source. No GA4 tag or broad third-party account permission introduced. |

Observed the live landing page and audited the current repository. Production table contents, current Stripe event subscriptions, email deliverability and the Render environment were not inspected. No live funnel conversion percentages are claimed.

The current blueprint has the measurement cron disabled while marketing plan copy describes automatic cycles. This implementation does not restart measurement jobs or promise automatic runs in new follow-up copy. Confirm the intended scheduling behaviour separately before repeating that claim.

## Priority and implementation

1. Demo → signup: visible result CTA, honest scope wording, same-browser account attribution and recoverable setup context.
2. Signup → first report: reuse verification and project setup, durable signup/project milestones, optional setup reminders and report readiness tracking.
3. Report → paid: contextual plan CTA, pricing and checkout events, customer-portal upgrades, receipt/refund accounting and checkout help.
4. Admin operations: cohort dashboard, per-account timeline, deterministic next steps, email preview and suppression controls.

No AI enrichment is performed. The sequence uses captured behaviour and plan configuration, so it adds no model charges.

## Event contract

All timestamps are server-side `TIMESTAMPTZ`. Financial events use provider event/payment time where available. Only pricing-view signals are accepted from the browser, with a fixed surface allowlist. A client cannot submit signup, payment or arbitrary account IDs as events.

| Event | Recorded when | Deduplication |
| --- | --- | --- |
| `demo_completed` | A demo result is saved for an anonymous journey, including labelled inconclusive results | One per journey |
| `signup_completed` | First user row is committed for an organisation | Database trigger, one per organisation |
| `email_verified` | Verification timestamp is saved | Database trigger, one per user |
| `project_created` | A project row is committed | Database trigger, one per project |
| `first_report_completed` | The report endpoint builds a report with `executive.totals.measured > 0` | First per organisation |
| `pricing_viewed` | Pricing becomes visible, Billing opens, or an upgrade panel opens | One per account or anonymous journey per UTC day |
| `checkout_started` | Stripe successfully creates a Checkout session | One per session |
| `checkout_completed` | Signed completion/async-success webhook | One per session |
| `checkout_expired` | Signed expiration webhook | One per session |
| `payment_completed` | Signed `invoice.payment_succeeded`, confirmed paid subscription invoice with positive amount | Invoice ID plus transactional webhook event ID |
| `payment_failed` | Signed invoice failure webhook | Provider event ID |
| `subscription_changed` | Current Stripe subscription state is synchronised | Subscription state/price/period combination |
| `refund_updated` | Signed refund event, current refund retrieved | Event ID, with refund ID as the ledger upsert key |

Signup and project events are atomic with their rows. Demo, report, pricing and Checkout analytics are fail-soft so a temporary analytics failure does not block the product. Their dedicated state/unique keys prevent ordinary refreshes from duplicating milestones. Report and pricing events retry on a later visit. A failed Checkout analytics write is logged as a generic error and may leave that stage missing, while confirmed payments still count independently. No synthetic stage is invented to fill a gap.

## Attribution and metrics

- Uses the existing signed first-party session cookie. No fingerprinting or cross-device identity matching.
- The last completed demo journey in that browser can be claimed by one newly registered account within 30 days. No domain/email matching.
- Captures source, UTM source/medium/campaign/content as short labels. Rejects obvious email addresses, full URLs, long digit sequences and arbitrary query values. No UTM search terms, full referrer URL or new IP tracking.
- Demo counts are completed browser/domain journeys, not unique people or individual AI calls. Cached results do not add another journey in the same session/domain window.
- Internal accounts, explicitly marked test accounts and accounts with Stripe test-mode receipts are excluded from production metrics.
- The selected date window identifies the acquisition cohort. Downstream milestones and receipts are followed after acquisition, so this is cohort revenue, not revenue earned only inside that calendar window.
- Signup/project/report rates include direct registrations as well as demo-linked registrations. Engine and source tables use the same cohort calculation.
- Report → paid requires payment after the first report. Demo → paid also counts customers who pay before opening a report. Missing pricing/checkout events are allowed.
- Paying customers are distinct organisations with a positive live receipt, excluding customers already paid/subscribed when the migration first ran. Refunds do not erase the historical customer count.
- Revenue is observed invoice receipts, including renewals and tax where charged, less confirmed matched refunds. Currency totals are separate. It is not MRR, recognised accounting revenue or estimated plan value.
- `billing_reason` distinguishes subscription starts, renewals and plan changes. Journey details identify the first recorded customer payment separately.
- Historical registration, project and demo timestamps are backfilled only from existing facts. Historical reports and Stripe receipts are not fabricated or automatically imported.
- Current UI shows the latest 200 journeys; aggregate counts cover the entire selected cohort. Individual known account/journey IDs remain inspectable through the admin endpoint.

## Follow-up rules

All sends remain disabled until separately approved and configured. Preview evaluation writes no delivery reservations and sends nothing.

| Stage | Earliest eligibility | Action |
| --- | --- | --- |
| Anonymous demo | Immediately in page | Signup CTA only, no email |
| Registered, no project | 24 hours | Setup help |
| Project, no generated measured report | 48 hours | Review questions, run measurement, open report |
| First report, no subscription | 24 hours | Explain additional paid coverage |
| Pricing, no Checkout | 24 hours | Plan-selection help |
| Checkout started, no confirmed payment | 2 hours | Billing review, no assumption the bank failed |
| Confirmed first recorded payment | 1 hour | Customer onboarding, prospect sequence stops |

The existing daily digest evaluates the rules once per day. Actual delivery can be up to about 24 hours after the earliest eligibility. No additional paid scheduler is introduced.

Safety rules:

- Prospect emails require explicit opt-in and verified email. Old users are not opted in by migration.
- Completed Checkout awaiting payment, active/trialing/past-due paid subscriptions, previous customers, unverified addresses, test/internal users, opt-outs, bounces and complaints suppress prospect reminders.
- Any observed live receipt permanently ends that prospect sequence, including after later refund/cancellation. Customer onboarding uses the same suppression and frequency controls.
- At least 72 hours between messages, no more than two in seven days, maximum three prospect messages, each rule once per organisation, prospect sequence ends after 30 days.
- Recheck eligibility immediately before delivery. Reserve messages durably before sending, use Resend idempotency keys, and never automatically retry an uncertain delivery.
- New email activation has an explicit signup-date cutoff to prevent a catch-up campaign to old accounts.
- Signed unsubscribe POST supports one-click mail headers. GET displays confirmation so email security scanners do not opt users out. Hash-based suppression survives account deletion.
- Authenticated Resend bounce/complaint events suppress existing recipients. Admin can stop follow-ups. No send button exists in the admin preview.

## Database migration

`npm run migrate` applies the existing schema then `src/db/conversion.sql`.

The additive migration extends `orgs`, `users`, `subscriptions` and `demo_journeys`, and creates:

- `conversion_events`
- `conversion_payments`
- `conversion_refunds`
- `conversion_messages`
- `conversion_suppressions`

It also creates signup/verification/project triggers. It does not rewrite report evidence or delete subscriptions. The legacy-customer baseline is set once and remains stable on repeated migrations.

The daily digest deletes unclaimed anonymous journeys after 90 days and removes old identified setup context and question text after 90 days. Nonidentifying sample/source fields remain for cohort reporting. Existing raw demo cache retention is unchanged. Account deletion cascades conversion events, payments and message records as part of the application's existing account-deletion model. Any longer accounting retention requirement must be met in Stripe/accounting systems before account deletion.

## Validation

Commands:

```sh
npm ci
npm run test:conversion
PGLITE_MODULE=@electric-sql/pglite node --test scripts/test-demo-*.js
MOCK_MODE=true DATABASE_URL=postgresql://test:test@localhost:1/test npm test
```

Results on 18 October 2026:

- 14 conversion tests passed, using PGlite PostgreSQL, real Express routes and DOM fixtures.
- 18 existing demo/setup/handoff regression tests passed.
- The core suite reports 287 passing checks and **six failures**, with exit code 1. A separate clean worktree at unchanged main `0d6a780` produces the identical six failures. No new core-suite failures were introduced.
- JavaScript syntax checks and `git diff --check` passed.

Coverage includes additive migration replay, complete recorded funnel, same-browser attribution, isolated account access, incomplete reports, daily pricing deduplication, untrusted browser event fields, transactional rollback/retry, duplicate invoices, renewals, current subscription state, cancellation of old/new subscriptions, refunds before receipts, full/failed refunds, current and older invoice layouts, test/internal exclusions, all reminder stages, frequency caps, subscription suppression, opt-out/resubscription, preview-only operation, failed delivery uncertainty, activation cutoff, retention and the official Svix signature vector.

Existing core failures: report CTA source assertion, traffic rendering source assertion, outdated zero-visibility notification wording assertion, the no-scheduler assertion against the existing GA4 refresher, city-validation source assertion and city-help-copy assertion. These are recorded rather than hidden or rewritten to make the suite green. They need a separate baseline test-maintenance review.

Not yet validated: a real Stripe test-mode checkout/webhook round trip, actual email deliverability, provider-side webhook subscriptions, full application registration-to-report UI with real engine responses, rendered mobile/desktop layout in a staging browser, and concurrent webhook delivery against hosted PostgreSQL. No live credentials or production state were used for these tests.

## Deployment and authorisations

**Do not merge or deploy this branch without explicit approval. It changes payment webhook handling and upgrade routing.**

After approval, use the existing environment and existing service integrations:

1. Back up PostgreSQL using the existing operational process. Run migrations before starting this release.
2. Validate in a non-production configuration using existing Stripe test keys and a test database. Run the journey, duplicate/reordered events, cancellation and refunds. Keep all prospect sends off.
3. Confirm the Stripe webhook delivers these snapshot event types to `/api/stripe/webhook`:
   - `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`
   - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - `invoice.payment_succeeded`, `invoice.payment_failed`
   - `refund.created`, `refund.updated`, `refund.failed`
4. Confirm the existing Stripe customer portal permits the intended plan changes. Existing subscribers now use that portal.
5. Review `/admin`, the new result/signup flow and Billing on desktop and mobile. Keep `CONVERSION_EMAIL_MODE=preview` or unset.
6. Production deployment and prospect email activation are separate approvals. The first release can measure conversions with all prospect email automation off.

No new credentials are required to review or test this code. Deployment needs existing GitHub/Render authority. Payment validation needs access to the existing Stripe account's test environment and webhook settings. Do not put secrets in chat or commit them.

For a later, separately approved live-email activation, the daily-digest cron needs existing `RESEND_API_KEY`, `NOTIFY_FROM`, `CANONICAL_HOST`, the same secure `SESSION_SECRET` used by the web service, plus:

```text
CONVERSION_EMAIL_MODE=live
CONVERSION_EMAIL_APPROVED=true
CONVERSION_EMAIL_START_AT=<approved ISO timestamp for earliest eligible signup>
RESEND_WEBHOOK_SECRET=<secret from the existing Resend account>
```

The web service also needs `RESEND_WEBHOOK_SECRET`. Configure `email.bounced` and `email.complained` events at `/api/resend/webhook`. Test signature validation and opt-out handling before enabling sends. Existing Render configuration was deliberately not edited to activate any of this.

Operational limits: uncommon invoices with paginated payment allocations require reconciliation and return a retryable error. No historical Stripe backfill, chargeback/dispute accounting, FX conversion, revenue recognition or CRM enrichment is included. Uncertain email sends require review in Resend before any manual reset. Consent wording and sender business details should be approved for the markets served before live prospect emails.

Rollback: set `CONVERSION_EMAIL_MODE=preview` first. Revert the application release if needed while retaining additive tables/triggers and receipts. Do not drop the conversion tables while the new app or triggers are active. Reverting to the prior payment handler also restores its previously identified retry weakness, so assess that trade-off before rollback.

## Primary implementation references

- Stripe webhook signatures, retries and ordering: https://docs.stripe.com/webhooks
- Stripe event types and successful invoice payment semantics: https://docs.stripe.com/api/events/types
- Current invoice and payment layout: https://docs.stripe.com/api/invoices/object and https://docs.stripe.com/api/invoice-payment/object
- Resend idempotency: https://resend.com/docs/dashboard/emails/idempotency-keys
- Resend signature verification: https://resend.com/docs/webhooks/verify-webhooks-requests
- Svix manual verification and official test vector: https://docs.svix.com/receiving/verifying-payloads/how-manual
