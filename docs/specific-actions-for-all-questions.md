# Specific actions for every eligible question, 30 October 2026

The previous release expanded every saved action into a card, but the analysis still selected only three questions. The remaining cards therefore displayed generic review guidance. This release removes that analysis cap. Three is now the maximum number of questions in one drafting request, not the total number analysed.

Each eligible measured question receives the same answer-and-page review: a specific proposed edit, conditional check or retain decision, relevant page where available, exact stored-answer and website excerpts, suggested questions, completion checks and FAQ drafting entry point. One primary analysis is prepared per eligible question. Other source, comparison and analytics reviews retain their own evidence workflow. Missing visibility alone is never treated as a proven content gap.

Preparation runs sequentially in small batches. Relevant pages are selected for each batch, public website reads are reused within the job, and each completed batch is saved, including new recommendation rows. Retries reuse successful plans for unchanged answer evidence. Invalid or failed drafts are retryable. Partial results are not silently labelled complete.

The authenticated preparation request returns immediately and exposes progress. Concurrent starts for the same project reuse the active job. Reopening the site resumes progress observation. After a process interruption, the user can explicitly continue from saved batches. No paid retry is automatic. Each drafting request retains its existing usage and cost record. Answer checks are not repeated. New preparation requires the same email-verification eligibility as drafting elsewhere in Cited.

Cards distinguish **Not analysed yet**, **Analysis incomplete**, **Specific check**, **Suggested edit** and **Keep and check**. Saved human review decisions remain visible and are never automatically promoted to ready. Failed analysis explains that the page review did not finish. Existing notes, owners, statuses, approved FAQ content and report copies are retained.

Validation: 36 focused tests cover all-question batching, exact source references, invalid claims, partial-save recovery, caching, failed-batch retries, progress, duplicate starts, project access, email verification, expanded cards, unsaved edits and report preservation. JavaScript syntax checks also pass. No new dependencies or schema migration.
