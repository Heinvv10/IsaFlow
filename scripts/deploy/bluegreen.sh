#!/bin/bash
# Blue/green helpers for scripts/deploy.sh, scripts/rollback-deploy.sh,
# scripts/deploy/restart-colours.sh and scripts/deploy/cutover.sh (2026-10-29).
# Source it; it defines functions only.
#
# Two colours, named by port: isaflow@3111 and isaflow@3112, each running its
# own release folder. nginx fronts the live one (:80 and :3101) through the
# upstream in BG_UPSTREAM_FILE, which only bg_switch writes. A deploy builds
# into the idle colour, verifies it on its own port, then switches; the old
# colour keeps running untouched, so in-flight requests finish and a rollback
# is a switch back.
#
# A colour folder is "unverified" while a marker file sits next to it
# ($BG_RELEASE_ROOT/isaflow-<port>.unverified, outside the folder so no rsync
# removes it): set before its files are touched, cleared only once its build
# passed verification. An aborted or failed deploy leaves it set, and nothing
# switches to an unverified colour.
#
# Every path and command can be overridden so tests can run it against a
# scratch folder with stub commands. Defaults are production.

BG_PORTS="${BG_PORTS:-3111 3112}"
BG_RELEASE_ROOT="${BG_RELEASE_ROOT:-/home/velo}"            # releases: $BG_RELEASE_ROOT/isaflow-<port>
BG_STATIC_ROOT="${BG_STATIC_ROOT:-/home/velo/isaflow-static}" # served as /_next/static/
BG_UPSTREAM_FILE="${BG_UPSTREAM_FILE:-/etc/nginx/conf.d/isaflow-live.conf}"
BG_ENV_HOME="${BG_ENV_HOME:-/home/velo/isaflow}"            # .env.local + RELEASE_SHA of the live colour
BG_UNIT_FILE="${BG_UNIT_FILE:-/etc/systemd/system/isaflow@.service}"
BG_FRONT_URL="${BG_FRONT_URL:-http://127.0.0.1:3101}"        # nginx; names the colour on X-IsaFlow-Probe: 1
BG_PUBLIC_HEALTH="${BG_PUBLIC_HEALTH:-https://app.isaflow.co.za/api/health}"
# Held while colours or the upstream change (deploy from sync to switch,
# rollback, restart-colours, cutover). deploy.sh's own lock, against a second
# deploy, is a different file, so a rollback is not blocked by a deploy's CI.
BG_LOCK_FILE="${BG_LOCK_FILE:-/tmp/isaflow-colours.lock}"
BG_KEEP_BUILDS="${BG_KEEP_BUILDS:-5}"
BG_HEALTH_TRIES="${BG_HEALTH_TRIES:-60}"
BG_BUN="${BG_BUN:-/home/hein/.bun/bin/bun}"
BG_SUDO="${BG_SUDO-sudo}"
BG_SYSTEMCTL="${BG_SYSTEMCTL:-systemctl}"
BG_NGINX="${BG_NGINX:-nginx}"
BG_OWNER="${BG_OWNER:-velo:velo}"

bg_lock() {
  exec 8>"$BG_LOCK_FILE"
  flock -n 8 || { echo "ERROR: a deploy, rollback, restart or cutover is changing colours now (lock: $BG_LOCK_FILE)" >&2; return 1; }
}

bg_release_dir() { echo "$BG_RELEASE_ROOT/isaflow-$1"; }
bg_marker() { echo "$BG_RELEASE_ROOT/isaflow-$1.unverified"; }
bg_failed() { $BG_SUDO test -f "$(bg_marker "$1")"; }
bg_mark_failed() { echo "$2" | $BG_SUDO tee "$(bg_marker "$1")" >/dev/null; }
bg_clear_marker() { $BG_SUDO rm -f "$(bg_marker "$1")"; }
bg_sha() { $BG_SUDO cat "$(bg_release_dir "$1")/RELEASE_SHA" 2>/dev/null || echo unknown; }

# The live port, read from the upstream file. Empty when there is none (before
# the cutover) or it names anything but one of BG_PORTS.
bg_live_port() {
  local port p
  port=$($BG_SUDO cat "$BG_UPSTREAM_FILE" 2>/dev/null \
    | sed -nE 's/^[[:space:]]*server[[:space:]]+127\.0\.0\.1:([0-9]+);.*/\1/p' | head -1)
  for p in $BG_PORTS; do
    [ "$p" = "$port" ] && { echo "$p"; return 0; }
  done
  echo ""
}

bg_other_port() {
  local p
  for p in $BG_PORTS; do
    [ "$p" != "$1" ] && { echo "$p"; return 0; }
  done
}

# Wait (up to BG_DRAIN_SECS) until nothing is connected to a colour: a request
# that began before a switch may still be running on it.
bg_drain() {
  local port="$1"
  for _ in $(seq 1 "${BG_DRAIN_SECS:-120}"); do
    [ -z "$(ss -Htn state established "( sport = :$port )" 2>/dev/null)" ] && return 0
    sleep 1
  done
  echo "WARNING: isaflow@$port still has connections after ${BG_DRAIN_SECS:-120}s; going on" >&2
}

# Stop a colour that is NOT live, once drained, so its files can be replaced
# under no running process.
bg_stop_idle() {
  local port="$1"
  [ "$port" = "$(bg_live_port)" ] && { echo "ERROR: refusing to stop the LIVE colour $port" >&2; return 1; }
  bg_drain "$port"
  $BG_SUDO "$BG_SYSTEMCTL" stop "isaflow@$port" || true
}

# Copy a tree into the idle colour's folder: a built repo (.next/standalone,
# .next/static, public) or, with "release", another colour's release folder.
# Marks the colour unverified first; never touches the live colour's folder.
bg_sync_release() {
  local src="$1" port="$2" sha="$3" kind="${4:-build}" dir
  dir=$(bg_release_dir "$port")
  [ "$port" = "$(bg_live_port)" ] && { echo "ERROR: refusing to write the LIVE colour's folder $dir" >&2; return 1; }
  # Every step is checked: callers may run this with errexit off.
  bg_mark_failed "$port" "$sha: files being replaced" || return 1
  $BG_SUDO mkdir -p "$dir" || return 1
  if [ "$kind" = release ]; then
    $BG_SUDO rsync -a --delete --exclude='.env*' "$src/" "$dir/" || return 1
  else
    $BG_SUDO rsync -a --delete "$src/.next/standalone/" "$dir/" || return 1
    $BG_SUDO mkdir -p "$dir/.next" "$dir/public" || return 1
    $BG_SUDO rsync -a --delete "$src/.next/static/" "$dir/.next/static/" || return 1
    $BG_SUDO rsync -a --delete "$src/public/" "$dir/public/" || return 1
    # Sharp belt-and-braces: the standalone trace has historically missed its
    # native binaries (next.config.js outputFileTracingIncludes).
    if [ -d "$src/node_modules/sharp" ]; then $BG_SUDO rsync -a "$src/node_modules/sharp/" "$dir/node_modules/sharp/" || return 1; fi
    if [ -d "$src/node_modules/@img" ]; then $BG_SUDO rsync -a "$src/node_modules/@img/" "$dir/node_modules/@img/" || return 1; fi
    # Inject BUILD_ID into sw.js so stale caches are evicted on every deploy.
    $BG_SUDO sed -i "s/__BUILD_ID__/$(cat "$src/.next/BUILD_ID")/g" "$dir/public/sw.js" || return 1
    echo "$sha" | $BG_SUDO tee "$dir/RELEASE_SHA" >/dev/null || return 1
  fi
  $BG_SUDO chown -R "$BG_OWNER" "$dir"
}

# Add a build's hashed static files to the shared folder (never --delete),
# record which files the build has, and remove only files that none of the
# last BG_KEEP_BUILDS builds has. Content-hashed names never collide. Called
# only for a build that passed verification, so failed builds take no slot.
bg_sync_static() {
  local src="$1" build_id lists keep l
  build_id=$($BG_SUDO cat "$src/.next/BUILD_ID")
  $BG_SUDO mkdir -p "$BG_STATIC_ROOT/_next/static" "$BG_STATIC_ROOT/.builds"
  $BG_SUDO rsync -a "$src/.next/static/" "$BG_STATIC_ROOT/_next/static/" || return 1
  $BG_SUDO find "$src/.next/static" -type f -printf '%P\n' | LC_ALL=C sort \
    | $BG_SUDO tee "$BG_STATIC_ROOT/.builds/$build_id.list" >/dev/null
  $BG_SUDO touch "$BG_STATIC_ROOT/.builds/$build_id.list"
  lists=$($BG_SUDO ls -t "$BG_STATIC_ROOT/.builds/" | grep '\.list$' | head -n "$BG_KEEP_BUILDS")
  keep=$(for l in $lists; do $BG_SUDO cat "$BG_STATIC_ROOT/.builds/$l"; done | LC_ALL=C sort -u)
  # Fail closed: an empty keep-set would delete everything.
  [ -z "$keep" ] && { echo "ERROR: static keep-set is empty; nothing pruned" >&2; return 1; }
  $BG_SUDO find "$BG_STATIC_ROOT/_next/static" -type f -printf '%P\n' | LC_ALL=C sort \
    | LC_ALL=C comm -23 - <(echo "$keep") \
    | while IFS= read -r f; do $BG_SUDO rm -f "$BG_STATIC_ROOT/_next/static/$f"; done
  for l in $($BG_SUDO ls -t "$BG_STATIC_ROOT/.builds/" | grep '\.list$' | tail -n +"$((BG_KEEP_BUILDS + 1))"); do
    $BG_SUDO rm -f "$BG_STATIC_ROOT/.builds/$l"
  done
  # nginx (www-data) reads these.
  $BG_SUDO chmod -R a+rX "$BG_STATIC_ROOT"
}

bg_wait_healthy() {
  local port="$1"
  for _ in $(seq 1 "$BG_HEALTH_TRIES"); do
    curl -sf --max-time 5 "http://127.0.0.1:$port/api/health" >/dev/null && return 0
    sleep 2
  done
  echo "ERROR: isaflow@$port not healthy on http://127.0.0.1:$port/api/health" >&2
  return 1
}

# (Re)start a colour that is NOT live, once drained, and wait for it to answer.
bg_start() {
  local port="$1"
  [ "$port" = "$(bg_live_port)" ] && { echo "ERROR: refusing to restart the LIVE colour $port" >&2; return 1; }
  bg_drain "$port"
  $BG_SUDO "$BG_SYSTEMCTL" restart "isaflow@$port" || return 1
  bg_wait_healthy "$port"
}

# Take a colour out of service after its build failed: stopped, not started at
# boot, marked so nothing switches to it. Never the live colour.
bg_retire_failed() {
  local port="$1" why="$2"
  [ "$port" = "$(bg_live_port)" ] && { echo "ERROR: isaflow@$port is LIVE; not stopping it" >&2; return 1; }
  $BG_SUDO "$BG_SYSTEMCTL" disable --now "isaflow@$port" || true
  bg_mark_failed "$port" "$why"
}

_bg_restore_upstream() {
  if $BG_SUDO test -f "$1"; then $BG_SUDO mv "$1" "$BG_UPSTREAM_FILE"; else $BG_SUDO rm -f "$BG_UPSTREAM_FILE"; fi
}

# Point nginx at a port. The new file is validated before nginx reloads; if
# validation or the reload fails the previous file is put back. A reload is
# graceful: old workers finish their in-flight requests.
bg_switch() {
  local port="$1" tmp backup out
  [ -n "$port" ] || { echo "ERROR: bg_switch needs a port" >&2; return 1; }
  bg_failed "$port" && { echo "ERROR: isaflow@$port is unverified ($($BG_SUDO cat "$(bg_marker "$port")")); not switching to it" >&2; return 1; }
  tmp="$BG_UPSTREAM_FILE.new.$$"
  backup="$BG_UPSTREAM_FILE.prev"
  $BG_SUDO rm -f "$backup"
  printf 'upstream isaflow_live {\n    server 127.0.0.1:%s;\n}\n' "$port" | $BG_SUDO tee "$tmp" >/dev/null
  if $BG_SUDO test -f "$BG_UPSTREAM_FILE"; then $BG_SUDO cp -p "$BG_UPSTREAM_FILE" "$backup"; fi
  $BG_SUDO mv "$tmp" "$BG_UPSTREAM_FILE"
  if ! out=$($BG_SUDO "$BG_NGINX" -t 2>&1); then
    echo "ERROR: nginx -t failed with isaflow_live -> $port; previous upstream restored. nginx said:" >&2
    echo "$out" >&2
    _bg_restore_upstream "$backup"
    return 1
  fi
  if ! $BG_SUDO "$BG_NGINX" -s reload; then
    echo "ERROR: nginx reload failed; previous upstream restored" >&2
    _bg_restore_upstream "$backup"
    $BG_SUDO "$BG_NGINX" -s reload || true
    return 1
  fi
  [ "$(bg_live_port)" = "$port" ] || { echo "ERROR: upstream does not name $port after the switch" >&2; return 1; }
}

# 0 once nginx itself answers from the given colour (X-IsaFlow-Upstream, sent
# only to a request carrying X-IsaFlow-Probe: 1), not merely once the file says so.
bg_served_by() {
  local port="$1" got=""
  for _ in $(seq 1 15); do
    got=$(curl -s -o /dev/null --max-time 5 -H 'X-IsaFlow-Probe: 1' -w '%header{x-isaflow-upstream}' "$BG_FRONT_URL/api/health" || true)
    [ "$got" = "127.0.0.1:$port" ] && return 0
    sleep 1
  done
  echo "ERROR: nginx at $BG_FRONT_URL answers from '${got:-nothing}', not 127.0.0.1:$port" >&2
  return 1
}

# Record the live colour's SHA where operators and checks read it.
bg_record_live() { bg_sha "$1" | $BG_SUDO tee "$BG_ENV_HOME/RELEASE_SHA" >/dev/null; }

# Switch to a colour and prove nginx serves it; if that proof fails, switch
# back to where it was. Returns 1 after a switch-back, 2 if the switch-back
# also failed (the operator must act).
bg_switch_proven() {
  local port="$1" from="$2"
  bg_switch "$port" || return 1
  if bg_served_by "$port" && curl -sf --max-time 10 --retry 5 --retry-delay 2 --retry-all-errors "$BG_PUBLIC_HEALTH" >/dev/null; then
    return 0
  fi
  echo "!!! isaflow@$port not proven through nginx/$BG_PUBLIC_HEALTH — switching back to isaflow@$from !!!" >&2
  bg_switch "$from" && bg_served_by "$from" && return 1
  echo "!!! SWITCH-BACK FAILED: check nginx and $BG_UPSTREAM_FILE now !!!" >&2
  return 2
}

# Steps 3-7 of deploy.sh, under bg_lock: replace the idle colour with the
# build in $1 (SHA $2), start it, verify it with "$BG_VERIFY <url>", then
# switch nginx to it. The live colour is never written, stopped or restarted.
# A build that fails to start or verify is retired; a verified build that
# could not be switched in stays idle and verified. Returns non-zero on any failure.
bg_deploy_release() {
  local repo="$1" sha="$2" live idle rc
  live=$(bg_live_port)
  [ -n "$live" ] || { echo "ERROR: no live colour in $BG_UPSTREAM_FILE" >&2; return 1; }
  idle=$(bg_other_port "$live")
  bg_served_by "$live" || { echo "ERROR: nginx is not serving isaflow@$live although $BG_UPSTREAM_FILE names it; not deploying" >&2; return 1; }

  echo "Replacing isaflow@$idle ($(bg_release_dir "$idle")) with $sha..."
  bg_stop_idle "$idle"
  bg_sync_release "$repo" "$idle" "$sha" || { bg_retire_failed "$idle" "$sha: copy failed"; return 1; }
  # The unit template: the previous one is kept and put back if this build
  # fails (the live colour restarts from it after a crash).
  if $BG_SUDO test -f "$BG_UNIT_FILE"; then $BG_SUDO cp -p "$BG_UNIT_FILE" "$BG_UNIT_FILE.prev"; fi
  local why=""
  if ! $BG_SUDO cp "$repo/scripts/isaflow@.service" "$BG_UNIT_FILE" || ! $BG_SUDO "$BG_SYSTEMCTL" daemon-reload \
    || ! $BG_SUDO "$BG_SYSTEMCTL" enable "isaflow@$idle"; then why="unit install failed"
  elif ! bg_start "$idle"; then why="did not start"
  elif ! "$BG_VERIFY" "http://localhost:$idle" 8>&- 9>&-; then why="VERIFICATION FAILED"
  fi
  if [ -n "$why" ]; then
    echo "!!! $why — users stay on isaflow@$live; retiring isaflow@$idle !!!" >&2
    bg_retire_failed "$idle" "$sha: $why" || true
    if $BG_SUDO test -f "$BG_UNIT_FILE.prev"; then $BG_SUDO mv "$BG_UNIT_FILE.prev" "$BG_UNIT_FILE"; $BG_SUDO "$BG_SYSTEMCTL" daemon-reload; fi
    return 1
  fi
  bg_clear_marker "$idle"
  $BG_SUDO rm -f "$BG_UNIT_FILE.prev"

  bg_sync_static "$repo" || { echo "ERROR: static files not published; isaflow@$idle stays idle (verified)" >&2; return 1; }
  echo "Switching nginx: isaflow@$live -> isaflow@$idle..."
  rc=0; bg_switch_proven "$idle" "$live" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  bg_record_live "$idle"
  echo "Live: isaflow@$idle at $sha. isaflow@$live keeps running as the rollback (scripts/rollback-deploy.sh)."
}

# 0 when it is a weekday 08:00-16:59 in Johannesburg.
bg_business_hours() {
  local dow hour
  dow=$(TZ=Africa/Johannesburg date +%u)
  hour=$((10#$(TZ=Africa/Johannesburg date +%H)))
  [ "$dow" -le 5 ] && [ "$hour" -ge 8 ] && [ "$hour" -lt 17 ]
}

# A migration changes the one database the live colour is still reading, so a
# release that carries one waits for after hours (Hein, 2026-10-29). Returns 1
# in business hours unless apply-migrations' plan says nothing is pending. Fails
# closed: no readable plan counts as pending.
bg_midday_migration_check() {
  local db="$1" repo="$2" pending
  bg_business_hours || return 0
  pending=$(DATABASE_URL="$db" "$BG_BUN" "$repo/scripts/apply-migrations.ts" --dry-run 2>/dev/null \
    | sed -nE 's/^  toApply: *//p' || true)
  [ "$pending" = "(none)" ] && return 0
  echo "ERROR: pending migrations (${pending:-unknown}): a release with a migration deploys after 17:00 SAST or at the weekend" >&2
  return 1
}

# The new site config without its :3101 server block (that block starts at
# the marker comment and runs to the end of the file).
bg_site_without_3101() { sed '/^# :3101 was the app.s own port/,$d' "$1"; }
