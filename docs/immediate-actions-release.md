# Specific first-run actions

Goal: a new user can sign in, add a site, review questions, run a measurement and receive specific, editable next actions without having to write a recommendation from scratch.

## Behaviour

- Sign-in and signup use a native form, password-manager attributes, a show-password control, explicit password requirements and guarded submissions. Registration and verification errors remain retryable. Email verification is still required before spending answer checks.
- Every completed measurement uses the existing recommendation builder to prepare up to three action drafts automatically. Existing measurements can use Prepare my actions without repeating the answer checks.
- Pricing, comparison and selection questions are prioritised using an editorial heuristic. This is not measured demand or an impact estimate.
- The app reads the homepage and at most three relevant, observed internal links. Public HTTPS reads are bounded, DNS addresses are checked and pinned, redirects remain on the owned domain, and blocked pages are not bypassed.
- One bounded drafting call uses structured JSON output, measured answers and fetched page excerpts. Incomplete responses are rejected and provider completion metadata is retained for diagnosis. The model selects supplied excerpt IDs. The server copies the original passages, and validates the page/answer references. Invented references fall back to a specific conditional check.
- Each card supplies the question, proposed change, page where verified, reason, supporting answer and page passages, and suggested on-page questions. Adequate existing content can be retained. No gap is inferred solely from a missed mention.
- Review and save action fills the editable decision form. It does not publish content, approve claims, overwrite human edits, assign work or select report copy. Saving and report-copy confirmation remain explicit.
- Identical measurement evidence reuses its saved draft. Explicit Refresh suggested actions rechecks pages without repeating answer checks. New answers create a new draft. Completed, dismissed, suppressed and no-change findings are excluded from new action selection.
- The detailed evidence queue is collapsed below the first actions, with the report route still available.

## Verification

- 98 focused checks pass, including the existing onboarding, tour and report checks, plus new action validation, public-page reads, login interaction, editable draft handoff and PostgreSQL-compatible persistence tests.
- Persistence checks verify that human decisions, notes, owners and selected report copies survive regenerated action evidence, and that another project's answers cannot enter the draft.
- The broad suite has 288 passing checks and the same six previously documented failures. Its signup test now reads the extracted login script. It is not reported as fully passing.
- A live SkinCycles measurement completed 10 answer checks. The account used 20 of 40 checks after the run. Refreshing suggested actions used saved answers and did not consume additional answer checks.
- Live testing exposed generated quotations that did not match the stored passages, then an invalid JSON response. Drafting now selects original excerpt IDs and uses a strict output schema. The server rejects truncated responses and unsupported draft prices or calculated totals.
- A public-page excerpt check is not a full site audit. Blocked or unmatched pages produce a stated verification task rather than invented page findings.

The action feature adds no domain-data migration or new dependency. Deployment recovery adds a schema receipt table, described below.

## Final live result and deployment recovery

- Production `/api/version` served commit `9d623a6` at 14:57 UTC on 29 October 2026. The app loaded `app.js?v=131`.
- Version 4 action drafting completed with `stop_reason=end_turn`. Two SkinCycles actions passed original-passage validation. The new pricing draft failed the unsupported-figures check, fell back safely, and the existing human pricing decision remained visible.
- Review and save action opened the correct question and populated the editable decision fields. The anti-aging collection action was edited and saved as Needs investigation, with approved-product-fact checks and editorial FAQ questions. The saved copy was previewed and explicitly included in the client report. No assignment or external message was sent.
- A supplied Render build log showed a database connection closing while applying schema.sql. The failure was not an npm installation or JavaScript syntax error. `src/db/migrate.js` now applies the schema and its hash receipt in one transaction, retries transient connection/lock failures at most three times with a fresh client, limits lock waits and skips unchanged schema work. SQL and permission errors still fail the build.
- Four migration recovery tests pass. The complete schema applied once and skipped on repeat in PostgreSQL-compatible test storage. The transaction advisory lock was mocked in that storage test. Production subsequently deployed successfully.
- The migration receipt table is the only new infrastructure table. No authentication permissions or account plans changed.
