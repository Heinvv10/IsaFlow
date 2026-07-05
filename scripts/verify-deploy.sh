#!/bin/bash
# Post-deploy verification gate (A–Z programme P3.1).
#
# Verifies a running IsaFlow instance end-to-end:
#   1. /api/health responds
#   2. golden-paths E2E suite passes against the Demo company
#   3. accounting integrity check passes against the instance's DB
#      (with the committed prod baseline waiving ONLY the known
#      HUMAN-GATED failure — new failures still fail the gate)
#
# Usage:
#   scripts/verify-deploy.sh <BASE_URL>
#
# Env:
#   DATABASE_URL           DB for the integrity check (required unless
#                          VERIFY_SKIP_INTEGRITY=1)
#   E2E_ADMIN_EMAIL/_PASSWORD   Demo login for the golden suite; if unset,
#                          sourced from /home/hein/isaflow-deploy.env (0600)
#   VERIFY_BASELINE        integrity baseline file (default: the prod baseline)
#   VERIFY_SKIP_INTEGRITY  =1 skips step 3 (drills against a dev server that
#                          shares the workspace .env.local DB)
#
# Exit: 0 = all gates green; non-zero = deploy candidate must be rolled back.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE_URL="${1:?usage: verify-deploy.sh <BASE_URL>}"
VERIFY_BASELINE="${VERIFY_BASELINE:-$REPO_DIR/scripts/integrity-baseline-prod.json}"
CREDS_FILE="/home/hein/isaflow-deploy.env"
BUN="${BUN:-/home/hein/.bun/bin/bun}"

echo "=== Post-deploy verification: $BASE_URL ==="

# ── 1. Health ────────────────────────────────────────────────────────────────
echo "[1/3] Health check..."
HEALTHY=0
for _ in $(seq 1 60); do
  if curl -sf --max-time 5 "$BASE_URL/api/health" >/dev/null; then HEALTHY=1; break; fi
  sleep 2
done
if [ "$HEALTHY" != "1" ]; then
  echo "FAIL: $BASE_URL/api/health not responding after 120s"
  exit 1
fi
echo "OK: health endpoint responding"

# ── 2. Golden-paths suite ────────────────────────────────────────────────────
echo "[2/3] Golden-paths E2E suite..."
if [ -z "$E2E_ADMIN_EMAIL" ] || [ -z "$E2E_ADMIN_PASSWORD" ]; then
  if [ -f "$CREDS_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$CREDS_FILE"; set +a
  fi
fi
if [ -z "$E2E_ADMIN_EMAIL" ] || [ -z "$E2E_ADMIN_PASSWORD" ]; then
  echo "FAIL: E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD not set and $CREDS_FILE missing —"
  echo "      a blocking gate must not skip silently. Create $CREDS_FILE (chmod 600)"
  echo "      with the Demo admin credentials, or export both vars."
  exit 1
fi
cd "$REPO_DIR"
"$BUN"x playwright install chromium >/dev/null 2>&1 || true
if ! BASE_URL="$BASE_URL" "$BUN" run test:e2e:golden; then
  echo "FAIL: golden-paths suite red against $BASE_URL"
  exit 1
fi
echo "OK: golden paths green"

# ── 3. Integrity check (baseline-waived) ─────────────────────────────────────
if [ "${VERIFY_SKIP_INTEGRITY:-0}" = "1" ]; then
  echo "[3/3] Integrity check SKIPPED (VERIFY_SKIP_INTEGRITY=1 — drill mode)"
else
  echo "[3/3] Integrity check..."
  if [ -z "$DATABASE_URL" ]; then
    echo "FAIL: DATABASE_URL not set for the integrity check (set it or VERIFY_SKIP_INTEGRITY=1 for drills)"
    exit 1
  fi
  if ! "$BUN" "$REPO_DIR/scripts/integrity-check.ts" --baseline "$VERIFY_BASELINE"; then
    echo "FAIL: integrity check red (new failure beyond the committed baseline)"
    exit 1
  fi
  echo "OK: integrity green (baseline-waived failures reported above, if any)"
fi

echo "=== Post-deploy verification PASSED ==="
