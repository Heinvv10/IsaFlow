#!/bin/bash
# IsaFlow uptime/alerting probe (A–Z programme P3.2).
#
# Checks, every timer tick:
#   1. app health      GET  https://app.isaflow.co.za/api/health
#   2. admin health    GET  https://admin.isaflow.co.za/api/health
#   3. app authed API  cookie-jar session against the Demo company
#      (logs in only when the saved session expires — the login endpoint is
#      rate-limited to 10/15min per email and the golden suite shares it)
#   4. Bugsink new-issue count (fail-soft: SKIPPED unless BUGSINK_TOKEN set;
#      real-time push already exists via the bugsink-telegram-relay worker)
#
# Alerting: Telegram bot API. State-change deduped — one [ALERT] on OK→FAIL,
# one [RESOLVED] on FAIL→OK, re-alert only every REALERT_HOURS while red.
#
# Config: /home/hein/isaflow-ops.env (0600), see isaflow-ops-env.example.
# Install (HEIN-gated): see scripts/ops/README.md.
#
# Test/drill overrides (documented in README): PROBE_APP_URL PROBE_ADMIN_URL
# TELEGRAM_API_BASE PROBE_STATE_DIR OPS_ENV_FILE
set -u

OPS_ENV_FILE="${OPS_ENV_FILE:-/home/hein/isaflow-ops.env}"
PROBE_APP_URL="${PROBE_APP_URL:-https://app.isaflow.co.za}"
PROBE_ADMIN_URL="${PROBE_ADMIN_URL:-https://admin.isaflow.co.za}"
PROBE_STATE_DIR="${PROBE_STATE_DIR:-$HOME/.local/state/isaflow-probe}"
REALERT_HOURS="${REALERT_HOURS:-6}"
# -s (no -S): connect errors are expected during outages — the http code
# (000 from -w on failure) is the signal, not curl's stderr.
CURL="curl -s --max-time 15"

mkdir -p "$PROBE_STATE_DIR"

# Read config literally, allowlisted keys only — never source (shell-parses
# $/backticks in values; same rule as verify-deploy.sh).
if [ -f "$OPS_ENV_FILE" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && export "$line"
  done < <(grep -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|BUGSINK_TOKEN|BUGSINK_URL|E2E_ADMIN_EMAIL|E2E_ADMIN_PASSWORD)=' "$OPS_ENV_FILE" || true)
fi
TELEGRAM_API_BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}"

send_telegram() { # $1 = text
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "WARN: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — alert NOT sent: $1"
    return 1
  fi
  $CURL -X POST "$TELEGRAM_API_BASE/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
    --data-urlencode "text=$1" >/dev/null
}

# State-change dedup. $1=check-id $2=0|1 (0=ok) $3=human description
report() {
  local id="$1" ok="$2" desc="$3"
  local state_file="$PROBE_STATE_DIR/$id.state"
  local prev="ok"
  [ -f "$state_file" ] && prev="$(cat "$state_file")"
  local now_epoch; now_epoch=$(date +%s)

  if [ "$ok" = "0" ]; then
    if [ "$prev" != "ok" ]; then
      send_telegram "✅ [RESOLVED] IsaFlow probe: $desc is healthy again" || true
    fi
    echo "ok" > "$state_file"
    echo "[OK]   $desc"
  else
    local last_alert=0
    [ -f "$state_file.last-alert" ] && last_alert="$(cat "$state_file.last-alert")"
    local realert_secs=$((REALERT_HOURS * 3600))
    if [ "$prev" = "ok" ] || [ $((now_epoch - last_alert)) -ge "$realert_secs" ]; then
      send_telegram "🔴 [ALERT] IsaFlow probe: $desc FAILED (host $(hostname), $(date -Is)). Re-alerts every ${REALERT_HOURS}h while red." || true
      echo "$now_epoch" > "$state_file.last-alert"
    fi
    echo "fail" > "$state_file"
    echo "[FAIL] $desc"
  fi
}

FAILURES=0

check() { # $1=check-id $2=ok(0)/fail(1) $3=description
  report "$1" "$2" "$3"
  [ "$2" = "0" ] || FAILURES=$((FAILURES + 1))
}

# ── 1. app health ────────────────────────────────────────────────────────────
CODE=$($CURL -o /dev/null -w '%{http_code}' "$PROBE_APP_URL/api/health" || true); CODE=${CODE:-000}
if [ "$CODE" = "200" ]; then OK=0; else OK=1; fi
check "app-health" "$OK" "app /api/health ($PROBE_APP_URL, got $CODE)"

# ── 2. admin health ──────────────────────────────────────────────────────────
CODE=$($CURL -o /dev/null -w '%{http_code}' "$PROBE_ADMIN_URL/api/health" || true); CODE=${CODE:-000}
if [ "$CODE" = "200" ]; then OK=0; else OK=1; fi
check "admin-health" "$OK" "admin /api/health ($PROBE_ADMIN_URL, got $CODE)"

# ── 3. app authed API (cookie-jar session, login only on expiry) ─────────────
if [ -n "${E2E_ADMIN_EMAIL:-}" ] && [ -n "${E2E_ADMIN_PASSWORD:-}" ]; then
  JAR="$PROBE_STATE_DIR/session.jar"
  OK=0
  CODE=$($CURL -b "$JAR" -o /dev/null -w '%{http_code}' "$PROBE_APP_URL/api/auth/me" || true); CODE=${CODE:-000}
  if [ "$CODE" != "200" ]; then
    # Session missing/expired — one fresh login, then retry. Never loop:
    # /api/auth/login is rate-limited (10/15min/email) and shared with the
    # golden suite.
    LOGIN_CODE=$($CURL -c "$JAR" -o /dev/null -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' \
      --data "{\"email\":\"$E2E_ADMIN_EMAIL\",\"password\":\"$E2E_ADMIN_PASSWORD\"}" \
      "$PROBE_APP_URL/api/auth/login" || true); LOGIN_CODE=${LOGIN_CODE:-000}
    CODE=$($CURL -b "$JAR" -o /dev/null -w '%{http_code}' "$PROBE_APP_URL/api/auth/me" || true); CODE=${CODE:-000}
    if [ "$LOGIN_CODE" != "200" ] || [ "$CODE" != "200" ]; then OK=1; fi
  fi
  check "app-authed" "$OK" "app authed API (/api/auth/me as $E2E_ADMIN_EMAIL, got $CODE)"
else
  echo "[SKIP] app authed check — E2E_ADMIN_EMAIL/PASSWORD not in $OPS_ENV_FILE"
fi

# ── 4. Bugsink new-issue check (fail-soft) ───────────────────────────────────
# Real-time new-issue alerts already flow Bugsink → bugsink-telegram-relay →
# Telegram; this poll is belt-and-braces and only runs when a token exists.
if [ -n "${BUGSINK_TOKEN:-}" ]; then
  BURL="${BUGSINK_URL:-https://errors.isaflow.co.za}"
  MARK="$PROBE_STATE_DIR/bugsink.last-check"
  SINCE=$( [ -f "$MARK" ] && cat "$MARK" || date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%S )
  NEW=$($CURL -H "Authorization: Bearer $BUGSINK_TOKEN" \
    "$BURL/api/canonical/0/projects/1/issues/?query=is:unresolved&last_seen__gte=$SINCE" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d if isinstance(d,list) else d.get("results",[])))' 2>/dev/null || echo "?")
  date -u +%Y-%m-%dT%H:%M:%S > "$MARK"
  if [ "$NEW" != "?" ] && [ "$NEW" -gt 0 ] 2>/dev/null; then
    send_telegram "⚠️ IsaFlow probe: $NEW Bugsink issue(s) active since $SINCE — https://errors.isaflow.co.za" || true
    echo "[WARN] bugsink: $NEW active issue(s) since $SINCE"
  else
    echo "[OK]   bugsink check ($NEW new)"
  fi
else
  echo "[SKIP] bugsink poll — BUGSINK_TOKEN not set (real-time relay covers new issues)"
fi

echo "probe done: $FAILURES failure(s)"
exit 0  # cron/systemd unit stays green; alerting is the signal, not the exit code
