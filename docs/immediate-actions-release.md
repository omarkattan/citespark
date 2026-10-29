# Specific first-run actions

Goal: a new user can sign in, add a site, review questions, run a measurement and receive specific, editable next actions without having to write a recommendation from scratch.

## Behaviour

- Sign-in and signup use a native form, password-manager attributes, a show-password control, explicit password requirements and guarded submissions. Registration and verification errors remain retryable. Email verification is still required before spending answer checks.
- Every completed measurement uses the existing recommendation builder to prepare up to three action drafts automatically. Existing measurements can use Prepare my actions without repeating the answer checks.
- Pricing, comparison and selection questions are prioritised using an editorial heuristic. This is not measured demand or an impact estimate.
- The app reads the homepage and at most three relevant, observed internal links. Public HTTPS reads are bounded, DNS addresses are checked and pinned, redirects remain on the owned domain, and blocked pages are not bypassed.
- One bounded drafting call uses the measured answers and fetched page excerpts. The model selects supplied excerpt IDs. The server copies the original passages, and validates the page/answer references. Invented references fall back to a specific conditional check.
- Each card supplies the question, proposed change, page where verified, reason, supporting answer and page passages, and suggested on-page questions. Adequate existing content can be retained. No gap is inferred solely from a missed mention.
- Review and save action fills the editable decision form. It does not publish content, approve claims, overwrite human edits, assign work or select report copy. Saving and report-copy confirmation remain explicit.
- Identical measurement evidence reuses its saved draft. Explicit Refresh suggested actions rechecks pages without repeating answer checks. New answers create a new draft. Completed, dismissed, suppressed and no-change findings are excluded from new action selection.
- The detailed evidence queue is collapsed below the first actions, with the report route still available.

## Verification

- 96 focused checks pass, including the existing onboarding, tour and report checks, plus new action validation, public-page reads, login interaction, editable draft handoff and PostgreSQL-compatible persistence tests.
- Persistence checks verify that human decisions, notes, owners and selected report copies survive regenerated action evidence, and that another project's answers cannot enter the draft.
- The broad suite has 288 passing checks and the same six previously documented failures. Its signup test now reads the extracted login script. It is not reported as fully passing.
- Live verification is recorded after deployment. A public-page excerpt check is not a full site audit. Blocked or unmatched pages produce a stated verification task rather than invented page findings.

No database migration, new dependency, authentication permission change or plan change is required.
