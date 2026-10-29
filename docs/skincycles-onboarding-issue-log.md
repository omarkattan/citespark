# SkinCycles fresh-account journey: issue log

Test target: skincycles.com

Goal: a simple guided path from a brand-new account to useful recommendations and a report, with one clear next step at each stage.

Baseline: Cited main commit c19d7e5c1b3341af932942a0befa98b9fd277088. That release adds the introductory tour and the persistent Take a tour button. This audit tests the working setup journey beyond the tour.

## Current position

- Opened the live Cited homepage and selected Start free.
- Selected Create an account instead on the resulting sign-in page.
- Entered SkinCycles UX test as the company name.
- Handed signup to Omar for new credential entry and submission, as required by the browser's account-creation rules.
- Account creation succeeded. Omar supplied screenshots confirming delivery of both the admin signup notification and the customer verification email, then confirmed verification and sign-in. Do not store the verification token or credentials in this log.
- The fresh account automatically opened the welcome tour. All eight steps led to Add my first site, which opened the site form and saved tour completion successfully.
- Scanned skincycles.com, reviewed the suggested brand details and created project 39 on the normal Free plan. Retained the suggested UK market and whole-country location. Revised the suggested audience to avoid an unsupported occupation restriction.
- Continued without optional Google connections, reviewed ten generated questions and completed the first measurement. Ten ChatGPT answers, one per question, recorded no brand mentions. The displayed actual cost was $0.13 and ten of forty monthly checks were used. This is one small tracked sample, not a market-wide visibility score.

## Confirmed product issues

| ID | Stage | Observation and reproduction | User impact | Proposed fix | Status and retest |
| --- | --- | --- | --- | --- | --- |
| UX-001 | Homepage to signup | On https://cited.ae/, the Free plan's Start free link opens https://cited.ae/login with Sign in as the heading and submit action. Creating an account requires selecting the secondary Create an account instead link. Observed in the live browser. | A new user chooses to start but lands in the returning-user flow. The next action is less clear and requires an extra step. | Make Start free open registration directly, keeping Sign in as a clear secondary option. Preserve any demo context through signup. | Confirmed. Not yet fixed. Retest from a fresh signup session, plus returning-user sign-in and demo handoff. |
| UX-002 | Website scan | The audience suggestion was "uk modern professionals seeking advanced serums and treatments". The homepage sells consumer skincare across concerns and does not establish that occupation restriction. | A narrow invented audience can distort the generated question set. | Tell discovery to use supported audience details, with consumer examples, and avoid invented occupations or demographic restrictions. Keep review explicit. | Observed. Audience corrected for this test. Generator fix pending. |
| UX-003 | Add site | A first-time user sees brand-matching rules and a Google-specific location control before creating a Free-plan site. The UK dropdown contains thousands of entries, with a group named Emirates and provinces. | Advanced controls distract from the basic domain-to-questions task. | Put optional brand matching and detailed Google location under advanced settings, retain a verified country default, use geographic labels appropriate to the selected market and surface any blocking error clearly. | Confirmed in the live form. Not yet fixed. |
| UX-004 | Connections | Continue to questions, Connect later and Review questions all lead forward from the same screen. | Competing instructions make a simple optional step feel like several separate decisions. | One clear Continue to questions CTA with a short explanation that connections can be added later. | Confirmed. Connect later successfully advanced. Fix pending. |
| UX-005 | Questions | Four of ten generated suggestions are keyword-style fragments, including "Best skincare routine for sensitive and dry skin" and "Premium skincare brands for mature skin in the UK". | The question list mixes conversational questions and search fragments without asking the user to review that distinction. | Apply the existing natural-question validation to site-generated questions, preserve genuine fallback questions and add clear review guidance. Do not relabel these suggestions as observed demand. | Confirmed. Generated questions retained for baseline testing. Fix pending. |
| UX-006 | Verification while setting up | Omar confirmed verification, but the already-open app still shows Confirm your email and its Run control still carries the unverified tooltip. Code checks verification only at initial boot for this control. | A customer can follow the email instructions and still appear blocked on returning to setup. | Recheck verification when returning to the app and before starting a measurement, without reloading or losing drafts. | Confirmed: reload cleared the banner and unverified Run tooltip. The server had recorded confirmation but the app had not refreshed it. |
| UX-007 | Guidance to the final output | Current setup navigation ends at First measurement. Code marks setup complete as soon as answers exist, removing the guide. | The journey stops before the requested recommendations and report, leaving a novice to choose the next section. | Extend persistent guidance through reviewing recommendations and preparing the report, with a clear current step and one main next action. | Confirmed live: the guide disappeared after the run and the user landed on Overview with zero actions. |

| UX-008 | First measurement | Next: review first measurement opens full settings, including competitors and Remove this site. | The user must navigate unrelated controls to start the first check. | A dedicated short measurement summary with an explicit cost review. | Implemented locally. Live retest pending. |
| UX-009 | Run confirmation | All ten questions are new, but the modal presents both Run active questions and Run only questions never asked for identical samples and prices. | Two indistinguishable choices add doubt. | Show one action when all questions are new. Keep the second option only for a mixed question set. | Implemented locally. DOM interaction tests pass. |
| UX-010 | Recommendations | Ten successful Free-plan answers produced zero actions. The missing-mention rule requires at least two answers per question, while Free runs one. | A first-time user gets no question reviews or usable next step. | Produce a clearly labelled preliminary review from one successful answer. Preserve its sample size and run evidence. Do not call this a proven content gap or reliable absence rate. Provide recovery from saved answers. | Root cause confirmed in rules. New rule tests pass for one and zero answers. Live recovery pending. |
| UX-011 | Empty opportunities | With no actions, the page says No tasks match this focus and asks the user to change filters. | The explanation does not match an entirely empty result set. | Distinguish no reviews yet from filtered-out reviews and offer Prepare reviews from saved answers. | Implemented locally. Live retest pending. |
| UX-012 | Report preparation | The first report page starts with dates and optional AI analysis, then saving, Google-source warnings and finally two empty recommendation sections. | The user encounters optional work before the report's core content, without a direct route to a recommendation. | Put Choose recommendations, Preview, Save and download in order. Collapse optional evidence and analysis. Link empty states directly to this project's Opportunities. | Implemented locally. DOM order, empty-state links and existing preview/save protections pass. |
| UX-013 | Running state | The guide still offers Review cost and run while the top run control says Running. | Competing states suggest a second run is possible. | Replace the guide action with Measurement in progress and block duplicate modal launch. | Implemented locally. Running-state test passes. |

| UX-014 | Open a recommendation | A question with exactly one saved check requires opening the question group, then opening its only task. Reproduced on the pricing question. | A redundant disclosure delays access to evidence. | Open the single inner task automatically when its question is opened. | Follow-up implemented and covered by interaction tests. Live verification pending. |
| UX-015 | Answer to report decision | Record your review conclusion opens freeform notes, while a separate Record or update decision form stores the structured report recommendation. After saving that decision, the report preview sits below the long answer. | Two overlapping recording paths and a distant next step obscure the delivery flow. | Route the answer CTA to the structured decision, call the older route Review notes, and show Preview for client report beside the saved-decision confirmation. | Follow-up implemented and covered by interaction tests. Live verification pending. |

## Test constraints, separate from product issues

| ID | Constraint | Effect |
| --- | --- | --- |
| TEST-001 | Browser security requires manual handoff for creating a new account and entering new credentials. | Resolved: Omar completed signup. This was an agent testing constraint, not evidence of a Cited product defect. |
| TEST-002 | Omar reported the handoff error "browser tab no longer available". The original signup tab remained visible to the agent, but renewing its handoff did not restore user access. | Resolved after opening a fresh signup tab. Omar completed verification and sign-in. This was a shared-browser access blocker, not a confirmed Cited signup defect. |

## Fixes and validation

UX-001 through UX-013 have local implementations. Earlier statuses in the observation table describe the baseline; live release validation is recorded below.

Implemented in the application, generation rules and report preparation. Initial local validation: 57 focused checks pass, covering the real app boot and resumed project screens, tour persistence, saved progress, failed saves, first-run choices, email refresh, question filtering, preliminary reviews and report preparation. Tests use mocked provider responses and local PostgreSQL-compatible storage, not paid live requests.

The broad suite remains at 288 passing checks and six pre-existing failures reproduced before this task. Additional legacy browser unit tests have stale/missing harness dependencies reproduced against the unchanged baseline. These are not described as passing. Local runtime is Node 24.22.1; the repository requests Node 26.12.1 or later within 26.x.

| Stage | Baseline result | Post-fix verification |
| --- | --- | --- |
| Signup and email | Account created and both emails delivered. User confirmed address. Existing-tab status was stale until reload. | Direct signup link and refresh behaviour covered locally. Live retest pending. |
| Tour | All eight steps worked, Add my first site opened the real form, completion survived reload. | Existing tour tests pass. |
| Site setup | Project created with optional sources skipped. Audience and advanced controls needed correction. | Advanced controls moved, discovery prompt corrected. Live UI retest pending. |
| Questions | Ten generated suggestions, four fragments. Kept unchanged for baseline measurement. | Filter rejects fragments/brand prompts/duplicates and reports partial suggestion sets. Live generation retest pending. |
| Measurement | Ten successful answers, zero mentions, ten checks used. Full settings and duplicate confirmation choices were confusing. | Dedicated summary and single first-run action pass interaction tests. |
| Recommendations | Zero reviews due to two-answer threshold. Empty-state advice was misleading. | Preliminary rule and no-extra-check recovery tested locally. Live recovery pending. |
| Report | Preparation reached, no recommendations available. | Three delivery steps and direct empty-state links tested. Live snapshot/export pending. |
| Resume | Tour completion persisted. Setup guide ended before recommendations. | Measured projects resume recommendations or the saved report step. Existing completed projects remain complete. |
| Accessibility | Live desktop path exercised. | Native buttons/dialogs and existing focus tests pass. Full responsive visual audit remains pending. |

## Changed files

- `src/public/app.js`: six-step guidance, first measurement, verification refresh, empty-state recovery, preliminary review wording.
- `src/public/index.html`: simpler site form and cache version.
- `src/public/landing.html`: Start free opens signup.
- `src/server.js`: initialize and persist the extended journey and explain partial suggestion sets.
- `src/lib/discover.js`: evidence-bound customer descriptions.
- `src/lib/prompts.js`: conversational question validation and less service-specific fallback wording.
- `src/lib/recommend.js`: first-sample evidence reviews.
- `src/lib/report-preparation.js`: ordered report delivery steps and optional secondary sections.
- `scripts/test-first-report-journey.js`, `scripts/test-first-report-store.js`, `scripts/test-report-preparation.js`: regression coverage.

## Logging and release rules

Record each observed problem before changing it. Add the exact step, reproduction, expected behaviour, actual behaviour, severity, proposed fix, affected files or commit, and retest evidence as available. Label code-review concerns separately until reproduced. Do not treat an untested stage as a pass.

Maintain a short record of the measurements actually run and their limits. Do not fabricate successful runs, recommendations or report outputs. Retest the completed journey after fixes and distinguish remaining blockers from resolved issues.

## Live release check

Commit 1591f76ce6387275dc827b6b2c70b125fc331c9c is live. Reloading project 39 resumes Step 5 of 6. Prepare reviews from saved answers created ten preliminary question reviews, retaining the one-answer limitation and leaving the account at 10/40 checks. The pricing question’s answer was opened and a structured investigation decision was saved with three explicit editorial FAQ suggestions. These suggestions are not labelled as observed search demand. Report inclusion and fixed-version checks continue below.
