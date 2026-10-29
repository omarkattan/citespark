# Cited implementation review against the Profound benchmark

29 October 2026. Reviewed against Cited release `9d623a6`, which was confirmed live through `/api/version` after the Render migration failure was repaired.

## Decision

Cited has a usable core for measuring questions, inspecting evidence, reviewing specific actions and preparing reports. It does not yet match the full Profound platform described in the attachment. The strongest next investment is approved company/product facts plus a simple edit-and-recheck workflow, not a visual workflow builder or shopping analytics.

The attached checklist is a useful acceptance framework. Its 98 unchecked rows are not 98 missing Cited features. This review classifies all 98 using the repository, focused tests and the live SkinCycles session. It is not a live paid-account comparison with Profound or a full security/medical-claims audit.

**Status meanings:** Working means the core behaviour has implementation and relevant verification, with live-only claims identified explicitly. Partial means an existing capability falls short of the full row. Not found means no implementation was located in the inspected repository, not proof that no external service supplies it. Broken means an identified implementation conflicts with the proposed requirement. Unverified requires external operational evidence. These counts are not a product score.

## Changes completed in this session

- Native sign-in/signup form, password visibility and retryable errors.
- Existing guided setup and replayable tour retained. Users reach up to three specific action cards after a measurement.
- Cards include the question, owned page where verified, proposed edit/check, original evidence excerpts and an editable save handoff.
- Strict JSON output, exact excerpt references, incomplete-response checks and unsupported-price rejection protect drafting. A rejected draft falls back to a labelled investigation, not an invented finding.
- Existing human decisions, notes and selected report copies survive refreshes.
- Render failure: the supplied log shows a terminated database connection at `scripts/migrate.js:10`. It does not prove why the database disconnected. Migration now uses an atomic transaction, bounded connection/lock retries, a short lock timeout and a schema-hash receipt so unchanged schemas are not reapplied. Production subsequently served `9d623a6`.
- 98 focused action/onboarding/report checks and 4 migration checks pass. The complete schema was applied then skipped on repeat in PostgreSQL-compatible test storage, with the advisory lock mocked. The broad suite remains at 288 passing checks and six pre-existing failures. Node 24 was used locally; Render used Node 26.13.0.

Live SkinCycles evidence: a 10-answer measurement completed; allowance stayed at 20/40 during subsequent action refreshes. The final structured drafting call completed normally. Two newly drafted suggestions passed grounding validation. The pricing draft was rejected for unsupported figures and the prior saved pricing review remained intact. These are proposed editorial actions, not proof of measured question demand or guaranteed visibility improvement.

## Highest-priority findings

1. **Approved brand facts (A02/F08/K01).** Store product names, ingredients, prices, audience/suitability, approved claims, source URL, reviewer and review date. Currently website excerpts support drafts, but they do not establish company approval. This is particularly important for SkinCycles.
2. **Average position needs correction (B03).** `analyseRun` derives ordinal from the order tracked names first appear in text. That is not an explicit recommendation rank. Label it mention order or add a separate list-rank classifier with unranked handling. Historical evidence must retain its original method.
3. **Question provenance and legacy volume (D01/D02).** The custom-question route still has a fallback `ai_search_volume` value of 100, and bulk resume orders by that field. Generated/default values must not become observed demand or silently determine business priority. Preserve GSC query evidence as search evidence, separately from generated AI-test questions.
4. **Complete the action loop (F02/F11/I04/I07).** Add a focused in-product FAQ/page-edit draft using approved facts, then record the actual implemented URL/date and offer a comparable recheck. Current decisions and follow-up text are useful but do not automate this loop.
5. **Complete cost accounting (F12).** The visible measurement spend concerns answer collection. The new action generator retains model/token metadata but its drafting cost is not included in that displayed total. Show separate answer-check and drafting costs before calling the figure all-in.
6. **Recovery evidence (H07).** Migration retries improve deployment resilience. They are not a backup or restore test. Verify provider retention and perform a controlled recovery test.

Do not market Cited as superior to Profound yet. Test the same reviewed English/Arabic questions, markets, engine surfaces and multiple dates in both products, then measure unaided task completion and action usefulness.

## Fresh check of Profound claims

Official pages were rechecked on 29 October 2026. They describe advertised features, not independently measured quality:

- [AI Marketer](https://www.tryprofound.com/features/aim) describes suggestions, execution briefs, Agent handoff and project measurement. Action suggestions are therefore not unique to Cited.
- [Pages](https://www.tryprofound.com/features/pages) describes URL-level citations, crawler views, page diagnostics and Agent fixes. Cited's static page reads cover only part of this scope.
- [Context Manager](https://www.tryprofound.com/features/context-manager) describes reusable company, offering and audience context. This supports prioritising approved facts in Cited.
- [Prompt Volumes](https://www.tryprofound.com/features/prompt-volumes) advertises conversation-derived topic/intent data. Cited's generated questions and Search Console data should not be positioned as the same dataset.
- [Agent Analytics](https://www.tryprofound.com/features/agent-analytics) describes crawler and traffic analytics. Cited GA4 referrals do not establish crawler-log monitoring.
- [FactCheck](https://www.tryprofound.com/features/answer-engine-insights/factcheck) describes comparing claims with ground truth. Cited sentiment and retained excerpts are not equivalent.
- [Pricing](https://www.tryprofound.com/pricing) currently presents a seven-day, 50-prompt daily trial and custom Enterprise packages. Older fixed-price comparisons should not be reused.
- The attachment's precise Profound visibility-denominator statement was not reconfirmed from the currently retrieved [AEI overview](https://docs.tryprofound.com/answer-engine-insights/about). Keep it marked for re-verification rather than treating it as a settled current definition.

## All 98 requirements

Source links below point to the reviewed immutable Cited commit. An evidence file identifies the implementation or search boundary; it is not by itself a claim that all acceptance criteria passed.

Classification: Working: 18, Partial: 52, Broken: 1, Not found: 25, Unverified: 2.


### A

| ID | Capability | Status | Evidence and remaining limit |
| --- | --- | --- | --- |
| A01 | Brand configuration | Working | [src/lib/discover.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/discover.js). Website discovery and editable setup feed the guided first measurement. Setup and first-report tests pass. |
| A02 | Brand knowledge and writing guidelines | Partial | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). Brand, aliases, market and category exist. No approved-fact registry with source dates or approval state was found. |
| A03 | Custom prompts and prompt upload | Partial | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). Generate, add, revise, pause and delete routes exist. Search Console import exists. General CSV/file prompt import was not found. |
| A04 | Topics and tags | Partial | [src/lib/prompts.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/prompts.js). Clusters, intent, language and duplicate review exist. General user-managed tags and folders are not established. |
| A05 | Daily prompt collection | Partial | [render.yaml](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/render.yaml). Manual runs and run status exist. Measurement cron is commented out. No complete user-visible schedule, timezone and next-run workflow. |
| A06 | Geographic and persona analysis | Working | [src/lib/measurement-location.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/measurement-location.js). Market, city and persona settings are implemented with collection-location caveats and dedicated tests. Not all markets were tested live. |
| A07 | Multi-language and multi-region configurations | Partial | [src/lib/prompts.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/prompts.js). English and Arabic generation and language handling exist. Native-language review and full RTL report QA remain unverified here. |

### B

| ID | Capability | Status | Evidence and remaining limit |
| --- | --- | --- | --- |
| B01 | Visibility percentage | Working | [src/lib/report-question-summary.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/report-question-summary.js). Measured answers, named/cited counts and denominator are retained. Live SkinCycles view showed 10 answers and 0% named. |
| B02 | Share of voice | Partial | [src/lib/mentions.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/mentions.js). Landscape share exists, but its provider-derived denominator differs from a fixed tracked competitor cohort. Do not call the measures interchangeable. |
| B03 | Average position | Broken | [src/lib/analyze.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/analyze.js). analyseRun assigns ordinal from first textual mention order, not an explicit ranked recommendation list. It does not meet the benchmark definition of average position. |
| B04 | Competitor comparisons | Working | [src/lib/competitor-review.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/competitor-review.js). Competitor review, tracked entities and answer evidence exist. Dedicated tests cover review and baseline handling. |
| B05 | Engine comparisons | Partial | [src/lib/dataforseo.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/dataforseo.js). Multiple engine adapters and per-engine reporting exist. This is not proof of every Profound surface, plan or consumer UI equivalence. |
| B06 | Topic and prompt breakdowns | Working | [src/public/app.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/public/app.js). Questions, grouped opportunities and answer reader connect findings to retained evidence. Action-to-review handoff was exercised live. |
| B07 | Consumer-interface collection, vendor claim | Partial | [src/lib/collection-display.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/collection-display.js). Provider/model/engine context and collection caveats exist. Browser-versus-API provenance needs a complete surface-by-surface acceptance test. |
| B08 | Historical response inspection | Working | [src/lib/measurement-batches.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/measurement-batches.js). Measurement batches, prompt revisions and archived answers preserve historical evidence. Archive/persistence tests exist. |
| B09 | Performance trends and segmented views | Working | [src/lib/history-query.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/history-query.js). Comparable history logic and method notes exist. Tests cover cohort integrity. Multiple-date SkinCycles comparison was not possible with one day of data. |

### C

| ID | Capability | Status | Evidence and remaining limit |
| --- | --- | --- | --- |
| C01 | Sentiment and recurring themes | Partial | [src/lib/analyze.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/analyze.js). Sentiment and snippets exist, with optional model refinement. No complete recurring-theme and reviewer correction workflow was found. |
| C02 | Citation sources and authority analysis | Working | [src/lib/report-evidence.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/report-evidence.js). Stored citation URLs and owned-domain distinctions are implemented and covered by evidence tests. |
| C03 | Source domains, categories and pages | Working | [src/lib/teardown.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/teardown.js). Source classification and URL/domain aggregation exist. Classification is heuristic and should remain reviewable. |
| C04 | Competitor citation gaps | Partial | [src/lib/recommend.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/recommend.js). Competitor/source opportunities exist. Absence from a particular publisher page still needs page inspection, not inference from a model answer. |
| C05 | Claims checked against approved facts | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). No approved-fact store and claim verification model with wrong/unsupported/outdated/ambiguous states was found. |
| C06 | Claim-level source attribution | Partial | [src/lib/report-evidence.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/report-evidence.js). Answer and source evidence are linked. Claim-level error attribution and source causality are not established. |
| C07 | Accuracy metrics and theme trends | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). No assessed-claim denominator or factual-accuracy theme history was found. |
| C08 | Remediation from an inaccurate claim | Partial | [src/lib/recommendation-decision.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/recommendation-decision.js). A human can save a correction investigation and its evidence. Automatic claim detection and publisher correction drafting are incomplete. |

### D

| ID | Capability | Status | Evidence and remaining limit |
| --- | --- | --- | --- |
| D01 | Prompt demand data from consumer panels | Partial | [src/lib/mentions.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/mentions.js). Third-party AI-volume fields exist, while generated questions are separately labelled. No first-party consumer-panel dataset or equivalent coverage was verified. |
| D02 | Keyword/topic volume and trends | Partial | [src/lib/demand.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/demand.js). Search Console source, period, query examples and matching caveats exist. Legacy ai_search_volume defaults and prioritisation still need cleanup. |
| D03 | Related keyword hierarchies and lists | Working | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). From-topic generation, persona previews and duplicate-question review exist. Tests cover prompt quality and workflow. |
| D04 | Intent and sub-intent analysis | Working | [src/lib/immediate-actions.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/immediate-actions.js). Question intent and diverse commercial action selection exist. Priority is explicitly editorial, not measured demand. |
| D05 | Audience and demographic filters | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). Personas are working context. No observed demographic demand dataset or supported demographic filters were found. |
| D06 | Research reports and domain-related prompts | Partial | [src/lib/brief.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/brief.js). A question-specific brief includes answers and cited sources. It is not a complete reviewed demand-research report with every question mapped to an owned page. |
| D07 | Co-citation and uncited-prompt discovery | Partial | [src/lib/recommend.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/recommend.js). Competitor presence and cited sources can expose opportunities. A dedicated co-citation matrix and uncited-prompt discovery workflow are not complete. |
| D08 | Query fan-out variations and frequency | Partial | [src/lib/dataforseo.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/dataforseo.js). fan_out_queries are stored where the provider exposes them. Availability and frequency coverage vary by surface. |
| D09 | Word changes, date tokens and persona effects | Partial | [src/lib/personas.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/personas.js). Personas and observed fan-out can be inspected. A controlled wording/freshness experiment workflow was not found. |

### E

| ID | Capability | Status | Evidence and remaining limit |
| --- | --- | --- | --- |
| E01 | AI crawler monitoring from server logs | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). No customer server-log ingestion or AI-bot visit table was found. Fetching a page is not crawler monitoring. |
| E02 | Verification of crawler identity | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). No crawler identity verification pipeline was found. |
| E03 | Human traffic and attribution insights | Working | [src/lib/traffic-summary.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/traffic-summary.js). GA4 referral sessions, landing pages, key-event context, currency and coverage states are implemented and tested. SkinCycles has no connected GA4 proof in this session. |
| E04 | Content performance by page | Partial | [src/lib/traffic-summary.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/traffic-summary.js). Referral pages and citation URLs exist separately. A unified page outcome timeline is not complete. |
| E05 | Network-wide page benchmarking | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). Sector studies exist, but not a representative network-wide page dataset comparable to Profound's advertised network. |
| E06 | Crawlability and technical diagnostics | Partial | [src/lib/teardown.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/teardown.js). HTML structural checks and fetch outcomes exist. JavaScript rendering, repeatable browser comparison and a full retest workflow are incomplete. |
| E07 | Infrastructure and web-platform integrations | Partial | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). GA4/GSC connections, scope and disconnect flows exist. Customer CMS and server-log integrations were not found. |
| E08 | Content submission to AI search, vendor claim | Not found | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). No documented AI-search content submission route was found. |

### F

| ID | Capability | Status | Evidence and remaining limit |
| --- | --- | --- | --- |
| F01 | Publisher outreach opportunities | Partial | [src/lib/recommend.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/recommend.js). Publisher/directory/community opportunities are classified. A verified omission and factual pitch draft still require review. |
| F02 | New content and FAQ workflows | Partial | [src/lib/brief.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/brief.js). Evidence-led briefs and suggested FAQ questions exist. A complete in-product source-grounded article/FAQ editor is not yet present. |
| F03 | Existing-content refresh workflows | Working | [src/lib/immediate-actions.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/immediate-actions.js). Reads relevant owned pages and proposes a specific edit or check before asking for new content. Live SkinCycles test verified page-linked drafts. |
| F04 | Competitor research and format recommendations | Partial | [src/lib/teardown.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/teardown.js). Cited-page structure and commentary exist. A verified side-by-side owned/competitor content comparison is not complete. |
| F05 | Reusable workflow templates | Partial | [src/lib/recommend.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/recommend.js). Rule types and editable decisions cover several action classes. No simple selectable template workflow for all five benchmark actions. |
| F06 | Visual workflow builder | Not found | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). No visual general-purpose workflow builder was found. Defer until core task completion is reliable. |
| F07 | Scraping, model, analytics and API steps | Partial | [src/jobs/runCycle.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/jobs/runCycle.js). The measurement pipeline has progress and provider errors. It is not an inspectable user-configured workflow engine. |
| F08 | Brand kit and knowledge-base retrieval | Partial | [src/lib/report-analyst-context.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/report-analyst-context.js). Saved project and measurement context are reused. Approved facts, brand tone and material-claim source approval need a dedicated store. |
| F09 | Human approval and CMS publishing | Partial | [src/lib/report-note.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/report-note.js). Explicit review and report-copy confirmation exist. No CMS publication integration was found. |
| F10 | Batch execution through Sheets | Not found | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). No Sheets-driven batch content workflow was found. |
| F11 | Post-publication citation feedback | Partial | [src/lib/recommendation-decision.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/recommendation-decision.js). Completion and follow-up fields plus comparable history exist. Automatic linking of an implemented page edit to its remeasurement is incomplete. |
| F12 | Estimated and actual workflow credits | Partial | [src/lib/measurement-cost.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/measurement-cost.js). Measurement cost estimates and actual answer costs exist. Immediate-action drafting usage is retained but not included in the visible answer-cost total. |

### G

| ID | Capability | Status | Evidence and remaining limit |
| --- | --- | --- | --- |
| G01 | Product visibility and placement | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). No separate shopping-product placement measurement model was found. |
| G02 | Shopping-trigger rate and prompts | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). No shopping-trigger denominator was found. |
| G03 | SKU-level keywords and citations | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). No SKU/variant entity model or shopping citation store was found. |
| G04 | Product attribute accuracy and sentiment | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). No approved product-feed comparison and attribute-accuracy workflow was found. |
| G05 | Merchant/retailer share | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). No same-product merchant offer comparison was found. |
| G06 | Feed, markup and competitor-gap actions | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). General page suggestions do not establish product-feed diagnostics. |

### H

| ID | Capability | Status | Evidence and remaining limit |
| --- | --- | --- | --- |
| H01 | Configurable dashboards | Partial | [src/public/app.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/public/app.js). Simple default views and a prominent action queue exist. User-configured dashboards are not established. |
| H02 | Saved filters and layouts | Partial | [src/public/app.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/public/app.js). Filters and report dates exist. Named, persistent multi-dimensional saved views/layouts were not found. |
| H03 | PDF reports and public dashboard links | Partial | [src/lib/report-snapshots.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/report-snapshots.js). Full report, executive brief and fixed snapshots exist. Links require account access. Public sharing and exported RTL PDF quality are not verified here. |
| H04 | CSV export | Working | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). Authenticated CSV report download exists with underlying answer/citation data. CSV is not an XLSX workflow. |
| H05 | Per-client reporting views | Working | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). Project ownership checks and scoped queries protect the client evidence/report routes inspected. Relevant cross-project tests pass; this is not a full security audit. |
| H06 | SSO and role-based access | Partial | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). Session authentication and organisation/project isolation exist. SAML/SSO and granular client roles were not found. |
| H07 | Automated backups | Unverified | [render.yaml](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/render.yaml). A database deployment definition does not prove backups or restore success. Requires an actual controlled recovery test and retention evidence. |
| H08 | SOC 2 Type II claim | Unverified | [README.md](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/README.md). No independently verified SOC 2 Type II assurance was supplied or checked. Do not infer certification from product functionality. |
| H09 | API access and JSON exports, Enterprise | Partial | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). Session-authenticated JSON endpoints exist. External API tokens, a stable published contract and documented client limits were not found. |

### I

| ID | Capability | Status | Evidence and remaining limit |
| --- | --- | --- | --- |
| I01 | Proactive opportunity suggestions | Working | [src/lib/immediate-actions.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/immediate-actions.js). Up to three evidence-linked suggestions, cache reuse and suppression handling exist. Live output was verified, including safe fallback for a rejected draft. |
| I02 | Execution briefs and suggested tasks | Working | [src/lib/recommendation-decision.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/recommendation-decision.js). A card fills an editable action, evidence, purpose, owner suggestion, completion check and follow-up. Saving remains explicit. |
| I03 | Conversational analysis of project data | Not found | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). Report analysis exists, but no general conversational project-data assistant was found. |
| I04 | Plan-to-Agent handoff | Partial | [src/public/app.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/public/app.js). One-click handoff to the populated decision form works. This is not automatic content execution or publication. |
| I05 | Goal-based projects with status and priority | Partial | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). Sites/projects and task status exist. Multiple goal-based workstreams with distinct business metrics are not established. |
| I06 | Shared context, reusable skills and artifacts | Partial | [src/lib/report-analyst-context.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/report-analyst-context.js). Stored evidence and decisions feed report drafts. Shared approved files, reusable skills and goal artifacts are incomplete. |
| I07 | Project-specific impact tracking | Partial | [src/lib/history-query.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/history-query.js). Comparable measurements and completion dates exist. Goal/action-specific impact tracking is not automatic. |
| I08 | AI-assisted document writing and revision | Partial | [src/lib/report-analyst-store.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/report-analyst-store.js). Report analysis supports edits and edit history. This is not a general collaborative content document editor. |
| I09 | Live co-editing, comments and external collaboration | Not found | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). No live document co-editing, comments or external document role controls were found. |
| I10 | Documents used in workflows and CMS publication | Not found | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). No version-preserving document-to-CMS workflow was found. |

### J

| ID | Capability | Status | Evidence and remaining limit |
| --- | --- | --- | --- |
| J01 | URL inventory, citation share, bot activity and history | Partial | [src/lib/pagecheck.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/pagecheck.js). Page checks, citation URLs and traffic landing pages exist. No unified URL inventory with bot activity and a full change timeline. |
| J02 | Citation breakdowns down to text chunks | Partial | [src/lib/immediate-actions.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/immediate-actions.js). Exact selected excerpts support drafts. A fetched excerpt is not proof of the passage an engine used for a citation. |
| J03 | Retrieval-candidate pages with few citations | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). No retrieval-candidate inventory was found. A page fetch cannot substitute for observed engine retrieval. |
| J04 | Human view versus crawler view | Partial | [src/lib/action-pages.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/action-pages.js). Owned HTML can be fetched safely. No captured human-rendered versus crawler-rendered page comparison exists. |
| J05 | Content scoring and projected improvement | Partial | [src/lib/teardown.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/teardown.js). Structural features and editorial suggestions exist. No validated composite page score or defensible projected uplift model was found. |
| J06 | Lighthouse and PageSpeed health checks | Not found | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). No Lighthouse or PageSpeed result ingestion was found. |
| J07 | IndexNow submission | Not found | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). No IndexNow submission implementation was found. |

### K

| ID | Capability | Status | Evidence and remaining limit |
| --- | --- | --- | --- |
| K01 | Continuously updated Brand Records | Partial | [src/lib/discover.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/discover.js). Site context can be discovered and edited. No continuously refreshed approved Brand Records with provenance were found. |
| K02 | Personal Records and knowledge-gap questions | Not found | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). No separate personal working-preference record or knowledge-gap interview system was found. |
| K03 | Connected tools for context and execution | Partial | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). GA4 and GSC connections exist. CMS, knowledge-base and content-execution connectors are not complete. |
| K04 | Scheduled Agent runs | Partial | [render.yaml](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/render.yaml). Operational cron definitions and an auto_cycle field exist. Customer scheduling with timezone/history/pause controls is incomplete; measurement cron is disabled in the blueprint. |
| K05 | App events, web changes and metric-threshold triggers | Not found | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). No general app-event/web-change/metric trigger workflow was found. Billing webhooks are not marketing workflow triggers. |
| K06 | Agent history, sharing and version restoration | Partial | [src/lib/report-analyst-store.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/report-analyst-store.js). Report edits and snapshots preserve output history. There is no general Agent instruction/version restoration system. |
| K07 | Sheets imports and multiple export formats | Partial | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). CSV export and Search Console prompt import exist. Sheets/CSV upload and XLSX output are not a complete user workflow. |
| K08 | MCP access for external AI assistants, Enterprise | Not found | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). No scoped external MCP server for project/report/action access was found. |
| K09 | Agency dashboard and independent client workspaces | Partial | [src/db/schema.sql](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/db/schema.sql). Organisation-scoped sites and usage exist. A full agency portfolio with independent client memberships and client budgets is incomplete. |
| K10 | Pitch workspaces, expiry and promotion to clients | Partial | [src/lib/demo-funnel.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/demo-funnel.js). Public demo handoff and project continuation exist. Dedicated pitch workspaces with expiry and promotion are not established. |
| K11 | Member credit limits and overage controls | Partial | [src/lib/plans.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/plans.js). Organisation entitlements and cycle spending caps exist. Per-member credit limits and explicit overage governance are incomplete. |
| K12 | AI assistant and workflow results in Slack | Not found | [src/server.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/server.js). No Slack project-query/report delivery integration was found. |
| K13 | Free AEO snapshot report | Working | [src/lib/demo-setup.js](https://github.com/omarkattan/citespark/blob/9d623a634456a7ee0e6f5698c9dc6db9010acad5/src/lib/demo-setup.js). Public limited demo and registration/project continuation exist, with dedicated setup and handoff tests. |

## Next release acceptance

A new user should be able to sign in, add a site, review a small question set, run it, understand three suggested actions, save one reviewed action and include it in a report without assistance. A separate fresh account should repeat this after deployment. English and Arabic should each receive a human language-quality check. Do not mark this entire criterion complete from a returning-account test alone.

For each suggestion, retain the measurement ID, prompt, answer ID, page URL/read date, original excerpt, draft version and human review status. Generated FAQ questions should remain clearly labelled as editorial suggestions unless actual customer-query evidence is supplied.
