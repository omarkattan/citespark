# Bank al Etihad measurement reliability fixes

Scope: project 28, measurement 173. The original evidence is preserved. This change does not run another production measurement or declare the client report complete.

## Confirmed findings and changes

| Issue | Confirmed cause or remaining unknown | Change |
| --- | --- | --- |
| C01: four missing outcomes and one failure | The worker held its job list in memory, inserted runs only after a response, and logged per-job exceptions without saving a check outcome. A failure before insertion could therefore disappear from the archive. The stored Google error is `Internal SE Server Error.` The exact termination cause for the four historical gaps is still unknown without server logs. | Persist all planned slots before dispatch. Retain provider attempts, request IDs, responses and costs. Terminalize unfinished checks, isolate individual errors, retain bounded provider retries, and distinguish partial from completed. Notify the configured owner on partial or failed collections. |
| C02: targeted retry blocked | `collectRetry` inherited the last completed monitoring measurement, so changed settings were compared against the September snapshot. | Measurement-specific recovery hydrates the original question texts, model pins, market, repeats, output limit and scoring policy. Preview before starting. Only unresolved slots are requested. A linked recovery preserves successful records and original timestamps. Exact model availability is checked without silently substituting another model. |
| C03: September shown after November | Published measurement views excluded failed batches. Dashboard and question queries consequently read September while the archive exposed November. Progress was only in memory. | Publish the latest retained partial attempt with explicit status. Show latest attempt and last completed collection separately. Use selected measurement answers for dashboard, Questions, report and archive. Fall back to durable state after a worker restart and provide recovery. |
| C04: incomplete source evidence | Full provider payloads, annotation metadata and source titles were discarded. The supplied export and live stored URLs disagree. Live verification found existing destination URLs in 54/59 Claude, 59/59 Perplexity and 55/60 Gemini answers. Raw payloads remain unavailable, so the reason for the export discrepancy is not yet established. | Retain raw attempts, annotations, request search settings and returned search metadata. Export evidence as authenticated JSON. Classify no citations returned, unavailable collection, unresolved destination and attributable URLs. Restrict redirect resolution to exact known wrapper hosts and public destinations. Main, blog and other owned hosts use actual destination hostnames, with deduplicated totals. Incomplete source coverage is labelled across report formats. |
| C05: inconsistent bilingual matching | Five stored competitor alias arrays were empty. The old matcher used ASCII boundaries and lacked Arabic normalization and these reviewed exclusions. | Add reviewed names for all nine banks, Arabic normalization, Unicode boundaries and lookalike exclusions. Version the detector as `visible-text-v3-ar`. Recovery preserves the original detector. Separate retrospective reanalysis saves reviewed aliases and does not overwrite original responses, mentions or settings. |

## Recovery instructions

1. Open https://cited.ae/api/projects/28/measurements/173.
2. Select **Retry failed or missing checks** to preview only. The expected original gap set is five, with 355 saved usable answers retained.
3. Review the count, capability check and estimated provider cost. Do not confirm until the report owner accepts the outstanding citation limitation.
4. Confirmation creates a linked recovery measurement. It does not replace 173. Repeated requests for the same source open its existing recovery. If that recovery is partial, recover from that child measurement.
5. **Save bilingual reanalysis** checks saved text with the reviewed names without provider calls. Its results are labelled retrospective and remain separate from the original scores.

If an original question/entity was deleted or a model/policy is unavailable, recovery stops with an explanation. A clean new baseline must be agreed rather than silently mixing methods.

New attempts with a saved successful provider response can be reconstructed without requesting that answer again. A request interrupted before its response was persisted cannot be reconstructed from absent evidence. The provider may already have processed that request; recovery cannot guarantee no additional upstream charge in this case.

## Verification

Local result: **222 focused regression tests passed, 0 failed**, plus **278 core checks passed**. Runtime: Node 24 in the workspace, PGlite PostgreSQL fixtures and JSDOM UI fixtures. Production is pinned to Node 26.12.1; live deployment verification is reported separately.

The DB-backed collector fixture reproduces 60 questions × six engines, with four processing interruptions and one provider failure. It verifies 360 traceable slots, 355 usable answers, 356 retained run records and five unresolved outcomes. Changing current project settings and pausing half the questions does not alter recovery's original scope. Exactly five new requests complete the fixture. Repeating recovery makes no new requests.

Other checks cover raw response replay after a run-insert failure, duplicate attempt callbacks, one selected scored result per slot, terminal states after interruption, source title/annotation retention, cumulative retry costs, exact model compatibility, safe URL attribution, all nine bilingual profiles, historical scoring policy preservation and confirmation before provider requests. The targeted migration is tested against the production schema receipt, preserving existing answers and project repeat counts.

A wider legacy-test comparison found 11 failures that also occur on the unchanged local baseline (`64572be`). These involve stale extracted-function dependencies, incomplete test schemas, old UI text expectations and an asynchronous report-status fixture. They are not counted as passes and the full repository suite is not declared green.

## Remaining report and launch blockers

- Retrieve application logs around measurement 173, 16 November 2026 22:37–23:00 UTC, to establish the historical cause of the four missing records. Owner: application operator. The code defect is confirmed, but a simulation is not proof of that historical event.
- Measurement 173 did not store raw provider payloads. Its missing historical source metadata cannot be recreated from nothing. Existing stored URLs are available in the new JSON export. They do not establish complete historical collection coverage, and opaque Google URLs remain unattributed until resolved. Verify the report evidence or explicitly revise its scope. Owner: measurement/report owner.
- Enabling web search does not guarantee that an API response searches or returns citations. API samples must not be represented as identical to consumer sessions. References: https://docs.dataforseo.com/v3/ai_optimization-claude-llm_responses-live/ and https://docs.dataforseo.com/v3/ai_optimization-perplexity-llm_responses-live/.
- Validate a successful Ahrefs crawl before presenting current technical issue totals. Owner: SEO/technical owner.
- Obtain a domain or blog-specific GSC property for blog search performance. Main-site URL-prefix GSC and blog GA4 do not supply that missing scope. Owner: analytics/SEO owner.
- Production recovery, final report reconciliation and a fresh end-to-end signup/upgrade check remain required before advertising launch approval. Deployment alone is not a launch green light.

Arabic name reference: https://www.cbj.gov.jo/ar/Pages/Bankingsectorguide and the banks' official sites.

## Live verification

Release `6ef527f` started at 2026-11-17 00:04:23 UTC (16 November, 19:04:23 New York). The live archive reports 360 planned, 355 usable, one failed and four missing. Recovery preview confirms five provider checks, zero replayable payloads, 355 retained answers and an estimate of $0.09. Original pinned models passed the availability check. No production scan was started. A follow-up corrects classification of Google `/goto` links found in live retained evidence.

Live dashboard and Questions now identify November measurement 173 with 355 measured answers, alongside last completed measurement 44 from September 29. Separate bilingual reanalysis was saved for all nine entities, with no provider requests. Follow-up validation: 32 targeted tests passed, including Google `/goto` handling and withholding citation-absence claims in Questions.
