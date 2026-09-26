# Cited fixes, batch 1

Release `20260926-trust-1`. Prepared for manual GitHub upload. Not deployed.

## Included

- Correct the automatic source-analysis classification: pass a text kind, with safe rendering for older object-shaped data.
- Scope cached source advice by brand, domain, classification and interpretation version. Existing unscoped cached advice is no longer reused by this path.
- Pass the exact owned domain into analysis prompts; retain interpretation rules on model retry. Automatic analysis now recognises tracked competitor domains.
- Replace unsupported confidence presentation with an explicit interpretation label. Revise prompts and deterministic fallback copy to separate observations from possible causes and to check relevance.
- Remove unverified numerical demand claims from question rows, setup rows and generated briefs. Label existing demand-based sorting as unverified. Stored values and ranking calculations are unchanged.
- Correct raw-answer copy to describe provider/API measurements without claiming consumer-session equivalence.
- Correct brief input instructions and location grammar; distinguish brief generation date from measurement date. Absence of citations no longer implies the answer used training knowledge alone.
- Put the cycle in its analysis stage before source analysis begins. Replace contradictory first-run empty-state messaging while it is running.
- Send newly created sites to Questions for review and offer a direct link to manage their question set.
- Add a frontend cache-busting URL and a server release marker.
- Add nine read-only regression checks and update two existing tests that enforced the old copy.

## Verification

- New targeted regression suite: 9 passed, 0 failed.
- Existing suite before changes: 287 passed, 6 failed.
- Existing suite after changes: 287 passed, the same 6 failures. No new failures.
- JavaScript syntax checks and git diff whitespace checks passed.
- Protected detection, demand-matching, provider/model selection, pricing, scoring, prompt generation, recommendation rules and database-schema files match the baseline exactly.
- Tests used a dummy database address, mock mode and stubs. The new tests explicitly reject real network access and replace database operations with test doubles.
- New production behaviour has not been tested on Render. Full visual/browser validation of this release remains a post-deployment step.

Existing failing test names:
1. the report is offered like a deliverable, and never hidden
2. a rejected request is not blamed on the provider
3. demand and visibility sit beside each other, never summed
4. figures a client might screenshot explain themselves
5. the cited-page sample says how it was gathered
6. the report is readable without the app

## Impact and limits

No database migration, model change, new dependency, measurement recount or new external integration.
The analysis cache version changes: the next analysis of a page may make the existing provider calls again instead of using old cached advice. Model and token caps are unchanged; prompt text is slightly longer. Once refreshed, matching context is cached normally. This is not a claim that analysis is free.

Identity and relevance prompts improve guidance but cannot guarantee a model never makes a naming error. The automatic recommendation rules and already stored task text are not rewritten in this batch. The wider five-destination navigation, page-level source drill-down, question-quality validation, verified demand ingestion and overall dashboard redesign remain later work.

## Local verification commands

Run from the repository root with Node 20 or newer and dependencies installed:

```bash
node --test scripts/test-first-use-fixes.js
DATABASE_URL=postgres://test:test@127.0.0.1:1/cited_test MOCK_MODE=true node scripts/test.js
```

The second command currently exits nonzero because of the six recorded baseline failures. Do not substitute a production database connection.
