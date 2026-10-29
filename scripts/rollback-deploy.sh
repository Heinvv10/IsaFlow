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
# Refuses a colour marked FAILED (a deploy whose verification failed left it
# there) and runs under the deploy lock, so it never races a deploy that is
# writing or verifying the other colour.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/bluegreen.sh
. "$REPO_DIR/scripts/deploy/bluegreen.sh"
HEALTH_URL="${HEALTH_URL:-https://app.isaflow.co.za/api/health}"
bg_lock

LIVE_PORT=$(bg_live_port)
if [ -z "$LIVE_PORT" ]; then
  echo "ERROR: no live colour in $BG_UPSTREAM_FILE — nothing to roll back from"
  exit 1
fi
TARGET_PORT=$(bg_other_port "$LIVE_PORT")
TARGET_DIR=$(bg_release_dir "$TARGET_PORT")
LIVE_SHA=$($BG_SUDO cat "$(bg_release_dir "$LIVE_PORT")/RELEASE_SHA" 2>/dev/null || echo unknown)
TARGET_SHA=$($BG_SUDO cat "$TARGET_DIR/RELEASE_SHA" 2>/dev/null || echo unknown)
echo "=== Rolling back: isaflow@$LIVE_PORT ($LIVE_SHA) -> isaflow@$TARGET_PORT ($TARGET_SHA) ==="

if ! $BG_SUDO test -f "$TARGET_DIR/server.js"; then
  echo "ERROR: isaflow@$TARGET_PORT has no build — no previous release to switch to."
  echo "Manual recovery: git checkout <previous SHA> && bash scripts/deploy.sh"
  exit 1
fi
if bg_failed "$TARGET_PORT"; then
  echo "ERROR: isaflow@$TARGET_PORT holds a build that failed verification ($($BG_SUDO cat "$TARGET_DIR/FAILED"))."
  echo "There is no verified release to switch back to. Manual recovery: git checkout <last good SHA> && bash scripts/deploy.sh"
  exit 1
fi

if ! curl -sf --max-time 5 "http://127.0.0.1:$TARGET_PORT/api/health" >/dev/null; then
  echo "Starting isaflow@$TARGET_PORT..."
  bg_start "$TARGET_PORT"
fi

bg_switch "$TARGET_PORT"
if ! bg_served_by "$TARGET_PORT" \
  || ! curl -sf --max-time 10 --retry 5 --retry-delay 2 --retry-all-errors "$HEALTH_URL" >/dev/null; then
  echo "ERROR: isaflow@$TARGET_PORT is not answering through nginx/$HEALTH_URL after the switch — manual intervention required:"
  echo "  sudo journalctl -u isaflow@$TARGET_PORT -n 100 --no-pager"
  exit 1
fi
bg_record_live "$TARGET_PORT"
echo "=== Rollback complete (live: isaflow@$TARGET_PORT at $TARGET_SHA; migrations NOT reverted) ==="
