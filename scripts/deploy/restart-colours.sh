#!/bin/bash
# Restart IsaFlow so it re-reads /home/velo/isaflow/.env.local (a rotated
# secret, a changed role password), with no request cut: restart the idle
# colour, switch nginx to it, then restart the colour just left, so both run
# the new env and a later rollback does not switch to a stale one.
# Replaces `systemctl restart isaflow` (blue/green, 2026-10-29). Each colour
# keeps its own build; only the env is reloaded.
set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=bluegreen.sh
. "$REPO_DIR/scripts/deploy/bluegreen.sh"
bg_lock

LIVE=$(bg_live_port)
[ -n "$LIVE" ] || { echo "ERROR: no live colour in $BG_UPSTREAM_FILE"; exit 1; }
IDLE=$(bg_other_port "$LIVE")
if bg_failed "$IDLE" || ! $BG_SUDO test -f "$(bg_release_dir "$IDLE")/server.js"; then
  echo "ERROR: isaflow@$IDLE holds no verified build, so the live colour cannot be restarted without"
  echo "cutting requests. Deploy first (it rebuilds isaflow@$IDLE), or accept the cut:"
  echo "  sudo systemctl restart isaflow@$LIVE"
  exit 1
fi

echo "1. Restarting isaflow@$IDLE..."
bg_start "$IDLE"
echo "2. Switching nginx to isaflow@$IDLE..."
bg_switch "$IDLE"
bg_served_by "$IDLE"
bg_record_live "$IDLE"
echo "3. Restarting isaflow@$LIVE (now idle)..."
bg_start "$LIVE"
echo "=== Both colours restarted; live: isaflow@$IDLE ==="
