#!/bin/bash
# Restart IsaFlow so it re-reads /home/velo/isaflow/.env.local (a rotated
# secret, a changed role password) with no request cut and no change of code:
# copy the live colour's release into the idle colour, start it, switch nginx
# to it, then restart the colour just left. Both colours then run the live
# release with the new env. Replaces `systemctl restart isaflow`
# (blue/green, 2026-10-29).
#
# The restarted colour must pass the deploy's verification gate (golden paths
# + integrity, scripts/verify-deploy.sh) before users reach it: a bad env value
# that /api/health never touches (a JWT or encryption key) stops here, with
# users still on the old colour. SKIP_VERIFY=1 is for emergencies only.
#
# Cost: the idle colour's previous release (the rollback target) is replaced
# by the live one, so until the next deploy a rollback has nowhere older to go.
set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=bluegreen.sh
. "$REPO_DIR/scripts/deploy/bluegreen.sh"
[ -n "${HEALTH_URL:-}" ] && BG_PUBLIC_HEALTH="$HEALTH_URL"
# shellcheck source=../ops/ownerDatabaseUrl.sh
. "$REPO_DIR/scripts/ops/ownerDatabaseUrl.sh"
verify_restarted() {
  if [ "${SKIP_VERIFY:-0}" = "1" ]; then echo "WARNING: SKIP_VERIFY=1 — the restarted colour is UNVERIFIED"; return 0; fi
  DATABASE_URL="$(owner_database_url_for "$BG_ENV_HOME/.env.local" $BG_SUDO || true)" bash "$REPO_DIR/scripts/verify-deploy.sh" "$1"
}
BG_VERIFY="${BG_VERIFY:-verify_restarted}"
bg_lock

LIVE=$(bg_live_port)
[ -n "$LIVE" ] || { echo "ERROR: no live colour in $BG_UPSTREAM_FILE"; exit 1; }
IDLE=$(bg_other_port "$LIVE")
SHA=$(bg_sha "$LIVE")
bg_served_by "$LIVE" || { echo "ERROR: nginx is not serving isaflow@$LIVE although $BG_UPSTREAM_FILE names it"; exit 1; }

echo "1. Copying the live release ($SHA) into isaflow@$IDLE (its previous release is dropped)..."
bg_stop_idle "$IDLE"
bg_sync_release "$(bg_release_dir "$LIVE")" "$IDLE" "$SHA" release
echo "2. Starting isaflow@$IDLE with the current env..."
$BG_SUDO "$BG_SYSTEMCTL" enable "isaflow@$IDLE"
bg_start "$IDLE"
echo "   verifying isaflow@$IDLE with the new env before any user reaches it..."
if ! "$BG_VERIFY" "http://localhost:$IDLE" 8>&-; then
  bg_retire_failed "$IDLE" "$SHA: failed verification with the new env"
  echo "ERROR: isaflow@$IDLE failed verification with the new env. Users stay on isaflow@$LIVE (old env). Fix .env.local and re-run."
  exit 1
fi
bg_clear_marker "$IDLE"
echo "3. Switching nginx to isaflow@$IDLE..."
rc=0; bg_switch_proven "$IDLE" "$LIVE" || rc=$?
[ "$rc" -eq 2 ] && { echo "!!! The switch failed AND so did the switch back: nginx's state is unknown. Check it now. !!!"; exit 2; }
[ "$rc" -eq 0 ] || { echo "ERROR: switch not done; live stays isaflow@$LIVE (old env)"; exit 1; }
bg_record_live "$IDLE"
echo "4. Restarting isaflow@$LIVE (now idle) with the current env, once its requests finish..."
if ! bg_start "$LIVE"; then
  echo "WARNING: isaflow@$LIVE was not restarted (still busy, or did not start); it keeps the OLD env. Re-run later."
  exit 3
fi
echo "=== Both colours run $SHA with the current env; live: isaflow@$IDLE ==="
