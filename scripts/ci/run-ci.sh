#!/usr/bin/env bash
# Run all CI checks, collect failures, exit non-zero if any failed.
# Reports every failure rather than aborting at the first one — devs see
# the full picture in a single run.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

# Gate groups. The gate list stays in this one file (R-052); ci.yml runs it in
# two pieces on two kinds of runner and its "Type Check, Lint & Test" job
# passes only when both pieces passed:
#   static  needs nothing from velo (no database, no runner-local file, no
#           Chromium): GitHub-hosted runners.
#   velo    browser-tests (real Chromium and pinned text metrics, known to
#           pass on velo and not tried on hosted runners) and
#           integration (throwaway PostgreSQL 16 clusters from velo's
#           postgresql-16 packages): the self-hosted runners.
#   all     both, in order: the default, and what the pre-push hook runs.
#   bun run ci [all|static|velo]
GROUP="${1:-all}"
case "$GROUP" in
  all|static|velo) ;;
  *) echo "usage: run-ci.sh [all|static|velo] (got: $GROUP)" >&2; exit 2 ;;
esac
in_group() { [ "$GROUP" = all ] || [ "$GROUP" = "$1" ]; }
echo "[ci] gate group: $GROUP"

declare -a FAILED=()
INTEGRATION_NOTE=""

run_step() {
  local name="$1"; shift
  echo ""
  echo "=== [ci] $name ==="
  if "$@"; then
    echo "[ci] $name PASS"
  else
    echo "[ci] $name FAIL"
    FAILED+=("$name")
  fi
}

# Velo froze on 27 Oct 2026 when memory and swap ran out; its rule
# (/home/hein/AGENTS-VELO-RULES.md) is that Chromium and `next build` outside CI
# run through agent-run, a systemd-run --user --scope into agents.slice (24G
# hard cap). So the local run (and the pre-push hook) wraps those two steps
# when agent-run is installed, and runs them unchanged anywhere else. Not on
# GitHub (GITHUB_ACTIONS/CI=true): the self-hosted runners are system services
# whose users have no systemd user session, so `systemd-run --user` would fail
# every run there. CI_NO_AGENT_RUN=1 opts out. agent-run execs systemd-run
# --scope, which runs the command in this environment and cwd and returns its
# exit code, so a failing step still fails. AGENT_RUN_BIN is for the tests.
AGENT_RUN_BIN="${AGENT_RUN_BIN:-/usr/local/bin/agent-run}"
capped() {
  if [ "${GITHUB_ACTIONS:-}" != "true" ] && [ "${CI:-}" != "true" ] \
    && [ "${CI_NO_AGENT_RUN:-}" != "1" ] && [ -x "$AGENT_RUN_BIN" ]; then
    "$AGENT_RUN_BIN" "$@"
    local rc=$?
    # agent-run also fails when there is no systemd user session (cron, a bare
    # ssh shell without linger); that would read like a test failure.
    [ "$rc" -eq 0 ] || echo "[ci] note: this step ran through $AGENT_RUN_BIN; if it failed before the command started (no systemd user session), re-run with CI_NO_AGENT_RUN=1" >&2
    return "$rc"
  else
    "$@"
  fi
}

# A bunfig.toml `preload` runs before every bun process, so one that calls
# process.exit(0) would pass every gate below that runs under bun, the
# workflow-runs-ci check included. Checked in bash for that reason; the repo
# has no bunfig.toml, and adding one means changing this line in review (R-052).
run_step "no-bunfig"         test ! -e bunfig.toml

# A push to master that is a merge-queue merge of a PR head whose tree already
# passed both required checks as a pull_request run is not tested twice
# (scripts/ci/mq-merge-already-tested.ts: exit 10 skips, anything else, a crash
# included, runs every gate; it prints why). Only on GitHub, only on push, and
# only after no-bunfig passed (a preload could fake the exit code).
if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ "${GITHUB_EVENT_NAME:-}" = "push" ] && [ "${#FAILED[@]}" -eq 0 ]; then
  echo ""
  mq_rc=0
  bun scripts/ci/mq-merge-already-tested.ts || mq_rc=$?
  if [ "$mq_rc" -eq 10 ]; then
    echo "[ci] all checks skipped: this exact tree already passed them as a pull_request run (see [mq-merge] above)"
    exit 0
  fi
fi
# Only the merge check needs the API token: drop it from the environment of
# every gate below (PR-authored tests included). ci.yml's checkouts set
# persist-credentials: false, so it is not in .git/config either.
unset CI_READ_TOKEN
if in_group static; then
run_step "type-check"        bun run type-check
# `tsconfig.json` excludes `tests/**`, so a FIXTURE may omit a required field
# of the model it claims to be and neither `tsc --noEmit` nor vitest notices.
# It is not hypothetical: `PackMatter.kind` was missing from every matter in
# `boardPackInputs`, and page 11 of the demo pack composed the headline
# "0 matters require a board decision this period. Every check ran clean."
# over a table listing one matter and 245 of exposure. This narrows the check
# to the pack fixtures — the composed documents every pack test is written
# against — without pulling the rest of `tests/**` into the program.
run_step "pack-fixture-types" bun run type-check:pack-fixtures
# R-183: tests/** is outside tsconfig and vitest strips `import type`, so the type half of the
# paystackClient export pin is only enforced by compiling that one test file.
run_step "paystack-export-types" bun run type-check:paystack-exports
# scripts/** is outside tsconfig.json, so the integration gate's own TypeScript
# (and the test helpers it relies on) is compiled here.
run_step "ci-script-types"   bun run type-check:ci-scripts
run_step "lint"              bun run lint
# The raw-input allowlist (eslint/raw-input-allowlist.json) only shrinks: an entry whose file no
# longer violates the kit-form rule fails here, so fixing a form removes it from the list.
run_step "raw-input-allowlist" bun scripts/ci/check-raw-input-allowlist.ts
# Raw muted text greys (text-gray/slate-400/500) are what styles/themeContrast.css exists to paper
# over; their count may only fall (scripts/ci/raw-muted-text-stops.baseline.json).
run_step "raw-muted-text-stops" bun scripts/ci/check-raw-muted-text-stops.ts
run_step "agent-docs"        bun run agent-docs:check
run_step "security-guards"   bash scripts/ci/check-internal-apis.sh
# User identity is a string in this schema (users.id varchar,
# company_users.user_id text). A ::UUID cast on either throws at RUNTIME, not
# compile time, because the SQL is a template string — so neither the type
# check nor the lint can see it. 16 such sites once shipped.
run_step "user-id-casts"     bun scripts/ci/audit-user-id-casts.ts
# Passes today against a baseline of the 13 known files; fails only on a NEW
# one, so the in-flight sweep is not blocked and no new offender can land.
run_step "is-active-filters"  bash scripts/ci/check-is-active-in-balances.sh
run_step "raw-transactions"     bun scripts/ci/check-raw-transaction-control.ts
# Four separate code paths posted a VAT claim nobody reviewed, each found by a
# different accident. This is the search that would have found all four at once.
run_step "vat-guard-coverage"   bun scripts/ci/check-vat-guard-coverage.ts
run_step "self-defining-universe" bash scripts/ci/check-self-defining-universe.sh
run_step "findings-numbering"     bash scripts/ci/check-findings-numbering.sh
run_step "migration-rls"          bun scripts/ci/check-migration-rls.ts
# The oauth_apps trust flags decide whether an app may brand the consent
# screen. Migration 693 makes them unwritable; the other guard on that is an
# integration test, which runs only on GitHub or with CI_INTEGRATION=1, so a
# change that undid 693 could pass a local run. Text-only, so it runs every time.
run_step "oauth-trust-flags"      bun scripts/ci/check-oauth-trust-flags.ts
# GitHub's CI job must call this script, not a hand-kept copy of its list
# (R-052: GitHub ran 5 of these gates while a PR showed green).
run_step "workflow-runs-ci"       bun scripts/ci/check-workflow-runs-ci.ts
# Client code must read the HTTP status before a response body, say what failed
# in a plain sentence, show errors through apiErrorMessage, and check its writes.
# A regression guard on the COMMON shapes, over every client file (selected by
# imports, not by directory). It is not a completeness proof: its stated limits
# are in scripts/ci/clientResponseRule.ts, and review still has to find the rest.
run_step "client-responses"       bun scripts/ci/check-client-responses.ts
run_step "unit-tests"        bun run test:unit
run_step "component-tests"   bun run test:components
run_step "migration-naming"  bun scripts/audit-migration-naming.ts
fi

if in_group velo; then
# The tests that launch real Chromium (tests/unit/print/). Excluded from
# unit-tests above, where they timed out beside ~800 parallel files, and
# run here one file at a time. REQUIRED, like every other step: a failure or a
# timeout fails the gate.
run_step "browser-tests"     capped bun run test:print

# Every tests/integration/**/*.int.test.ts against throwaway PostgreSQL 16
# clusters the step starts and removes itself (initdb as the current user; no
# docker, no dev database, no secret), from the committed schema baseline plus
# this branch's newer migrations. It ignores DATABASE_URL. It names every suite
# that skipped and why, and fails on one that skipped without saying why.
# See the header of scripts/ci/integration/run.sh.
# It runs on GitHub (GITHUB_ACTIONS=true) and, locally, only when asked for
# with CI_INTEGRATION=1: it adds 6-15 minutes, so the pre-push hook skips it.
# On GitHub, a change that touches nothing but Markdown skips it
# (scripts/ci/integration/scope.ts: exit 10 skips, anything else, a crash
# included, runs; it prints why and the files that made it run).
if [ "${GITHUB_ACTIONS:-}" = "true" ] || [ "${CI_INTEGRATION:-}" = "1" ]; then
  scope_rc=0
  if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ "${CI_INTEGRATION:-}" != "1" ]; then
    echo ""
    bun scripts/ci/integration/scope.ts || scope_rc=$?
  fi
  if [ "$scope_rc" -eq 10 ]; then
    INTEGRATION_NOTE=" (integration SKIPPED: Markdown-only change)"
    echo "[skip] integration: SKIPPED — every changed file is Markdown (see [integration-scope] above)"
  else
    run_step "integration"   bash scripts/ci/integration/run.sh
  fi
else
  INTEGRATION_NOTE=" (integration NOT RUN)"
  echo ""
  echo "[skip] integration: NOT RUN — the integration suites run on GitHub only. Run them here with: CI_INTEGRATION=1 bun run ci (or bash scripts/ci/integration/run.sh)"
fi
fi

# Production build gate — catches build-breaking changes pre-merge (the deploy
# script builds too, but that's too late). Set CI_SKIP_BUILD=1 to skip locally.
if ! in_group static; then
  :
elif [ "${CI_SKIP_BUILD:-0}" = "1" ]; then
  echo "[skip] build: CI_SKIP_BUILD=1"
else
  run_step "build"           capped env NODE_ENV=production bun run build
fi

echo ""
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "[ci] all checks passed (group: $GROUP)${INTEGRATION_NOTE}"
  exit 0
fi

echo "[ci] FAILED: ${FAILED[*]}"
exit 1
