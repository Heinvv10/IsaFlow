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
run_step "lint"              bun run lint
run_step "unit-tests"        bun run test:unit
run_step "migration-naming"  bun scripts/audit-migration-naming.ts

echo ""
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "[ci] all checks passed"
  exit 0
fi

echo "[ci] FAILED: ${FAILED[*]}"
exit 1
