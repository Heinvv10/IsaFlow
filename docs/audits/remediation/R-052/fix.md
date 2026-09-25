# R-052 — GitHub ran 5 of run-ci.sh's gates, so a PR could merge green while failing the rest

**Status:** fix-in-review. **Base:** origin/master `0ecf6d06e`.

## Measured

The register title says "eleven of sixteen". That was counted before oauth-trust-flags existed. On
`0ecf6d06e`, `scripts/ci/run-ci.sh` has 17 gates. This PR adds two more (`no-bunfig` and `workflow-runs-ci`), so it has 19.
`.github/workflows/ci.yml`'s `quality` job listed 5 of them by hand:
- agent-docs
- type-check
- lint
- user-id-casts
- unit-tests

The other 12 never ran on GitHub:
- security-guards
- is-active-filters
- raw-transactions
- vat-guard-coverage
- self-defining-universe
- findings-numbering
- migration-rls
- oauth-trust-flags
- component-tests
- migration-naming
- build
- integration-tests (gated on `DATABASE_URL`)

`red.log` has the proof. Draft PR #521 was master plus one file that fails `is-active-filters`
locally. On GitHub every job passed and `mergeStateStatus` was `CLEAN`.

## Fix

- **The `quality` job runs `bun run ci`.** run-ci.sh is now the only place the gate list lives. It
  runs every gate, names each failure and exits non-zero. The job now includes the production build. It
  measured 8m13s, so the timeout is 30 minutes (`green.log`).
- **A new gate, `workflow-runs-ci`.** It is `scripts/ci/check-workflow-runs-ci.ts`, with the rule in
  `workflowRunsCiRule.ts`. It parses ci.yml and requires one exact shape:
  - **Triggers:** `on.push` and `on.pull_request` have branches exactly `[master]`, with no paths or
    types filter. A later `'!master'` would exclude master again.
  - **Top level:** no workflow-level `env` or `defaults`.
  - **The `quality` job** has only `name`, `runs-on`, `timeout-minutes` and `steps`. So there is no
    job-level `if`, `continue-on-error`, `env`, `defaults` or `strategy`. `runs-on` is exactly
    `[self-hosted, linux, velo]`: an unknown label queues forever and never goes red.
    `timeout-minutes` must be an integer of at least 20. The workflow's `concurrency` is pinned to
    exactly `ci-${{ github.ref }}` with `cancel-in-progress: true`. A timeout too short to finish, or
    a group shared across refs, ends the check cancelled rather than red, and this repo has merged
    on cancelled checks.
  - **The workflow set is fixed.** `ci.yml` is the only file under `.github/workflows/`. Its jobs are
    exactly `quality` and `golden-paths`, and golden-paths keeps its own group:
    `golden-paths-dev-demo`, no cancel. Concurrency groups are repo-wide, so any other workflow or job
    that took the `ci-` group would cancel quality. Adding a workflow or a job means changing the rule
    in review.
  - **Steps:** exactly three:
    1. checkout, with no `with`;
    2. `bun install --frozen-lockfile --ignore-scripts`. Without the flag, bun runs the lifecycle
       scripts of the root, of any workspace member and of any trusted dependency, and any of them
       can rewrite run-ci.sh before the gate. The flag closes that whole class. Refusing scripts one
       name at a time would not;
    3. `bun run ci`, with only `name` and an env limited to `DATABASE_URL`, `JWT_SECRET` and
       `NODE_ENV`.
  - **package.json:** `scripts.ci` is exactly `bash scripts/ci/run-ci.sh`. No script name may start
    with `pre` or `post`, except the existing `prepare`. Bun runs `preX` and `postX` around every
    `bun run X`, and run-ci.sh calls type-check, lint, test:unit, build and others that way, so a
    `pretype-check` could defuse every later gate. The prefix is refused wholesale rather than hook by
    hook.

  Anything else is refused, and changing the job means changing the rule in the same PR. The first
  version grepped for the line instead. Blind review got nine edits past that grep. It then got the
  job green through lifecycle scripts (root, workspace member, trusted dependency), through a
  `pre<script>` hook on a nested `bun run`, through
  `branches: [master, '!master']` and through an unknown `runs-on` label. Every one of them
  is a case in `tests/unit/ci/workflowRunsCiRule.test.ts`, and each is refused.
- `js-yaml` 4.1.1 was already in the lockfile, pulled in through `@eslint/eslintrc`. It is now a
  declared devDependency, so the gate doesn't rest on a transitive dependency.
- The user-id-casts rationale moved from ci.yml to run-ci.sh, next to its gate. The root CLAUDE.md
  now says to add gates only to run-ci.sh.

## Proof

- `mutations.log`: each clause of the rule, disabled alone, fails at least one bypass case.
- `green.log` holds both GitHub runs:
  - **#525 at `3c46f3507`:** all 18 non-skipped gates run on the runner and pass (integration-tests is skipped, as below), the build included, installed
    with `--ignore-scripts`, in 8m13s.
  - **Canary #526:** #521's file on top of this branch. The quality job fails on exactly
    `is-active-filters` (`[ci] FAILED: is-active-filters`), and every other gate passes.
  - The Golden Paths "fail" on both is a cancellation from its own concurrency group, not a failure.
- The final head's run is recorded as a comment on #525.

## Residuals — for Hein

1. **A red check does not block a merge (the main residual).** The repo has no branch protection and
   no required status checks. `GET .../branches/master/protection` and `/rulesets` both return 403
   "Upgrade to GitHub Pro or make this repository public". PR #496 merged with "Type Check, Lint &
   Test" FAILED, and #454, #473, #474 and #506 merged with Golden Paths CANCELLED. This fix turns "a
   PR merges green while failing gates" into "a PR shows red while failing gates". It cannot make red
   block the merge. Closing that takes one of:
   - a paid GitHub plan (Pro or Team) with a required check on "Type Check, Lint & Test";
   - a public repository;
   - a merge convention that checks the head's run first. `gh pr checks` must be all-pass before
     `gh pr merge --match-head-commit`.
2. **The gate on GitHub checks itself.** It runs inside the workflow it checks. An edit that stops
   the workflow running also stops the check. Its real enforcement is the local `bun run ci` and the
   pre-push hook, and `SKIP_CI=1` bypasses the hook.
3. **Integration tests still do not run on GitHub.** run-ci.sh runs them only when `DATABASE_URL` is
   non-empty, and the repo secret is empty. They need:
   - a disposable Postgres with the full schema;
   - five more variables;
   - a serial run.

   The shared fixture `isaflow_schema_fixture` is used by parallel sessions, so pointing the runner
   at it would add a writer. A per-run database is an infrastructure decision.
4. **run-ci.sh and the bodies of the package scripts it calls are not guarded.** Examples are
   `"lint": "true"`, or a gate script rewritten to exit 0. So is a `patchedDependencies` entry in
   package.json with its `patches/` file, which bun applies at install even with `--ignore-scripts`,
   so a patched tsc, eslint or vitest could exit 0. An edit to any of these that drops or skips a
   gate is left to code review.
5. **The runner is persistent and trusts itself.** IsaFlow has one self-hosted runner
   (`velo-server-u`, user `gha-isaflow`). That user owns `~/.bun/bin`. Any job that runs there, such
   as `golden-paths` (which still installs with scripts) or another workflow file, could replace `bun` with a binary that exits 0, and
   the replacement would stay for every later run. The rule only constrains `jobs.quality`. Closing
   this needs one of:
   - an ephemeral runner;
   - a quality job that checks bun against a pinned hash.

   Both are infrastructure decisions.
6. **A `bunfig.toml` `preload`** runs before every bun process, so it could exit 0 ahead of each gate.
   A new first gate refuses it: `no-bunfig`, a bash `test ! -e bunfig.toml` in run-ci.sh, which bun
   cannot preload into.

## Historical impact

Every PR merged on a green GitHub check was checked by 5 gates only. #525's run is master plus this
change. The 16 of master's 17 gates that can run without a database all pass there, so nothing merged unchecked is failing a gate today.
