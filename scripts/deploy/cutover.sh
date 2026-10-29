#!/bin/bash
# One-time move of production from the single isaflow.service (:3101) to the
# blue/green pair (2026-10-29). Production change: run only with Hein's go,
# after hours. Does not build or migrate; it moves the release that is live now.
#
#   bash scripts/deploy/cutover.sh          cut over
#   bash scripts/deploy/cutover.sh --undo   back to isaflow.service on :3101
#
# Order keeps the public host serving throughout: the new colour starts on
# 3111 and nginx :80 moves to it first; only then does isaflow.service stop and
# nginx take over :3101 (the admin host and the cron units), a gap of well
# under a second on :3101 alone.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=bluegreen.sh
. "$REPO_DIR/scripts/deploy/bluegreen.sh"
SITE=/etc/nginx/sites-enabled/isaflow-combined
# Outside sites-enabled: nginx includes every file in that folder.
SITE_BACKUP=/etc/nginx/isaflow-combined.pre-bluegreen
NEW_SITE="$REPO_DIR/scripts/nginx/isaflow-combined"
OLD_DIR=/home/velo/isaflow
FIRST=$(echo "$BG_PORTS" | awk '{print $1}')

health() { curl -sf --max-time 5 "$1" >/dev/null; }
# The new site config without its :3101 server block (that block starts at
# the marker comment and runs to the end of the file).
site_without_3101() { sed '/^# :3101 was the app.s own port/,$d' "$NEW_SITE"; }
install_site() { sudo tee "$SITE" >/dev/null; sudo nginx -t; sudo nginx -s reload; }
wait_port_free() {
  for _ in $(seq 1 20); do ss -ltn "sport = :3101" | grep -q LISTEN || return 0; sleep 0.5; done
  echo "ERROR: something still listens on :3101"; return 1
}

if [ "${1:-}" = "--undo" ]; then
  LIVE=$(bg_live_port)
  [ -n "$LIVE" ] || { echo "ERROR: not cut over (no $BG_UPSTREAM_FILE)"; exit 1; }
  sudo test -f "$SITE_BACKUP" || { echo "ERROR: $SITE_BACKUP missing"; exit 1; }
  # isaflow.service runs whatever is in $OLD_DIR; put the live colour's release there.
  sudo rsync -a --delete --exclude=.env.local --exclude='.env.*.bak' --exclude='.env.pre-*' \
    --exclude='.env.backup-*' "$(bg_release_dir "$LIVE")/" "$OLD_DIR/"
  sudo chown -R "$BG_OWNER" "$OLD_DIR"
  site_without_3101 | install_site          # :80 stays on the live colour; :3101 freed
  wait_port_free
  sudo systemctl enable --now isaflow.service
  for _ in $(seq 1 30); do health http://127.0.0.1:3101/api/health && break; sleep 1; done
  health http://127.0.0.1:3101/api/health || { echo "ERROR: isaflow.service not healthy on :3101"; exit 1; }
  sudo cp "$SITE_BACKUP" "$SITE"; sudo nginx -t; sudo nginx -s reload   # :80 back to :3101
  sudo rm -f "$BG_UPSTREAM_FILE"; sudo nginx -t; sudo nginx -s reload
  for p in $BG_PORTS; do sudo systemctl disable --now "isaflow@$p" || true; done
  health https://app.isaflow.co.za/api/health && echo "=== Undo complete: isaflow.service on :3101 ==="
  exit 0
fi

[ -z "$(bg_live_port)" ] || { echo "ERROR: already cut over (live: $(bg_live_port))"; exit 1; }
sudo test -f "$OLD_DIR/server.js" || { echo "ERROR: no release in $OLD_DIR"; exit 1; }
health http://127.0.0.1:3101/api/health || { echo "ERROR: isaflow.service is not healthy now; not cutting over"; exit 1; }

echo "1. Seeding isaflow@$FIRST from the live release ($(sudo cat "$OLD_DIR/RELEASE_SHA"))..."
DIR=$(bg_release_dir "$FIRST")
sudo mkdir -p "$DIR"
sudo rsync -a --delete --exclude=.env.local --exclude='.env.*.bak' --exclude='.env.pre-*' \
  --exclude='.env.backup-*' "$OLD_DIR/" "$DIR/"
sudo chown -R "$BG_OWNER" "$DIR"
bg_sync_static "$OLD_DIR"

echo "2. Starting isaflow@$FIRST..."
sudo cp "$REPO_DIR/scripts/isaflow@.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable "isaflow@$FIRST"
sudo systemctl restart "isaflow@$FIRST"
bg_wait_healthy "$FIRST"

echo "3. nginx :80 -> isaflow@$FIRST (isaflow.service keeps :3101 for now)..."
sudo test -f "$SITE_BACKUP" || sudo cp -p "$SITE" "$SITE_BACKUP"
bg_switch "$FIRST"
site_without_3101 | install_site
health https://app.isaflow.co.za/api/health || { echo "ERROR: public health failed on isaflow@$FIRST — run --undo"; exit 1; }

echo "4. isaflow.service off; nginx takes :3101..."
sudo systemctl disable --now isaflow.service
wait_port_free
install_site < "$NEW_SITE"
health http://127.0.0.1:3101/api/health || { echo "ERROR: :3101 not answering through nginx — run --undo"; exit 1; }
health https://app.isaflow.co.za/api/health || { echo "ERROR: public health failed — run --undo"; exit 1; }
echo "=== Cutover complete: live isaflow@$FIRST at $(bg_record_live "$FIRST") ==="
