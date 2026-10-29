# Cited question-evidence UX update — 29 October 2026

Based on your uploaded `citespark-main (1).zip`, verified byte-for-byte against repository commit 273d7451b13881d9aece8c0a35cd0d8dd8fdfa58 before editing.

## Upload these replacement files at their existing paths

- src/public/app.js
- src/public/index.html
- src/lib/report-executive-html.js

Also add `scripts/test-question-evidence-ux.js` for the focused regression checks.

The package contains complete replacement files, not snippets. Back up the three existing files, copy these into the same paths, then use your normal deployment process. No dependency, environment-variable or database migration changes are needed. The application script cache version changes from 122 to 123. No code has been pushed or deployed by this work.

## What changes

- Makes “Review content brief” visible directly on question cards.
- Shows dated Google impressions, clicks, property and query matching beside original Search Console queries.
- Keeps unknown evidence distinct from measured zero and never places old import counts under fresh dates.
- Replaces vague “demand unverified” wording with “AI question volume not measured.”
- Labels the headline question percentage “Named or cited” and keeps both component metrics visible at zero.
- Includes up to five deduplicated original Google queries in the full report, with an explicit truncation label. Retained query-set wording takes precedence over example snippets; HTML is escaped and text direction is automatic.

- Improves PDF pagination: long actions can flow across pages, unnecessary forced section breaks are removed, and the duplicate closing brand footer is hidden in print (page footers retain Cited branding).

## Validation

18 focused checks passed:
`node --test scripts/test-question-evidence-ux.js scripts/test-report-refinement.js scripts/test-report-question-summary.js scripts/test-question-quality.js`

Syntax checks passed for both changed JavaScript application files.

The broad `npm test` run produced 288 passing checks and six failures. The same six failures occur on the untouched uploaded baseline: report availability selectors, traffic-panel wording, zero-visibility trial wording, scheduler expectations, invalid city/country handling, and city engine-coverage wording. They are not introduced by this patch.

The optional database-backed report-trust suite also has six baseline failures (missing reporting_runs fixture and reportReview stub) on both versions. Those existing test fixtures were not changed.

Local validation used Node 24.22.1. The repository declares Node >=26.12.1 <27; repeat the focused checks on the deployment runtime before release. Paid provider calls and a production deployment were not part of local code validation.

## Quick UI check after deployment

Open Questions, expand a Search Console-derived question’s original-query evidence, and confirm dates and zero/missing values. Confirm “Review content brief” is visible and opens correctly. Open a measured zero-result question and confirm named/cited zeros are shown. Open the full report and inspect the original-query column, including Arabic text.

Rollback: restore the three files from the supplied original repository ZIP and redeploy through your normal process.

