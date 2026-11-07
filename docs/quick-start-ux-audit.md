# First-report UX audit

## Scope

Walked the live Cited site in the cloud browser on 7 November 2026. Inspected signup, then used the existing internal account to create a fresh Cited project (76). Email delivery and a new free account's permissions were not tested. The local Quick Start branch was not deployed, so the live walkthrough does not validate that branch.

The user authorized the paid test scan. The confirmation showed 20 questions, six engines, 120 checks and an estimated provider cost of $3.25. This is an estimate, not a final invoice.

Reached the new project's executive report at https://cited.ae/api/projects/76/report?view=ceo. Measurement 163 displayed 117 measured answers and three failed checks. The report was available while the main app still displayed Checking website pages and preparing your next actions. The main app already showed three suggested action cards, but the report said No team recommendations have been selected and No reviewed decisions selected yet. This demonstrates both an inconsistent completion experience and the gap between generated suggestions and report-selected decisions. The brand-matching figures were inspected as displayed UI, not independently validated against each answer.

## Observed friction

* Website discovery opens a long six-step flow and asks users to select customer types and review editable business fields.
* Optional Google connections occupy a complete step, with two separate ways to skip them.
* The initial question screen includes filters, content briefs, volume labels, editing and an expanded add-question form before any result exists.
* Starting requires successive review-measurement, review-cost-and-run and run-active-questions actions.
* During collection, the page simultaneously says Running, No data and Ready for your first measurement. The full settings navigation remains visible.
* Primary navigation, subnavigation, six setup steps and repeated help markers compete for attention. Small uppercase labels make the experience look like an operations console. Quick Start should have one dominant heading and action, readable sentence-case labels, and contextual help only where it is needed.
* The generated set contains overlapping shortlist questions and generic education questions. Quick Start needs distinct buying situations, with local and service qualifiers where supported.
* In an existing project's report flow, users must review answers, record decisions, choose recommendations, preview and save. Clicking Review and save action expands a large work queue and a decision form. This is agency workflow, not first-use onboarding.

## Revised first-use contract

The previous local Quick Start draft still exposes separate website-discovery and question-generation buttons, automatically expands business fields, requires a separate question-review page, and asks the user to fill missing suggestions. Those choices should be revised before deployment. A shorter wizard alone is insufficient.

After signup, ask for a website. Read it automatically and show a compact business/service/location summary with an Edit link. Ask a short clarification only when a required fact cannot be inferred reliably.

Generate and preselect at least 20 distinct unbranded buyer-shortlist questions. Show three examples and one collapsed View/edit all questions control. Do not require users to approve each question or repair a short generation result manually.

Use one primary action: Create my free report. Explain the included engine coverage beside it. Choose a small fixed engine set for the free report. Keep provider-cost controls and engine configuration in Advanced.

Replace the setup screen with collection progress, then automatically display a saved report. Show measured brand mentions, website citations, relevant competitors and three suggested actions. Keep supporting answers and method details available on demand. Missing answers must remain distinct from negative results.

The report must not require users to approve or assemble recommendations. Clearly label generated actions as suggestions. Editorial approval, owners, delivery details and client-report assembly belong in Advanced.

Offer upgrades after the first useful report. Paid accounts should retain the simple report view, with an explicit switch to Advanced. Purchasing an upgrade must not force a more complicated interface.

## Acceptance checks for the next iteration

1. A new user can reach report generation by entering their website and confirming the inferred summary, with no mandatory Google connection, question-editing or engine-selection step.
2. Twenty relevant questions are prepared automatically and remain editable through an optional control.
3. Reloading during collection resumes the same scan and cannot charge for a duplicate run.
4. The completed report opens automatically and survives a return visit.
5. No-data, pending and failed states are clearly distinguished. Partial results never appear as zero visibility.
6. Suggested actions appear without editorial decisions or report-selection work.
7. Free users see upgrade offers after receiving value, and advanced paid controls remain hidden during first use.
8. Test a genuinely new free account, email verification and the paid-mode switch before calling the journey ready.
