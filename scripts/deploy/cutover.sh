#!/bin/bash
# One-time move of production from the single isaflow.service (:3101) to the
# blue/green pair (2026-10-29). Production change: run only with Hein's go.
# Does not build or migrate; it moves the release that is live now. Run it in
# tmux (or nohup): a dropped session is recovered from, but best not tested.
#
#   bash scripts/deploy/cutover.sh                     show what changes, change nothing
#   CUTOVER_CONFIRM=yes bash scripts/deploy/cutover.sh cut over (after hours only)
#   bash scripts/deploy/cutover.sh --undo              back to isaflow.service on :3101 (any time)
#
# Order keeps the public host serving throughout: the new colour starts on
# 3111 and nginx :80 moves to it first. Only then does isaflow.service stop and
# nginx take :3101 (the admin host and the cron units). The windows where :3101
# changes hands are guarded: any failure, or a signal, inside one puts the
# previous owner of :3101 straight back. isaflow.service is then masked, so an
# old deploy.sh from another worktree fails instead of "deploying" nothing.
#
# Paths, URLs and commands are overridable (tests run this against a scratch
# folder with stubs); the defaults are production.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=bluegreen.sh
. "$REPO_DIR/scripts/deploy/bluegreen.sh"
SITE="${CUTOVER_SITE:-/etc/nginx/sites-enabled/isaflow-combined}"
SITE_AVAILABLE="${CUTOVER_SITE_AVAILABLE:-/etc/nginx/sites-available/isaflow-combined}"
STAGE="${CUTOVER_STAGE:-/etc/nginx}"     # same filesystem as $SITE, outside sites-enabled (nginx includes all of it)
SITE_BACKUP="$STAGE/isaflow-combined.pre-bluegreen"
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
# The public host at nginx :80: the Host header picks isaflow's server block
# (this box's default :80 server is another site's and drops the request).
public_health() { for _ in $(seq 1 15); do curl -sf --max-time 5 -H "Host: $BG_PUBLIC_HOST" "$BG_PUBLIC_HEALTH" >/dev/null && return 0; sleep 1; done; return 1; }
port_3101_free() { [ -z "$(ss -Hltn "sport = :3101" 2>/dev/null)" ]; }
wait_port_free() {
  for _ in $(seq 1 40); do port_3101_free && return 0; sleep 0.25; done
  echo "ERROR: something still listens on :3101"; return 1
}
served80_by() {
  local got="" token
  token=$(bg_probe_token)
  for _ in $(seq 1 15); do
    got=$(curl -s -o /dev/null --max-time 5 -H 'Host: app.isaflow.co.za' -H "X-IsaFlow-Probe: $token" \
      -w '%header{x-isaflow-upstream}' "$FRONT80/api/health" || true)
    [ "$got" = "127.0.0.1:$1" ] && return 0
    sleep 1
  done
  echo "ERROR: nginx :80 answers from '${got:-nothing}', not 127.0.0.1:$1"; return 1
}
# Install a site config from a file: never empty or foreign, staged beside
# $SITE's folder and moved in whole, validated, and the previous file put back
# if nginx rejects it or fails to reload.
install_site() {
  local src="$1"
  [ -s "$src" ] && [ "$(wc -l < "$src")" -ge 10 ] && grep -q 'server_name isaflow.co.za' "$src" \
    || { echo "ERROR: refusing to install an empty or foreign site config ($src)"; return 1; }
  $S cp -p "$SITE" "$STAGE/isaflow-site.prev" || return 1
  $S cp "$src" "$STAGE/isaflow-site.new" && $S chmod 644 "$STAGE/isaflow-site.new" && $S mv "$STAGE/isaflow-site.new" "$SITE" || return 1
  if ! $S "$BG_NGINX" -t || ! $S "$BG_NGINX" -s reload; then
    echo "ERROR: nginx rejected the new site config; previous one restored"
    $S mv "$STAGE/isaflow-site.prev" "$SITE"; $S "$BG_NGINX" -s reload || true
    return 1
  fi
}
# The new config without its :3101 block, checked to really lack it.
make_stripped() {
  bg_site_without_3101 "$NEW_SITE" > "$WORK/site-no3101"
  if grep -qE 'listen[[:space:]]+3101' "$WORK/site-no3101"; then echo "ERROR: could not strip the :3101 block"; return 1; fi
}
# Put isaflow.service back on :3101 as it was (unit file, unmasked, running),
# proven to be that service answering and not nginx.
restore_old_service() {
  if $S test -f "$OLD_UNIT_BACKUP"; then
    $S "$BG_SYSTEMCTL" unmask isaflow.service || true
    $S mv "$OLD_UNIT_BACKUP" "$OLD_UNIT" || return 1
    $S "$BG_SYSTEMCTL" daemon-reload || return 1
  fi
  $S "$BG_SYSTEMCTL" enable --now isaflow.service || return 1
  health_retry "$OLD_HEALTH" || return 1
  $S "$BG_SYSTEMCTL" is-active --quiet isaflow.service || return 1
  local token; token=$(bg_probe_token)
  [ -n "$token" ] || { echo "ERROR: no probe token in $BG_PROBE_FILE: cannot tell isaflow.service from nginx"; return 1; }
  [ -z "$(curl -s -o /dev/null --max-time 5 -H "X-IsaFlow-Probe: $token" -w '%header{x-isaflow-upstream}' "$OLD_HEALTH")" ] \
    || { echo "ERROR: nginx, not isaflow.service, answers on :3101"; return 1; }
}
# The cron units curl :3101 once and do not retry; wait until none of them is
# running before :3101 changes hands (up to 10 minutes). Only units whose
# command names :3101 count: isaflow-wal-archive and the backups run for long
# or for ever and never touch it.
crons_quiet() {
  local busy="" u
  for _ in $(seq 1 "${CUTOVER_CRON_TRIES:-120}"); do
    busy=""
    for u in $($S "$BG_SYSTEMCTL" list-units --no-legend --state=activating,active 'isaflow-*.service' | awk '{print $1}'); do
      $S "$BG_SYSTEMCTL" cat "$u" 2>/dev/null | grep -q ':3101' && busy="$busy $u"
    done
    [ -z "$busy" ] && return 0
    sleep 5
  done
  echo "ERROR: cron units still running:$busy"; return 1
}
# The properties isaflow.service had that the colour must keep (its drop-ins).
unit_props() { $S "$BG_SYSTEMCTL" show -p OOMScoreAdjust -p MemoryLow -p ManagedOOMPreference -p StateDirectory -p StateDirectoryMode -p User -p NoNewPrivileges -p ProtectSystem -p EnvironmentFiles "$1" | sort; }

# Guarded windows: if the script exits (failure or signal) while WINDOW names a
# recovery function, that function runs.
WINDOW=""
on_exit() {
  local rc=$?
  [ -n "$WINDOW" ] || return 0
  # A second Ctrl-C or HUP must not kill the recovery (children inherit this).
  trap '' INT TERM HUP
  set +e
  echo "!!! stopped inside $WINDOW (exit $rc) — recovering :3101 !!!"
  "$WINDOW"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP
# Cut-over step 4 failed: give :3101 back to isaflow.service.
recover_cutover_3101() {
  echo "ERROR: nginx could not take :3101; putting isaflow.service back"
  make_stripped && install_site "$WORK/site-no3101"
  wait_port_free
  restore_old_service || echo "!!! isaflow.service did not come back: :3101 is DOWN, act now !!!"
}
# Undo failed after freeing :3101: give it back to nginx.
recover_undo_3101() {
  echo "ERROR: isaflow.service did not come back on :3101; nginx takes :3101 again"
  $S "$BG_SYSTEMCTL" disable --now isaflow.service
  wait_port_free && install_site "$NEW_SITE" || echo "!!! nginx could not take :3101 back: :3101 is DOWN, act now !!!"
}

# shellcheck source=../ops/ownerDatabaseUrl.sh
. "$REPO_DIR/scripts/ops/ownerDatabaseUrl.sh"
verify_first() { DATABASE_URL="$(owner_database_url_for "$OLD_DIR/.env.local" $S || true)" bash "$REPO_DIR/scripts/verify-deploy.sh" "$1"; }

bg_lock

if [ "${1:-}" = "--undo" ]; then
  $S test -f "$SITE_BACKUP" || { echo "ERROR: $SITE_BACKUP missing"; exit 1; }
  echo "Site changes since the cutover that --undo drops (pre-cutover vs live):"
  $S diff -u "$SITE_BACKUP" "$SITE" || true
  if ! $S "$BG_SYSTEMCTL" is-active --quiet isaflow.service; then
    LIVE=$(bg_live_port)
    [ -n "$LIVE" ] || { echo "ERROR: neither isaflow.service nor a live colour is running"; exit 1; }
    bg_served_by "$LIVE" || [ "${UNDO_FORCE:-}" = yes ] \
      || { echo "ERROR: nginx does not serve isaflow@$LIVE; re-run with UNDO_FORCE=yes to restore its release anyway"; exit 1; }
    # isaflow.service runs whatever is in $OLD_DIR; put the live colour's release there.
    $S rsync -a --delete --exclude='.env*' "$(bg_release_dir "$LIVE")/" "$OLD_DIR/"
    $S chown -R "$BG_OWNER" "$OLD_DIR"
    make_stripped
    WINDOW=recover_undo_3101
    crons_quiet
    install_site "$WORK/site-no3101"          # :80 stays on the live colour; :3101 freed
    wait_port_free
    restore_old_service
    WINDOW=""
  fi
  $S cp "$SITE_BACKUP" "$WORK/site-restore"
  install_site "$WORK/site-restore"           # :80 -> :3101 (isaflow.service)
  if $S test -f "$SITE_AVAILABLE"; then $S cp "$SITE_BACKUP" "$SITE_AVAILABLE"; fi
  $S rm -f "$BG_UPSTREAM_FILE" "$BG_UPSTREAM_FILE.prev" "$BG_PROBE_FILE"
  $S "$BG_NGINX" -t
  $S "$BG_NGINX" -s reload
  for p in $BG_PORTS; do
    if bg_drain "$p"; then $S "$BG_SYSTEMCTL" disable --now "isaflow@$p" || true
    else echo "WARNING: isaflow@$p still busy; left running (stop it later: sudo systemctl disable --now isaflow@$p)"; fi
  done
  public_health || { echo "ERROR: public health failed after undo"; exit 1; }
  echo "=== Undo complete: isaflow.service on :3101. deploy.sh refuses until the next cutover. ==="
  exit 0
fi

[ -z "$(bg_live_port)" ] || { echo "ERROR: already cut over (live: $(bg_live_port))"; exit 1; }
$S test -f "$OLD_DIR/server.js" || { echo "ERROR: no release in $OLD_DIR"; exit 1; }
{ $S test -f "$OLD_UNIT" && [ ! -L "$OLD_UNIT" ]; } || { echo "ERROR: $OLD_UNIT is not a regular unit file"; exit 1; }
health "$OLD_HEALTH" || { echo "ERROR: isaflow.service is not healthy now; not cutting over"; exit 1; }
make_stripped
echo "Site config change (live -> repo):"
$S diff -u "$SITE" "$NEW_SITE" || true
echo "Unit and drop-ins on isaflow.service (isaflow@.service must carry them):"
$S "$BG_SYSTEMCTL" cat isaflow.service | grep -E '^# /|^[A-Z]' || true
if [ "${CUTOVER_CONFIRM:-}" != "yes" ]; then echo "Nothing changed. Re-run with CUTOVER_CONFIRM=yes to cut over."; exit 0; fi
if bg_business_hours; then echo "ERROR: the cutover itself runs after hours only (weekday 08:00-17:00 SAST now)"; exit 1; fi

echo "1. Seeding isaflow@$FIRST from the live release ($($S cat "$OLD_DIR/RELEASE_SHA"))..."
bg_stop_idle "$FIRST"
bg_sync_release "$OLD_DIR" "$FIRST" "$($S cat "$OLD_DIR/RELEASE_SHA")" release
bg_sync_static "$OLD_DIR"

echo "2. Starting isaflow@$FIRST..."
$S cp "$REPO_DIR/scripts/isaflow@.service" "$BG_UNIT_FILE"
$S "$BG_SYSTEMCTL" daemon-reload
$S "$BG_SYSTEMCTL" enable "isaflow@$FIRST"
bg_start "$FIRST"
# The colour must keep every property isaflow.service had (its drop-ins).
if ! diff <(unit_props isaflow.service | grep -v '^EnvironmentFiles') <(unit_props "isaflow@$FIRST" | grep -v '^EnvironmentFiles'); then
  echo "ERROR: isaflow@$FIRST differs from isaflow.service in the properties above; fix isaflow@.service. Nothing switched."
  $S "$BG_SYSTEMCTL" disable --now "isaflow@$FIRST"; exit 1
fi
# The same verification gate a deploy runs, before any user reaches the colour:
# the unit itself is new (loopback bind, working directory, write paths).
if [ "${SKIP_VERIFY:-0}" != "1" ]; then
  if ! "${BG_VERIFY:-verify_first}" "http://localhost:$FIRST"; then
    echo "ERROR: isaflow@$FIRST failed verification. Nothing switched; isaflow.service still serves."
    $S "$BG_SYSTEMCTL" disable --now "isaflow@$FIRST"; exit 1
  fi
fi
bg_clear_marker "$FIRST"   # the release users are on right now

echo "3. nginx :80 -> isaflow@$FIRST (isaflow.service keeps :3101 for now)..."
$S cp -p "$SITE" "$SITE_BACKUP"     # always the pre-cutover site: this path only runs when not cut over
$S rm -f "$BG_PROBE_FILE"
(umask 077; bg_probe_conf "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')" | $S tee "$BG_PROBE_FILE" >/dev/null)
$S chmod 600 "$BG_PROBE_FILE"
bg_switch "$FIRST"
install_site "$WORK/site-no3101" || { $S rm -f "$BG_UPSTREAM_FILE"; echo "ERROR: step 3 failed; nothing else changed"; exit 1; }
served80_by "$FIRST" || { echo "ERROR: run --undo"; exit 1; }
public_health || { echo "ERROR: public health failed on isaflow@$FIRST — run --undo"; exit 1; }

echo "4. nginx takes :3101 from isaflow.service (once no cron is running)..."
crons_quiet
WINDOW=recover_cutover_3101
$S "$BG_SYSTEMCTL" disable --now isaflow.service
wait_port_free
install_site "$NEW_SITE"
bg_served_by "$FIRST"
WINDOW=""
$S mv "$OLD_UNIT" "$OLD_UNIT_BACKUP"
$S "$BG_SYSTEMCTL" daemon-reload
$S "$BG_SYSTEMCTL" mask isaflow.service
if $S test -f "$SITE_AVAILABLE"; then $S cp "$NEW_SITE" "$SITE_AVAILABLE"; fi
public_health || { echo "ERROR: public health failed — run --undo"; exit 1; }
bg_record_live "$FIRST"
echo "=== Cutover complete: live isaflow@$FIRST at $(bg_sha "$FIRST") ==="
