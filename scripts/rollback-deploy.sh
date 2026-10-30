#!/bin/bash
# Roll IsaFlow back to the previous release (blue/green, 2026-10-29): switch
# nginx back to the other colour, which still holds the release before the
# current one. Nothing is copied or rebuilt; in-flight requests finish on the
# colour being left. Only one release back: the deploy before that overwrote it.
#
# Restores CODE only: DB migrations are NOT reverted — they are additive
# (IF NOT EXISTS) by project rule, so the previous build runs against the
# migrated schema. If a migration itself is the problem, that is a
# HUMAN-GATED incident, not something this script decides.
#
# Refuses an unverified colour (a deploy that failed or was aborted left it
# marked) and runs under the colour lock, so it never races a deploy that is
# writing or verifying the other colour. The colour it leaves is marked, so a
# second rollback does not flip straight back to the release just rolled back.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/bluegreen.sh
. "$REPO_DIR/scripts/deploy/bluegreen.sh"
[ -n "${HEALTH_URL:-}" ] && BG_PUBLIC_HEALTH="$HEALTH_URL"
bg_lock

LIVE_PORT=$(bg_live_port)
if [ -z "$LIVE_PORT" ]; then
  echo "ERROR: no live colour in $BG_UPSTREAM_FILE — nothing to roll back from"
  exit 1
fi
TARGET_PORT=$(bg_other_port "$LIVE_PORT")
LIVE_SHA=$(bg_sha "$LIVE_PORT")
TARGET_SHA=$(bg_sha "$TARGET_PORT")
echo "=== Rolling back: isaflow@$LIVE_PORT ($LIVE_SHA) -> isaflow@$TARGET_PORT ($TARGET_SHA) ==="
bg_served_by "$LIVE_PORT" || { echo "ERROR: nginx is not serving isaflow@$LIVE_PORT although $BG_UPSTREAM_FILE names it; not rolling back"; exit 1; }
if [ "$LIVE_SHA" = "$TARGET_SHA" ]; then
  echo "ERROR: isaflow@$TARGET_PORT holds the same release ($TARGET_SHA) as the live colour (restart-colours copied it there):"
  echo "there is no older release to roll back to. Manual recovery: git checkout <last good SHA> && bash scripts/deploy.sh"
  exit 1
fi

if ! $BG_SUDO test -f "$(bg_release_dir "$TARGET_PORT")/server.js"; then
  echo "ERROR: isaflow@$TARGET_PORT has no build — no previous release to switch to."
  echo "Manual recovery: git checkout <previous SHA> && bash scripts/deploy.sh"
  exit 1
fi
if bg_failed "$TARGET_PORT"; then
  echo "ERROR: isaflow@$TARGET_PORT is unverified: $($BG_SUDO cat "$(bg_marker "$TARGET_PORT")")."
  echo "There is no verified release to switch back to. Manual recovery: git checkout <last good SHA> && bash scripts/deploy.sh"
  exit 1
fi

if ! curl -sf --max-time 5 "http://127.0.0.1:$TARGET_PORT/api/health" >/dev/null; then
  echo "Starting isaflow@$TARGET_PORT..."
  $BG_SUDO "$BG_SYSTEMCTL" enable "isaflow@$TARGET_PORT"
  bg_start "$TARGET_PORT"
fi

rc=0; bg_switch_proven "$TARGET_PORT" "$LIVE_PORT" || rc=$?
if [ "$rc" -eq 2 ]; then
  echo "!!! ROLLBACK FAILED AND SO DID THE SWITCH BACK: nginx's state is unknown. Check $BG_UPSTREAM_FILE and nginx now. !!!"
  exit 2
elif [ "$rc" -ne 0 ]; then
  echo "ERROR: rollback not done (live stays isaflow@$LIVE_PORT). Look at: sudo journalctl -u isaflow@$TARGET_PORT -n 100 --no-pager"
  exit 1
fi
bg_mark_failed "$LIVE_PORT" "$LIVE_SHA: rolled back from on $(date -Is)"
bg_record_live "$TARGET_PORT"
echo "Note: isaflow@$TARGET_PORT runs with the env it last started with; after an .env.local change, run scripts/deploy/restart-colours.sh."
echo "=== Rollback complete (live: isaflow@$TARGET_PORT at $TARGET_SHA; migrations NOT reverted) ==="
