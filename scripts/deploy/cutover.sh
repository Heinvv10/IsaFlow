#!/bin/bash
# One-time move of production from the single isaflow.service (:3101) to the
# blue/green pair (2026-10-29). Production change: run only with Hein's go,
# after hours (it refuses 08:00-17:00 on weekdays). Does not build or migrate;
# it moves the release that is live now.
#
#   bash scripts/deploy/cutover.sh                     show what changes, change nothing
#   CUTOVER_CONFIRM=yes bash scripts/deploy/cutover.sh cut over
#   bash scripts/deploy/cutover.sh --undo              back to isaflow.service on :3101
#
# Order keeps the public host serving throughout: the new colour starts on
# 3111 and nginx :80 moves to it first; only then does isaflow.service stop and
# nginx take over :3101 (the admin host and the cron units: about a second of
# refused connections there). isaflow.service is then masked, so an old
# deploy.sh from another worktree fails loudly instead of "deploying" nothing.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=bluegreen.sh
. "$REPO_DIR/scripts/deploy/bluegreen.sh"
SITE=/etc/nginx/sites-enabled/isaflow-combined
# Outside sites-enabled: nginx includes every file in that folder.
SITE_BACKUP=/etc/nginx/isaflow-combined.pre-bluegreen
OLD_UNIT=/etc/systemd/system/isaflow.service
OLD_UNIT_BACKUP=/etc/systemd/isaflow.service.pre-bluegreen
NEW_SITE="$REPO_DIR/scripts/nginx/isaflow-combined"
OLD_DIR=/home/velo/isaflow
FIRST=$(echo "$BG_PORTS" | awk '{print $1}')

health() { curl -sf --max-time 5 "$1" >/dev/null; }
health_retry() { for _ in $(seq 1 15); do health "$1" && return 0; sleep 1; done; return 1; }
wait_port_free() {
  for _ in $(seq 1 40); do ss -ltn "sport = :3101" | grep -q LISTEN || return 0; sleep 0.25; done
  echo "ERROR: something still listens on :3101"; return 1
}
# Install a site config from a file: never empty, swapped in whole, validated,
# and the previous file put back if nginx rejects it or fails to reload.
install_site() {
  local src="$1" tmp prev
  [ "$(wc -l < "$src")" -ge 10 ] && grep -q 'server_name isaflow.co.za' "$src" \
    || { echo "ERROR: refusing to install an empty or foreign site config ($src)"; return 1; }
  tmp=$(sudo mktemp /etc/nginx/isaflow-site.XXXXXX); prev=$(sudo mktemp /etc/nginx/isaflow-site-prev.XXXXXX)
  sudo cp "$src" "$tmp"; sudo chmod 644 "$tmp"
  sudo cp -p "$SITE" "$prev"
  sudo mv "$tmp" "$SITE"
  if ! sudo nginx -t || ! sudo nginx -s reload; then
    echo "ERROR: nginx rejected the new site config; previous one restored"
    sudo mv "$prev" "$SITE"; sudo nginx -s reload || true
    return 1
  fi
  sudo rm -f "$prev"
}
stripped_site() {
  local out
  out=$(mktemp -p "$HOME/.cache" isaflow-site-no3101.XXXXXX)
  bg_site_without_3101 "$NEW_SITE" > "$out"
  if grep -qE 'listen[[:space:]]+3101' "$out"; then echo "ERROR: could not strip the :3101 block" >&2; return 1; fi
  echo "$out"
}

bg_lock
if bg_business_hours; then echo "ERROR: cutover is after hours only (weekday 08:00-17:00 SAST now)"; exit 1; fi

if [ "${1:-}" = "--undo" ]; then
  sudo test -f "$SITE_BACKUP" || { echo "ERROR: $SITE_BACKUP missing"; exit 1; }
  echo "Site changes since the cutover that --undo drops (live vs pre-cutover):"
  sudo diff -u "$SITE_BACKUP" "$SITE" || true
  if [ -f "$OLD_UNIT_BACKUP" ] || sudo test -f "$OLD_UNIT_BACKUP"; then
    sudo systemctl unmask isaflow.service
    sudo mv "$OLD_UNIT_BACKUP" "$OLD_UNIT"
    sudo systemctl daemon-reload
  fi
  if ! sudo systemctl is-active --quiet isaflow.service; then
    LIVE=$(bg_live_port)
    [ -n "$LIVE" ] || { echo "ERROR: neither isaflow.service nor a live colour is running"; exit 1; }
    # isaflow.service runs whatever is in $OLD_DIR; put the live colour's release there.
    sudo rsync -a --delete --exclude=.env.local --exclude='.env.*.bak' --exclude='.env.pre-*' \
      --exclude='.env.backup-*' "$(bg_release_dir "$LIVE")/" "$OLD_DIR/"
    sudo chown -R "$BG_OWNER" "$OLD_DIR"
    STRIPPED=$(stripped_site)
    install_site "$STRIPPED"                  # :80 stays on the live colour; :3101 freed
    wait_port_free
    sudo systemctl enable --now isaflow.service
    health_retry http://127.0.0.1:3101/api/health || { echo "ERROR: isaflow.service not healthy on :3101"; exit 1; }
  fi
  sudo cp "$SITE_BACKUP" "$HOME/.cache/isaflow-site-restore"; install_site "$HOME/.cache/isaflow-site-restore"   # :80 -> :3101
  sudo rm -f "$BG_UPSTREAM_FILE" "$BG_UPSTREAM_FILE.prev"; sudo nginx -t; sudo nginx -s reload
  for p in $BG_PORTS; do sudo systemctl disable --now "isaflow@$p" || true; done
  health_retry https://app.isaflow.co.za/api/health || { echo "ERROR: public health failed after undo"; exit 1; }
  echo "=== Undo complete: isaflow.service on :3101. deploy.sh refuses until the next cutover. ==="
  exit 0
fi

[ -z "$(bg_live_port)" ] || { echo "ERROR: already cut over (live: $(bg_live_port))"; exit 1; }
sudo test -f "$OLD_DIR/server.js" || { echo "ERROR: no release in $OLD_DIR"; exit 1; }
health http://127.0.0.1:3101/api/health || { echo "ERROR: isaflow.service is not healthy now; not cutting over"; exit 1; }
echo "Site config change (live -> repo):"
sudo diff -u "$SITE" "$NEW_SITE" || true
echo "Unit drop-ins on isaflow.service (must be carried by isaflow@.service):"
sudo systemctl cat isaflow.service | grep -E '^# /|^[A-Z]' || true
if [ "${CUTOVER_CONFIRM:-}" != "yes" ]; then echo "Nothing changed. Re-run with CUTOVER_CONFIRM=yes to cut over."; exit 0; fi

echo "1. Seeding isaflow@$FIRST from the live release ($(sudo cat "$OLD_DIR/RELEASE_SHA"))..."
DIR=$(bg_release_dir "$FIRST")
sudo mkdir -p "$DIR"
sudo rsync -a --delete --exclude=.env.local --exclude='.env.*.bak' --exclude='.env.pre-*' \
  --exclude='.env.backup-*' "$OLD_DIR/" "$DIR/"
sudo rm -f "$DIR/FAILED"
sudo chown -R "$BG_OWNER" "$DIR"
bg_sync_static "$OLD_DIR"

echo "2. Starting isaflow@$FIRST..."
sudo cp "$REPO_DIR/scripts/isaflow@.service" "$BG_UNIT_FILE"
sudo systemctl daemon-reload
sudo systemctl enable "isaflow@$FIRST"
sudo systemctl restart "isaflow@$FIRST"
bg_wait_healthy "$FIRST"

echo "3. nginx :80 -> isaflow@$FIRST (isaflow.service keeps :3101 for now)..."
sudo test -f "$SITE_BACKUP" || sudo cp -p "$SITE" "$SITE_BACKUP"
bg_switch "$FIRST"
STRIPPED=$(stripped_site)
install_site "$STRIPPED"
for _ in $(seq 1 15); do
  [ "$(curl -s -o /dev/null -H 'Host: app.isaflow.co.za' -w '%header{x-isaflow-upstream}' http://127.0.0.1/api/health)" = "127.0.0.1:$FIRST" ] && break
  sleep 1
done
[ "$(curl -s -o /dev/null -H 'Host: app.isaflow.co.za' -w '%header{x-isaflow-upstream}' http://127.0.0.1/api/health)" = "127.0.0.1:$FIRST" ] \
  || { echo "ERROR: nginx :80 is not answering from isaflow@$FIRST — run --undo"; exit 1; }
health_retry https://app.isaflow.co.za/api/health || { echo "ERROR: public health failed on isaflow@$FIRST — run --undo"; exit 1; }

echo "4. isaflow.service off and masked; nginx takes :3101..."
sudo systemctl disable --now isaflow.service
sudo mv "$OLD_UNIT" "$OLD_UNIT_BACKUP"
sudo systemctl daemon-reload
sudo systemctl mask isaflow.service
wait_port_free
install_site "$NEW_SITE"
bg_served_by "$FIRST" || { echo "ERROR: :3101 not answering from isaflow@$FIRST through nginx — run --undo"; exit 1; }
health_retry https://app.isaflow.co.za/api/health || { echo "ERROR: public health failed — run --undo"; exit 1; }
bg_record_live "$FIRST"
echo "=== Cutover complete: live isaflow@$FIRST at $(sudo cat "$DIR/RELEASE_SHA") ==="
