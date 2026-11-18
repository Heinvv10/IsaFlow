#!/bin/bash
# Post-deploy verification gate (A–Z programme P3.1).
#
# Verifies a running IsaFlow instance end-to-end:
#   1. /api/health responds
#   2. golden-paths E2E suite passes in the Deploy Verification company (its own
#      hidden company and two logins, scripts/deploy/provision-verify-company.ts);
#      without that login it runs on the Demo company, loudly
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
#   E2E_VERIFY_EMAIL/_PASSWORD   The dedicated verification login, whose only company besides
#                          its migration sandbox is the hidden Deploy Verification company.
#                          When both are set (exported, or in the creds file) the golden
#                          suite logs in as it: every spec then writes there and never to
#                          Demo, and the suite's global setup fails the run if the login's
#                          active company is not that company (is_demo) or it owns any
#                          company that is not is_demo. The pair becomes the suite's
#                          E2E_ADMIN_*. One of the two alone FAILs. Neither set: the old
#                          behaviour, on Demo, with one loud line saying so.
#   E2E_VERIFY_APPROVER_EMAIL/_PASSWORD   The second member of that company (an admin): becomes
#                          E2E_APPROVER_*, so h-payroll-run proves the R-035 two-person gate
#                          (self-approval refused, a second user approves). Both or neither
#                          (one alone FAILs); absent, the gate is only proved by refusal and
#                          a WARNING says so. Any E2E_APPROVER_* of the Demo company is dropped.
#   z22 (the platform admin console) keeps a platform admin: the GOLDEN_PLATFORM_ADMIN_*
#                          pair (both or neither), else the E2E_ADMIN_* pair below.
#   Coverage that changes with the verify company (a smaller, young company, not the long-lived
#                          Demo): legacy Demo data shapes are no longer exercised; the
#                          VAT-registered path is covered, a non-VAT company is not; two-person
#                          approval is covered by the approver login. The budget specs must not
#                          skip: a skipped v-budget-workspace or z-budget-drivers FAILS the gate
#                          (VERIFY_ALLOW_BUDGET_SKIP=1 waives it; re-run the provisioner each
#                          year after 1 March to add the new budget year).
#   E2E_ADMIN_EMAIL/_PASSWORD   Demo login for the golden suite (and z22's platform admin
#                          once the verify login is set); if unset, sourced from
#                          /home/hein/isaflow-deploy.env (0600; VERIFY_CREDS_FILE names
#                          another file, for tests); a trailing CR on a line is dropped
#   E2E_APPROVER_EMAIL/_PASSWORD   OPTIONAL second Demo user (owner/admin of the
#                          same company) who approves the golden payroll run:
#                          prod Demo has several approvers, so the admin cannot
#                          approve its own request (SELF_APPROVAL_FORBIDDEN).
#                          Read from the same file; both or neither (one alone FAILs).
#                          Ignored when the verify login is used (E2E_VERIFY_APPROVER_* replaces it).
#   Precedence: per key, an exported variable beats the creds file, so a half-exported
#                          admin pair mixes sources; a key repeated in the file is last-wins.
#   VERIFY_BASELINE        integrity baseline file (default: the prod baseline)
#   VERIFY_SKIP_INTEGRITY  =1 skips step 3 (drills against a dev server that
#                          shares the workspace .env.local DB)
#
# Exit: 0 = all gates green; non-zero = deploy candidate must be rolled back.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE_URL="${1:?usage: verify-deploy.sh <BASE_URL>}"
VERIFY_BASELINE="${VERIFY_BASELINE:-$REPO_DIR/scripts/integrity-baseline-prod.json}"
CREDS_FILE="${VERIFY_CREDS_FILE:-/home/hein/isaflow-deploy.env}"
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

# ── 1b. Public-host routing ──────────────────────────────────────────────────
# BASE_URL is the colour's own localhost address, where a redirect to
# localhost works and a failed middleware rewrite looks like any other page.
# Ask as the public hosts do (nginx passes Host and X-Forwarded-Proto): a
# logged-out redirect must stay on that host, and the admin rewrite (/ ->
# /admin) must answer 2xx. Both broke on 2026-11-02 and this gate saw neither.
check_location() {  # host path
  local loc
  loc=$(curl -s -o /dev/null --max-time 15 -D - -H "Host: $1" -H 'X-Forwarded-Proto: https' \
    "$BASE_URL$2" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')
  case "$loc" in
    /login*|"https://$1/login"*) ;;
    *) echo "FAIL: logged-out $1$2 redirects to '$loc', not $1/login"; exit 1 ;;
  esac
}
check_location app.isaflow.co.za /accounting
check_location admin.isaflow.co.za /
# The token is deliberately fake: middleware only checks the cookie is present
# and rewrites; the admin page itself answers 200 and checks the session client
# side. A curl failure reports 000 and fails below with a message.
ADMIN_STATUS=$(curl -s -o /dev/null --max-time 30 -w '%{http_code}' -H 'Host: admin.isaflow.co.za' \
  -H 'X-Forwarded-Proto: https' -H 'Cookie: sb-access-token=verify-deploy' "$BASE_URL/") || true
case "$ADMIN_STATUS" in
  2??) ;;
  *) echo "FAIL: admin.isaflow.co.za/ with a session cookie answered $ADMIN_STATUS (middleware rewrite broken?)"; exit 1 ;;
esac
echo "OK: public-host redirects and the admin rewrite stay on their host"

# ── 2. Golden-paths suite ────────────────────────────────────────────────────
echo "[2/3] Golden-paths E2E suite..."
if [ -f "$CREDS_FILE" ]; then
  # Read only the expected keys, literally — never `.`/source, which
  # shell-parses values ($, backticks, quotes) and would silently mangle a
  # generated password (same hazard deploy.sh documents for .env.local).
  # A variable already exported wins over the file; a key repeated in the file is last-wins.
  PRE_EXPORTED=" "
  for key in E2E_ADMIN_EMAIL E2E_ADMIN_PASSWORD E2E_APPROVER_EMAIL E2E_APPROVER_PASSWORD E2E_VERIFY_EMAIL E2E_VERIFY_PASSWORD E2E_VERIFY_APPROVER_EMAIL E2E_VERIFY_APPROVER_PASSWORD; do
    [ -n "${!key}" ] && PRE_EXPORTED="$PRE_EXPORTED$key "
  done
  while IFS= read -r line; do
    line="${line%$'\r'}"  # a CRLF file: the CR is not part of the value
    [ -n "$line" ] || continue
    key="${line%%=*}"
    case "$PRE_EXPORTED" in *" $key "*) continue ;; esac
    export "$line"
  done < <(grep -E '^E2E_(ADMIN|APPROVER|VERIFY|VERIFY_APPROVER)_(EMAIL|PASSWORD)=' "$CREDS_FILE" || true)
fi
# both_or_neither <label> <emailvar> <passwordvar>: FAIL unless both or neither of the two variables are set.
both_or_neither() {
  if { [ -n "${!2}" ] && [ -z "${!3}" ]; } || { [ -z "${!2}" ] && [ -n "${!3}" ]; }; then
    echo "FAIL: only one of $2/$3 is set — set both or neither."
    exit 1
  fi
}
# Which company the suite works in. The verify login is the whole selection: the specs and helpers read the suite's
# login from E2E_ADMIN_* (tests/e2e/_creds.ts, the global setup, Api.login), so pointing that pair at the verify user
# moves every spec, and the sandbox company they create, off Demo (the suite's global setup then proves the company).
# z22 alone needs a platform admin, so it is handed the pair that was E2E_ADMIN_* (unless a GOLDEN_PLATFORM_ADMIN_*
# pair is already exported).
both_or_neither verify E2E_VERIFY_EMAIL E2E_VERIFY_PASSWORD
both_or_neither verify-approver E2E_VERIFY_APPROVER_EMAIL E2E_VERIFY_APPROVER_PASSWORD
if [ -n "$E2E_VERIFY_EMAIL" ]; then
  both_or_neither platform-admin GOLDEN_PLATFORM_ADMIN_EMAIL GOLDEN_PLATFORM_ADMIN_PASSWORD
  if [ -z "$GOLDEN_PLATFORM_ADMIN_EMAIL" ]; then
    if [ -z "$E2E_ADMIN_EMAIL" ] || [ -z "$E2E_ADMIN_PASSWORD" ]; then
      echo "FAIL: the verify login is set, but z22 (admin console) still needs a platform admin: set E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD"
      echo "      (or GOLDEN_PLATFORM_ADMIN_EMAIL/_PASSWORD) next to E2E_VERIFY_*; a blocking gate must not skip silently."
      exit 1
    fi
    for part in EMAIL PASSWORD; do
      from="E2E_ADMIN_$part"; export "GOLDEN_PLATFORM_ADMIN_$part=${!from}"
    done
  fi
  for part in EMAIL PASSWORD; do
    from="E2E_VERIFY_$part"; export "E2E_ADMIN_$part=${!from}"
  done
  unset E2E_APPROVER_EMAIL E2E_APPROVER_PASSWORD
  if [ -n "$E2E_VERIFY_APPROVER_EMAIL" ]; then
    for part in EMAIL PASSWORD; do
      from="E2E_VERIFY_APPROVER_$part"; export "E2E_APPROVER_$part=${!from}"
    done
    echo "OK: deploy checks will run as $E2E_VERIFY_EMAIL, approver $E2E_VERIFY_APPROVER_EMAIL (the suite's setup proves the company is Deploy Verification)"
  else
    echo "WARNING: no E2E_VERIFY_APPROVER_*: the pay-run approval is only proved by refusal, not by a second user (re-run provision-verify-company.sh)"
    echo "OK: deploy checks will run as $E2E_VERIFY_EMAIL (the suite's setup proves the company is Deploy Verification)"
  fi
else
  both_or_neither approver E2E_APPROVER_EMAIL E2E_APPROVER_PASSWORD
  if [ -z "$E2E_ADMIN_EMAIL" ] || [ -z "$E2E_ADMIN_PASSWORD" ]; then
    echo "FAIL: E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD not set and $CREDS_FILE missing —"
    echo "      a blocking gate must not skip silently. Create $CREDS_FILE (chmod 600)"
    echo "      with the Demo admin credentials, or export both vars."
    exit 1
  fi
  echo "WARNING: deploy checks will run on the Demo company: provision the verify company (scripts/deploy/provision-verify-company.sh)"
fi
cd "$REPO_DIR"
"$BUN"x playwright install chromium >/dev/null 2>&1 || true
# The a11y spec and the two theme specs (o-theme-*) are dev/CI gates: its baseline is recorded on dev data, and a red run here rolls the deploy back
# (code only; migrations stay). GOLDEN_SKIP_A11Y=1 makes playwright-golden.config.ts ignore the file, so it is not
# even loaded (a missing @axe-core/playwright cannot break this run). tests/unit/scripts/verifyDeployA11yGate.test.ts
# lists this run's tests with the axe package made unresolvable, and fails if the spec is loaded.
GOLDEN_LOG="$(mktemp)"
trap 'rm -f "$GOLDEN_LOG"' EXIT
set +e
GOLDEN_SKIP_A11Y=1 BASE_URL="$BASE_URL" "$BUN" run test:e2e:golden 2>&1 | tee "$GOLDEN_LOG"
GOLDEN_RC=${PIPESTATUS[0]}
set -e
if [ "$GOLDEN_RC" != "0" ]; then
  echo "FAIL: golden-paths suite red against $BASE_URL"
  exit 1
fi
# The budget specs skip, with a green exit, when the company lacks a budget version or prior-year actuals. Against the verify
# company that is a provisioning gap (a new budget year: re-run the provisioner), not a pass.
if [ -n "$E2E_VERIFY_EMAIL" ] && [ "${VERIFY_ALLOW_BUDGET_SKIP:-0}" != "1" ] \
   && sed 's/\x1b\[[0-9;]*m//g' "$GOLDEN_LOG" | grep -Eq '^[[:space:]]+-[[:space:]]+[0-9]+ .*(v-budget-workspace|z-budget-drivers)\.spec\.ts'; then
  echo "FAIL: a budget golden spec was SKIPPED in the Deploy Verification company: it lacks a budget version or prior-year actuals."
  echo "      Run scripts/deploy/provision-verify-company.sh (it tops up the new budget year); VERIFY_ALLOW_BUDGET_SKIP=1 waives this."
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
