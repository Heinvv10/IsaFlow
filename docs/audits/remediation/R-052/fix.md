# R-052 — GitHub ran 5 of run-ci.sh's gates, so a PR could merge green while failing the rest

**Status:** fix-in-review. **Base:** origin/master `0ecf6d06e`.

## Measured

`scripts/ci/run-ci.sh` runs 17 gates. `.github/workflows/ci.yml`'s `quality` job listed 5 of them by
hand:
- agent-docs
- type-check
- lint
- user-id-casts
- unit-tests

`red.log` has the proof. Draft PR #521 is master plus one file that fails `is-active-filters` locally.
On GitHub it was **green on every job and `mergeStateStatus: CLEAN`**. The same held for every other
gate added to run-ci.sh after the job was written: security-guards, raw-transactions,
vat-guard-coverage, self-defining-universe, findings-numbering, migration-rls, oauth-trust-flags,
component-tests, migration-naming and the production build.

## Fix

- **The `quality` job runs `bun run ci`**, so run-ci.sh is the only place the gate list lives.
  run-ci.sh runs every gate, names each failure and exits non-zero. The timeout goes from 15 to 45
  minutes because the job now includes the production build.
- **A new gate, `workflow-runs-ci`** (`scripts/ci/check-workflow-runs-ci.sh`), refuses a workflow in
  three cases:
  - it no longer has a step that runs exactly `bun run ci`, for example one that went back to a
    hand-kept list, or wrapped the call in `|| true`;
  - it sets `continue-on-error`;
  - it is missing.

  The gate runs locally and in the pre-push hook, which is where workflow edits are made.
  `mutations.log` shows all four refusals.
- The user-id-casts rationale comment moved from ci.yml to run-ci.sh, next to its gate. The root
  CLAUDE.md now says to add gates to run-ci.sh only.

## Proof on GitHub

- **This PR's own run** is the green half: every gate runs and passes on the runner.
- **The canary rebased onto this branch** is the red half: `tmp/r052-canary-green` must fail the
  quality job on `is-active-filters`. Its run is recorded in `green.log`.

## Residual: integration tests still do not run on GitHub

run-ci.sh runs them only when `DATABASE_URL` is non-empty, and the repo secret is empty. They need
a disposable Postgres with the full schema and five more variables (JWT_SECRET, GOTRUE_URL,
SUPABASE_SERVICE_ROLE_KEY, PLATFORM_ADMIN_DATABASE_URL, MIGRATION_ADMIN_DATABASE_URL). They also
need to run serially (`--no-file-parallelism`). The shared fixture `isaflow_schema_fixture` is
already used by parallel agent sessions, so pointing the runner at it would add a writer to it.
Provisioning a per-run database is an infrastructure decision for Hein, not part of this fix. Until
then, integration tests are enforced only by `bun run ci` run locally with a fixture exported.

## Historical impact

Any PR merged on a green GitHub check was checked by 5 gates only. Master's state today is
established by this PR's own run: if a gate fails on master, it shows up here.
