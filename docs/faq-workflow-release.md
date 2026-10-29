# Guided FAQ workflow — 29 October 2026

A measured buyer question now leads to an editable, evidence-linked FAQ through a three-step workflow: review facts, draft the answer, and record publication before repeating the measurement. The **Draft this FAQ** button is near the top of each specific action card. Reopening the same action resumes saved work without another generation charge.

## Behaviour

- **Facts:** the existing bounded public-page reader checks the owned homepage and relevant pages. AI selects exact passages; the server rejects invented quotations. Candidates are not approved automatically. Users can correct them, add a fact with its source URL, remove a fact or withdraw its approval. Original passages remain separate from edited statements.
- **FAQ:** one structured request uses only approved facts and the exact measured question. The server validates fact references, unsupported numeric values and output completeness. Missing information is shown as a specific placeholder and a review list. Claims require owner review; the tool does not independently certify product, medical, financial or legal assertions.
- **Review:** edited drafts and target URLs are saved with optimistic revision checks. Changing approved facts invalidates an older draft's readiness. Regeneration preserves prior saved versions. Copying approved content, downloading the FAQ with evidence, and loading it into the existing action/report review flow are separate choices. Report inclusion still requires saving the action and confirming its report preview.
- **Publication:** the owner records the real URL and publication date. Cited does not publish to the CMS or assert that it verified a website update.
- **Repeat:** a separate settings-and-cost preview precedes paid collection. The exact question, engines, resolved model selections, market, detection policy, competitors, output ceiling and per-engine sample counts must match the baseline. Unknown legacy settings, changed questions, incomplete baselines and insufficient allowance block a matched repeat. Only newly collected answers enter the comparison; failed or mixed-model outcomes cannot be labelled comparable. No causal effect is inferred.
- **Monitoring isolation:** FAQ repeats have `purpose=faq_recheck` and remain in the measurement archive. They never replace a full daily monitoring collection or blend old target answers into the after sample. Other questions and historical answers remain intact.
- **Recovery:** duplicate requests are reserved in PostgreSQL, concurrent jobs of the same kind are rejected, saved work can be reopened, and interrupted requests become retryable after ten minutes. Another paid repeat is an explicit choice; prior saved versions remain in history.

## Measurement and cost corrections

- Ordinal is labelled **First-mention order**, including answer badges and the persona table. It is the first textual occurrence among tracked brands, not a recommendation rank or frequency ranking.
- Generated questions have no numeric demand estimate. Legacy values without provenance are archived in `origin_details.legacyUnverifiedVolume` and cleared from the active field. A measured-volume import can retain its explicit source provenance. Generated volume no longer influences question ordering or recommendation priority; buying-intent weights are editorial choices.
- New immediate-action, fact-selection and FAQ generation calls have one cost record per provider request. Cached results do not create another charge record. Recorded token usage is retained even if draft validation fails.
- The workflow displays answer-check costs separately from estimated drafting API cost. Standard Sonnet 4.5 rates are used for recognised models and recorded usage; unknown costs remain unknown. This is not an invoice, and earlier drafting or other AI analysis is not included. Source: https://platform.claude.com/docs/en/about-claude/models/overview and https://platform.claude.com/docs/en/about-claude/pricing (checked 29 October 2026).
- Email verification continues to gate AI drafting, with the same grandfathered/internal-account rules as answer collection. Project ownership is checked before every workflow operation.

## Verification

- The new workflow tests exercise a fresh facts-to-draft-to-publication-to-repeat journey in JSDOM against PostgreSQL-compatible storage, including missing-fact rejection, saved-work recovery, original quotations, explicit approval, account isolation, cost accounting, concurrency and stale-edit protection.
- Collector integration tests repeat three original samples, exclude prior target answers, preserve the original monitoring cohort, reject changed questions/settings before spending, and mark failed or model-drift samples noncomparable.
- The full schema supports clean installation and replay. Existing atomic migration/retry protection is retained. No dependency or hosting configuration change is required.
- 194 focused onboarding, action, report, migration, storage and measurement checks pass, including 15 new FAQ workflow/recheck checks. The broad legacy suite has 288 passing checks and six pre-existing failures and is not represented as fully passing.

## Live QA

- Render served the release commit `73cd059` at 16:00 UTC, then the pricing/cost correction `68a794e` at 16:06 UTC. The schema migration completed successfully.
- The live SkinCycles account opened the new workflow, extracted facts, saved four reviewed commercial price examples, generated a draft, retained missing-fact placeholders for review, and saved a human-edited FAQ on the exact measured question with the anti-aging collection URL.
- Reopening recovered saved facts and work. Copy approved FAQ copied the exact question and reviewed answer. The report handoff opened the existing action editor with the FAQ and source facts; report inclusion remained an explicit preview step.
- The reviewed pricing FAQ was saved as a ready action, its changed report copy was explicitly confirmed, and a new immutable report snapshot was saved at 16:16 UTC. The saved report contains the exact FAQ, target page, source prices, original measured-answer link, completion checks and follow-up instructions: https://cited.ae/api/projects/39/report/snapshots/44c0755a-c844-4dea-a82d-d0cc6f595d08. The previous report snapshot remains unchanged.
- Live QA identified and corrected an overly broad fact-selection prompt, Sonnet's `inference_geo=not_available` cost classification, a checkbox inheriting the global full-width input style, and missing progress feedback during report handoff. Numeric validation accepts equivalent price formats such as 165 and 165.00 while still rejecting unsupported values.
- Two fact-selection requests and one FAQ draft recorded an estimated total of $0.0425; answer-check cost stayed $0.252492 and allowance use stayed 20/40. No new visibility checks were required for drafting.
- No FAQ was published to skincycles.com and no publication date was falsely recorded. Publication and matched-repeat behaviour were verified with test data; the real-site repeat waits for an actual published change. A fresh signed-out account was not created again during this release's live QA; the existing new-account test workspace was reused.

