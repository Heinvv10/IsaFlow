#!/bin/bash
# Roll IsaFlow back to the previous release (blue/green, 2026-10-29): switch
# nginx back to the other colour, which still holds the release before the
# current one. Nothing is copied or rebuilt; in-flight requests finish on the
# colour being left.
#
# Restores CODE only: DB migrations are NOT reverted — they are additive
# (IF NOT EXISTS) by project rule, so the previous build runs against the
# migrated schema. If a migration itself is the problem, that is a
# HUMAN-GATED incident, not something this script decides.
#
# The other colour is started first if it is not running (e.g. a failed
# deploy's verification stopped it — then it holds that failed build, so this
# refuses unless its RELEASE_SHA differs from the live one and you pass
# ROLLBACK_TO=<sha> naming it).
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/bluegreen.sh
. "$REPO_DIR/scripts/deploy/bluegreen.sh"
HEALTH_URL="${HEALTH_URL:-https://app.isaflow.co.za/api/health}"

LIVE_PORT=$(bg_live_port)
if [ -z "$LIVE_PORT" ]; then
  echo "ERROR: no live colour in $BG_UPSTREAM_FILE — nothing to roll back from"
  exit 1
fi
TARGET_PORT=$(bg_other_port "$LIVE_PORT")
LIVE_SHA=$($BG_SUDO cat "$(bg_release_dir "$LIVE_PORT")/RELEASE_SHA" 2>/dev/null || echo unknown)
TARGET_SHA=$($BG_SUDO cat "$(bg_release_dir "$TARGET_PORT")/RELEASE_SHA" 2>/dev/null || echo unknown)
echo "=== Rolling back: isaflow@$LIVE_PORT ($LIVE_SHA) -> isaflow@$TARGET_PORT ($TARGET_SHA) ==="

if ! $BG_SUDO test -f "$(bg_release_dir "$TARGET_PORT")/server.js"; then
  echo "ERROR: isaflow@$TARGET_PORT has no build — no previous release to switch to."
  echo "Manual recovery: git checkout <previous SHA> && bash scripts/deploy.sh"
  exit 1
fi
if [ -n "${ROLLBACK_TO:-}" ] && [ "$ROLLBACK_TO" != "$TARGET_SHA" ]; then
  echo "ERROR: ROLLBACK_TO=$ROLLBACK_TO but isaflow@$TARGET_PORT holds $TARGET_SHA"
  exit 1
fi

if ! curl -sf --max-time 5 "http://127.0.0.1:$TARGET_PORT/api/health" >/dev/null; then
  # Not running: it may hold a build whose verification failed. Only start it
  # when the operator names the release it holds.
  if [ -z "${ROLLBACK_TO:-}" ]; then
    echo "ERROR: isaflow@$TARGET_PORT is not running. It holds $TARGET_SHA; if that is the release"
    echo "you want, re-run with ROLLBACK_TO=$TARGET_SHA."
    exit 1
  fi
  echo "Starting isaflow@$TARGET_PORT..."
  bg_start "$TARGET_PORT"
fi

bg_switch "$TARGET_PORT"
if ! curl -sf --max-time 10 --retry 5 --retry-delay 2 --retry-all-errors "$HEALTH_URL" >/dev/null; then
  echo "ERROR: $HEALTH_URL unhealthy AFTER switching to isaflow@$TARGET_PORT — manual intervention required:"
  echo "  sudo journalctl -u isaflow@$TARGET_PORT -n 100 --no-pager"
  exit 1
fi
bg_record_live "$TARGET_PORT" >/dev/null
echo "=== Rollback complete (live: isaflow@$TARGET_PORT at $TARGET_SHA; migrations NOT reverted) ==="
