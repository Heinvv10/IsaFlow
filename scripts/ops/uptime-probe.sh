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
#      real-time push already exists via the bugsink-telegram-relay worker).
#      A FAILING poll (bad token, 5xx) alerts as its own probe failure —
#      never a silent "all clear".
#
# Alerting: Telegram bot API. State-change deduped — one [ALERT] on OK→FAIL,
# one [RESOLVED] on FAIL→OK, re-alert only every REALERT_HOURS while red.
# Delivery is CONFIRMED against Telegram's response; a failed send is logged
# loudly to stdout/journald (the operator's last-resort signal).
#
# Config: /home/hein/isaflow-ops.env (0600), see isaflow-ops-env.example.
# Install (HEIN-gated): see scripts/ops/README.md.
#
# Test/drill overrides (documented in README): PROBE_APP_URL PROBE_ADMIN_URL
# TELEGRAM_API_BASE PROBE_STATE_DIR OPS_ENV_FILE
set -u

# Secrets hygiene: every file this probe creates (state, cookie jar, login
# body) is owner-only; velo-server is a shared multi-stack box.
umask 077

OPS_ENV_FILE="${OPS_ENV_FILE:-/home/hein/isaflow-ops.env}"
PROBE_APP_URL="${PROBE_APP_URL:-https://app.isaflow.co.za}"
PROBE_ADMIN_URL="${PROBE_ADMIN_URL:-https://admin.isaflow.co.za}"
PROBE_STATE_DIR="${PROBE_STATE_DIR:-$HOME/.local/state/isaflow-probe}"
REALERT_HOURS="${REALERT_HOURS:-6}"
# -s (no -S): connect errors are expected during outages — the http code
# (000 from -w on failure) is the signal, not curl's stderr.
CURL="curl -s --max-time 15"

# An unusable state dir must be a LOUD failure (journald), never a silent
# skip — the probe would otherwise die quietly forever.
mkdir -p "$PROBE_STATE_DIR" || { echo "ERROR: cannot create state dir $PROBE_STATE_DIR"; exit 1; }
chmod 700 "$PROBE_STATE_DIR" || { echo "ERROR: cannot chmod state dir $PROBE_STATE_DIR"; exit 1; }

# One probe at a time: a hung run must not race the next timer tick on the
# state files / cookie jar. flock releases on process exit.
exec 8>"$PROBE_STATE_DIR/.lock" || { echo "ERROR: cannot open lock file in $PROBE_STATE_DIR"; exit 1; }
if ! flock -n 8; then
  echo "another probe run is still active — skipping this tick"
  exit 0
fi

# Read config literally, allowlisted keys only — never source (shell-parses
# $/backticks in values; same rule as verify-deploy.sh).
if [ -f "$OPS_ENV_FILE" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && export "$line"
  done < <(grep -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|BUGSINK_TOKEN|BUGSINK_URL|E2E_ADMIN_EMAIL|E2E_ADMIN_PASSWORD)=' "$OPS_ENV_FILE" || true)
fi
TELEGRAM_API_BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}"

send_telegram() { # $1 = text. Confirms delivery; loud journald error if not.
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "ERROR: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — alert NOT sent: $1"
    return 1
  fi
  local resp_file="$PROBE_STATE_DIR/.tg-resp.json"
  local http
  http=$($CURL -o "$resp_file" -w '%{http_code}' -X POST \
    "$TELEGRAM_API_BASE/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
    --data-urlencode "text=$1" || true)
  http=${http:-000}
  if [ "$http" != "200" ] || ! grep -q '"ok":\s*true' "$resp_file" 2>/dev/null; then
    echo "ERROR: telegram send FAILED (http $http) — alerting channel itself is broken. Response: $(head -c 200 "$resp_file" 2>/dev/null)"
    return 1
  fi
  return 0
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
    # golden suite. The body is JSON-built by python (correct escaping) and
    # passed via a 0600 file so the password never appears in process argv.
    LOGIN_BODY="$PROBE_STATE_DIR/.login-body.json"
    python3 -c 'import json,os; print(json.dumps({"email": os.environ["E2E_ADMIN_EMAIL"], "password": os.environ["E2E_ADMIN_PASSWORD"]}))' > "$LOGIN_BODY"
    LOGIN_CODE=$($CURL -c "$JAR" -o /dev/null -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' \
      --data @"$LOGIN_BODY" \
      "$PROBE_APP_URL/api/auth/login" || true); LOGIN_CODE=${LOGIN_CODE:-000}
    rm -f "$LOGIN_BODY"
    CODE=$($CURL -b "$JAR" -o /dev/null -w '%{http_code}' "$PROBE_APP_URL/api/auth/me" || true); CODE=${CODE:-000}
    if [ "$LOGIN_CODE" != "200" ] || [ "$CODE" != "200" ]; then OK=1; fi
  fi
  check "app-authed" "$OK" "app authed API (/api/auth/me as $E2E_ADMIN_EMAIL, got $CODE)"
else
  echo "[SKIP] app authed check — E2E_ADMIN_EMAIL/PASSWORD not in $OPS_ENV_FILE"
fi

# ── 4. Bugsink new-issue check (fail-soft skip, but NEVER silent-OK on error) ─
# Real-time new-issue alerts already flow Bugsink → bugsink-telegram-relay →
# Telegram; this poll is belt-and-braces and only runs when a token exists.
if [ -n "${BUGSINK_TOKEN:-}" ]; then
  BURL="${BUGSINK_URL:-https://errors.isaflow.co.za}"
  MARK="$PROBE_STATE_DIR/bugsink.last-check"
  SINCE=$(cat "$MARK" 2>/dev/null || true)
  [ -n "$SINCE" ] || SINCE=$(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%S)
  BODY="$PROBE_STATE_DIR/.bugsink-body.json"
  HTTP=$($CURL -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $BUGSINK_TOKEN" \
    "$BURL/api/canonical/0/projects/1/issues/?query=is:unresolved&last_seen__gte=$SINCE" || true)
  HTTP=${HTTP:-000}
  NEW="?"
  if [ "$HTTP" = "200" ]; then
    NEW=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d if isinstance(d,list) else d.get("results",[])))' < "$BODY" 2>/dev/null || echo "?")
  fi
  if [ "$NEW" = "?" ]; then
    # Poll itself broken (auth, 5xx, parse) — that IS a failure, and the
    # since-mark does NOT advance so no window is ever silently skipped.
    check "bugsink-poll" 1 "Bugsink poll ($BURL, got $HTTP)"
  else
    check "bugsink-poll" 0 "Bugsink poll ($BURL, got $HTTP)"
    date -u +%Y-%m-%dT%H:%M:%S > "$MARK"
    if [ "$NEW" -gt 0 ] 2>/dev/null; then
      send_telegram "⚠️ IsaFlow probe: $NEW Bugsink issue(s) active since $SINCE — https://errors.isaflow.co.za" || true
      echo "[WARN] bugsink: $NEW active issue(s) since $SINCE"
    fi
  fi
else
  echo "[SKIP] bugsink poll — BUGSINK_TOKEN not set (real-time relay covers new issues)"
fi

echo "probe done: $FAILURES failure(s)"
exit 0  # cron/systemd unit stays green; alerting is the signal, not the exit code
