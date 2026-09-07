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
run_step "lint"              bun run lint
run_step "agent-docs"        bun run agent-docs:check
run_step "security-guards"   bash scripts/ci/check-internal-apis.sh
run_step "user-id-casts"     bun scripts/ci/audit-user-id-casts.ts
# Passes today against a baseline of the 13 known files; fails only on a NEW
# one, so the in-flight sweep is not blocked and no new offender can land.
run_step "is-active-filters"  bash scripts/ci/check-is-active-in-balances.sh
run_step "raw-transactions"     bun scripts/ci/check-raw-transaction-control.ts
run_step "self-defining-universe" bash scripts/ci/check-self-defining-universe.sh
run_step "findings-numbering"     bash scripts/ci/check-findings-numbering.sh
run_step "migration-rls"          bun scripts/ci/check-migration-rls.ts
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
