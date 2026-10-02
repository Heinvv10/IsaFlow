#!/usr/bin/env bash
# Run all CI checks, collect failures, exit non-zero if any failed.
# Reports every failure rather than aborting at the first one — devs see
# the full picture in a single run.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

declare -a FAILED=()

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

# A bunfig.toml `preload` runs before every bun process, so one that calls
# process.exit(0) would pass every gate below that runs under bun, the
# workflow-runs-ci check included. Checked in bash for that reason; the repo
# has no bunfig.toml, and adding one means changing this line in review (R-052).
run_step "no-bunfig"         test ! -e bunfig.toml
run_step "type-check"        bun run type-check
run_step "lint"              bun run lint
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
# screen. Migration 693 makes them unwritable; the only other guard on that is
# an integration test this script SKIPS without DATABASE_URL, so a change that
# undid 693 would leave CI green. Text-only, so it runs every time.
run_step "oauth-trust-flags"      bun scripts/ci/check-oauth-trust-flags.ts
# GitHub's CI job must call this script, not a hand-kept copy of its list
# (R-052: GitHub ran 5 of these gates while a PR showed green).
run_step "workflow-runs-ci"       bun scripts/ci/check-workflow-runs-ci.ts
# Client code must read the HTTP status before a response body, say what failed
# in a plain sentence, show errors through apiErrorMessage, and check its writes.
# A type-checker based gate over every client file (selected by content, not by
# directory); its stated limits are in scripts/ci/clientResponseRule.ts, so it
# narrows what review has to find, it does not replace review.
run_step "client-responses"       bun scripts/ci/check-client-responses.ts
run_step "unit-tests"        bun run test:unit
run_step "component-tests"   bun run test:components
run_step "migration-naming"  bun scripts/audit-migration-naming.ts

if [ -n "${DATABASE_URL:-}" ]; then
  run_step "integration-tests" bun run test:integration
else
  echo "[skip] integration-tests: DATABASE_URL not set"
fi

# Production build gate — catches build-breaking changes pre-merge (the deploy
# script builds too, but that's too late). Set CI_SKIP_BUILD=1 to skip locally.
if [ "${CI_SKIP_BUILD:-0}" = "1" ]; then
  echo "[skip] build: CI_SKIP_BUILD=1"
else
  run_step "build"           env NODE_ENV=production bun run build
fi

echo ""
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "[ci] all checks passed"
  exit 0
fi

echo "[ci] FAILED: ${FAILED[*]}"
exit 1
