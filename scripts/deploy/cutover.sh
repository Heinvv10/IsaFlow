#!/bin/bash
# One-time move of production from the single isaflow.service (:3101) to the
# blue/green pair (2026-10-29). Production change: run only with Hein's go.
# Does not build or migrate; it moves the release that is live now.
#
#   bash scripts/deploy/cutover.sh                     show what changes, change nothing
#   CUTOVER_CONFIRM=yes bash scripts/deploy/cutover.sh cut over (after hours only)
#   bash scripts/deploy/cutover.sh --undo              back to isaflow.service on :3101 (any time)
#
# Order keeps the public host serving throughout: the new colour starts on
# 3111 and nginx :80 moves to it first. Only then does isaflow.service stop and
# nginx take :3101 (the admin host and the cron units): the only window with
# nothing on :3101 is that stop plus one nginx reload, and a failure inside it
# puts isaflow.service straight back. isaflow.service is then masked, so an old
# deploy.sh from another worktree fails loudly instead of "deploying" nothing.
#
# Paths, URLs and commands are overridable (tests run this against a scratch
# folder with stubs); the defaults are production.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=bluegreen.sh
. "$REPO_DIR/scripts/deploy/bluegreen.sh"
SITE="${CUTOVER_SITE:-/etc/nginx/sites-enabled/isaflow-combined}"
# Outside sites-enabled: nginx includes every file in that folder.
SITE_BACKUP="${CUTOVER_SITE_BACKUP:-/etc/nginx/isaflow-combined.pre-bluegreen}"
OLD_UNIT="${CUTOVER_OLD_UNIT:-/etc/systemd/system/isaflow.service}"
OLD_UNIT_BACKUP="${CUTOVER_OLD_UNIT_BACKUP:-/etc/systemd/isaflow.service.pre-bluegreen}"
OLD_DIR="${CUTOVER_OLD_DIR:-/home/velo/isaflow}"
OLD_HEALTH="${CUTOVER_OLD_HEALTH:-http://127.0.0.1:3101/api/health}"   # isaflow.service, or nginx once cut over
FRONT80="${CUTOVER_FRONT80:-http://127.0.0.1}"                          # nginx :80 (Host: app.isaflow.co.za)
NEW_SITE="$REPO_DIR/scripts/nginx/isaflow-combined"
WORK="${CUTOVER_WORK:-$HOME/.cache/isaflow-cutover}"
FIRST=$(echo "$BG_PORTS" | awk '{print $1}')
S="$BG_SUDO"
mkdir -p "$WORK"

health() { curl -sf --max-time 5 "$1" >/dev/null; }
health_retry() { for _ in $(seq 1 15); do health "$1" && return 0; sleep 1; done; return 1; }
port_3101_free() { [ -z "$(ss -Hltn "sport = :3101" 2>/dev/null)" ]; }
wait_port_free() {
  for _ in $(seq 1 40); do port_3101_free && return 0; sleep 0.25; done
  echo "ERROR: something still listens on :3101"; return 1
}
served80_by() {
  local got=""
  for _ in $(seq 1 15); do
    got=$(curl -s -o /dev/null --max-time 5 -H 'Host: app.isaflow.co.za' -H 'X-IsaFlow-Probe: 1' \
      -w '%header{x-isaflow-upstream}' "$FRONT80/api/health" || true)
    [ "$got" = "127.0.0.1:$1" ] && return 0
    sleep 1
  done
  echo "ERROR: nginx :80 answers from '${got:-nothing}', not 127.0.0.1:$1"; return 1
}
# Install a site config from a file: never empty or foreign, swapped in whole,
# validated, and the previous file put back if nginx rejects it or fails to reload.
install_site() {
  local src="$1" prev="$WORK/site.prev"
  [ -s "$src" ] && [ "$(wc -l < "$src")" -ge 10 ] && grep -q 'server_name isaflow.co.za' "$src" \
    || { echo "ERROR: refusing to install an empty or foreign site config ($src)"; return 1; }
  $S cp -p "$SITE" "$prev" || return 1
  $S cp "$src" "$SITE.new" && $S chmod 644 "$SITE.new" && $S mv "$SITE.new" "$SITE" || return 1
  if ! $S "$BG_NGINX" -t || ! $S "$BG_NGINX" -s reload; then
    echo "ERROR: nginx rejected the new site config; previous one restored"
    $S mv "$prev" "$SITE"; $S "$BG_NGINX" -s reload || true
    return 1
  fi
}
# The new config without its :3101 block, checked to really lack it.
make_stripped() {
  bg_site_without_3101 "$NEW_SITE" > "$WORK/site-no3101"
  if grep -qE 'listen[[:space:]]+3101' "$WORK/site-no3101"; then echo "ERROR: could not strip the :3101 block"; return 1; fi
}
# Put isaflow.service back on :3101 as it was (unit file, unmasked, running).
restore_old_service() {
  if $S test -f "$OLD_UNIT_BACKUP"; then
    $S "$BG_SYSTEMCTL" unmask isaflow.service || true
    $S mv "$OLD_UNIT_BACKUP" "$OLD_UNIT"
    $S "$BG_SYSTEMCTL" daemon-reload
  fi
  $S "$BG_SYSTEMCTL" enable --now isaflow.service
  health_retry "$OLD_HEALTH"
}

bg_lock

if [ "${1:-}" = "--undo" ]; then
  $S test -f "$SITE_BACKUP" || { echo "ERROR: $SITE_BACKUP missing"; exit 1; }
  echo "Site changes since the cutover that --undo drops (pre-cutover vs live):"
  $S diff -u "$SITE_BACKUP" "$SITE" || true
  if ! $S "$BG_SYSTEMCTL" is-active --quiet isaflow.service; then
    LIVE=$(bg_live_port)
    [ -n "$LIVE" ] || { echo "ERROR: neither isaflow.service nor a live colour is running"; exit 1; }
    # isaflow.service runs whatever is in $OLD_DIR; put the live colour's release there.
    $S rsync -a --delete --exclude='.env*' "$(bg_release_dir "$LIVE")/" "$OLD_DIR/"
    $S chown -R "$BG_OWNER" "$OLD_DIR"
    make_stripped
    install_site "$WORK/site-no3101"          # :80 stays on the live colour; :3101 freed
    wait_port_free
    if ! restore_old_service; then
      echo "ERROR: isaflow.service did not come back on :3101; nginx takes :3101 again"
      $S "$BG_SYSTEMCTL" disable --now isaflow.service || true
      wait_port_free && install_site "$NEW_SITE"
      exit 1
    fi
  fi
  $S cp "$SITE_BACKUP" "$WORK/site-restore"
  install_site "$WORK/site-restore"           # :80 -> :3101 (isaflow.service)
  $S rm -f "$BG_UPSTREAM_FILE" "$BG_UPSTREAM_FILE.prev"
  $S "$BG_NGINX" -t && $S "$BG_NGINX" -s reload
  for p in $BG_PORTS; do bg_drain "$p"; $S "$BG_SYSTEMCTL" disable --now "isaflow@$p" || true; done
  health_retry "$BG_PUBLIC_HEALTH" || { echo "ERROR: public health failed after undo"; exit 1; }
  echo "=== Undo complete: isaflow.service on :3101. deploy.sh refuses until the next cutover. ==="
  exit 0
fi

[ -z "$(bg_live_port)" ] || { echo "ERROR: already cut over (live: $(bg_live_port))"; exit 1; }
$S test -f "$OLD_DIR/server.js" || { echo "ERROR: no release in $OLD_DIR"; exit 1; }
$S test -f "$OLD_UNIT" && [ ! -L "$OLD_UNIT" ] || { echo "ERROR: $OLD_UNIT is not a regular unit file"; exit 1; }
health "$OLD_HEALTH" || { echo "ERROR: isaflow.service is not healthy now; not cutting over"; exit 1; }
make_stripped
echo "Site config change (live -> repo):"
$S diff -u "$SITE" "$NEW_SITE" || true
echo "Unit and drop-ins on isaflow.service (isaflow@.service must carry them):"
$S "$BG_SYSTEMCTL" cat isaflow.service | grep -E '^# /|^[A-Z]' || true
if [ "${CUTOVER_CONFIRM:-}" != "yes" ]; then echo "Nothing changed. Re-run with CUTOVER_CONFIRM=yes to cut over."; exit 0; fi
if bg_business_hours; then echo "ERROR: the cutover itself runs after hours only (weekday 08:00-17:00 SAST now)"; exit 1; fi

echo "1. Seeding isaflow@$FIRST from the live release ($($S cat "$OLD_DIR/RELEASE_SHA"))..."
bg_sync_release "$OLD_DIR" "$FIRST" "$($S cat "$OLD_DIR/RELEASE_SHA")" release
bg_sync_static "$OLD_DIR"

echo "2. Starting isaflow@$FIRST..."
$S cp "$REPO_DIR/scripts/isaflow@.service" "$BG_UNIT_FILE"
$S "$BG_SYSTEMCTL" daemon-reload
$S "$BG_SYSTEMCTL" enable "isaflow@$FIRST"
bg_start "$FIRST"
bg_clear_marker "$FIRST"   # the release users are on right now

echo "3. nginx :80 -> isaflow@$FIRST (isaflow.service keeps :3101 for now)..."
$S test -f "$SITE_BACKUP" || $S cp -p "$SITE" "$SITE_BACKUP"
bg_switch "$FIRST"
install_site "$WORK/site-no3101" || { $S rm -f "$BG_UPSTREAM_FILE"; echo "ERROR: step 3 failed; nothing else changed"; exit 1; }
served80_by "$FIRST" || { echo "ERROR: run --undo"; exit 1; }
health_retry "$BG_PUBLIC_HEALTH" || { echo "ERROR: public health failed on isaflow@$FIRST — run --undo"; exit 1; }

echo "4. nginx takes :3101 from isaflow.service..."
$S "$BG_SYSTEMCTL" disable --now isaflow.service
if ! wait_port_free || ! install_site "$NEW_SITE" || ! bg_served_by "$FIRST"; then
  echo "ERROR: nginx could not take :3101; putting isaflow.service back"
  make_stripped && install_site "$WORK/site-no3101" || true
  wait_port_free || true
  restore_old_service || echo "!!! isaflow.service did not come back: :3101 is DOWN, act now !!!"
  exit 1
fi
$S mv "$OLD_UNIT" "$OLD_UNIT_BACKUP"
$S "$BG_SYSTEMCTL" daemon-reload
$S "$BG_SYSTEMCTL" mask isaflow.service
health_retry "$BG_PUBLIC_HEALTH" || { echo "ERROR: public health failed — run --undo"; exit 1; }
bg_record_live "$FIRST"
echo "=== Cutover complete: live isaflow@$FIRST at $(bg_sha "$FIRST") ==="
