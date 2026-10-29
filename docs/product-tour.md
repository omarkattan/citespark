# Product tour

New registrations start with `users.product_tour_status = 'pending'`. The app opens an eight-step tour after normal startup. Existing accounts default to `not_required` and can start the tour with **Take a tour** beside the logo.

The tour covers the workflow from adding a site through questions, measurements, evidence, actions and report preparation. It preserves the current view and unsaved form values. It does not run measurements or connect sources. With no site, the final button opens the Add site form.

## Persistence and controls

- Back, Next, Skip, Close and Escape are supported. Focus returns to the previous control after dismissal.
- `POST /api/product-tour` accepts only `skipped` or `completed` for the authenticated user. It requires a JSON body.
- The server stores dismissal across devices. Local storage, keyed by user ID, retains unfinished progress in the same browser and retries a saved dismissal on the next load if the server still reports `pending`.
- Manual replay starts at step one. Automatic startup does not interrupt an OAuth return or an existing modal.
- No production dependencies or environment variables are added.

## Deployment

Apply `npm run migrate` before starting the updated server. The existing Render build command, `npm ci && npm run migrate`, already does this. Do not deploy the server without this migration.

`src/db/schema.sql` adds the preference column without removing data. The migration is repeatable. Rollback can restore the prior runtime files and leave the unused column in place.

## Validation

33 focused checks passed, including complete app startup with no sites, replay, draft preservation, focus handling, user isolation and the migration. Syntax checks and `git diff --check` passed. The broad suite has 288 passing checks and six existing failures also present in the original repository. These concern report selectors, traffic wording, trial wording, scheduling expectations, city validation and city coverage wording.

Local checks used Node 24.22.1. The repository pins Node 26.12.1 through 26.x. Verify the deployment on that runtime. Local browser preview access was blocked, so the local checks do not constitute real-browser visual validation.

Run focused tests from the repository root with isolated test dependencies:

```sh
tour_test_deps="$(mktemp -d)"
npm install --prefix "$tour_test_deps" --no-audit --no-fund jsdom@30.1.3 @electric-sql/pglite@0.5.13
JSDOM_MODULE="$tour_test_deps/node_modules/jsdom/lib/api.js" \
PGLITE_MODULE="$tour_test_deps/node_modules/@electric-sql/pglite/dist/index.js" \
node --test scripts/test-product-tour.js scripts/test-product-tour-store.js \
  scripts/test-onboarding-review.js scripts/test-question-evidence-ux.js \
  scripts/test-report-refinement.js scripts/test-report-question-summary.js \
  scripts/test-question-quality.js
```

After deployment, check automatic onboarding with a new account, manual replay with an existing account, dismissal persistence and the final Add site button. Check desktop, mobile and keyboard use, and confirm replay preserves a draft.
