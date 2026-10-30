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
BG_FRONT_URL="${BG_FRONT_URL:-http://127.0.0.1:3101}"        # nginx; names the colour to a probe (below)
# The probe's token: nginx answers X-IsaFlow-Upstream only to a request whose
# X-IsaFlow-Probe header carries it. Root-only file written by cutover.sh.
BG_PROBE_FILE="${BG_PROBE_FILE:-/etc/nginx/conf.d/isaflow-probe.conf}"
BG_WEB_USER="${BG_WEB_USER:-www-data}"                       # nginx's user; must read the static folder
# What users reach, checked at nginx :80 itself (not through Cloudflare, whose
# blips would cause needless switch-backs).
BG_PUBLIC_HEALTH="${BG_PUBLIC_HEALTH:-http://127.0.0.1/api/health}"
BG_PUBLIC_HOST="${BG_PUBLIC_HOST:-app.isaflow.co.za}"
# Held while colours or the upstream change (deploy from sync to switch,
# rollback, restart-colours, cutover). deploy.sh's own lock, against a second
# deploy, is a different file, so a rollback is not blocked by a deploy's CI.
BG_LOCK_FILE="${BG_LOCK_FILE:-/tmp/isaflow-colours.lock}"
BG_KEEP_BUILDS="${BG_KEEP_BUILDS:-5}"
# A request may run this long on a colour being left (the :3101 front allows an
# hour; cron routes run minutes). Stopping a colour waits for it, then refuses.
BG_DRAIN_SECS="${BG_DRAIN_SECS:-900}"
BG_HEALTH_TRIES="${BG_HEALTH_TRIES:-60}"
BG_BUN="${BG_BUN:-/home/hein/.bun/bin/bun}"
BG_SUDO="${BG_SUDO-sudo}"
BG_SYSTEMCTL="${BG_SYSTEMCTL:-systemctl}"
BG_NGINX="${BG_NGINX:-nginx}"
BG_OWNER="${BG_OWNER:-velo:velo}"

# Wait up to $1 seconds (default: none) for the lock.
bg_lock() {
  exec 8>"$BG_LOCK_FILE"
  flock -w "${1:-0}" 8 || { echo "ERROR: a deploy, rollback, restart or cutover is changing colours now (lock: $BG_LOCK_FILE)" >&2; return 1; }
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
# that began before a switch may still be running on it. Returns 1 if it never
# drains, so no caller cuts that request.
bg_drain() {
  local port="$1" out
  for _ in $(seq 1 "$BG_DRAIN_SECS"); do
    # An ss failure counts as "still connected", never as drained.
    if out=$(ss -Htn state established "( sport = :$port )"); then [ -z "$out" ] && return 0; fi
    sleep 1
  done
  echo "ERROR: isaflow@$port still has connections after ${BG_DRAIN_SECS}s; not stopping it" >&2
  return 1
}

# Stop a colour that is NOT live, once drained, so its files can be replaced
# under no running process. Fails unless it is really stopped.
bg_stop_idle() {
  local port="$1"
  [ "$port" = "$(bg_live_port)" ] && { echo "ERROR: refusing to stop the LIVE colour $port" >&2; return 1; }
  bg_drain "$port" || return 1
  $BG_SUDO "$BG_SYSTEMCTL" stop "isaflow@$port" || true
  if $BG_SUDO "$BG_SYSTEMCTL" is-active --quiet "isaflow@$port"; then
    echo "ERROR: isaflow@$port is still running after stop" >&2; return 1
  fi
  # Nothing else may hold the port, or the new process dies on EADDRINUSE while
  # the stray answers its health check.
  if [ -n "$(ss -Hltn "sport = :$port")" ]; then
    echo "ERROR: something still listens on :$port after isaflow@$port stopped" >&2; return 1
  fi
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
    local build_id
    build_id=$(cat "$src/.next/BUILD_ID") && [ -n "$build_id" ] || { echo "ERROR: no BUILD_ID in $src/.next" >&2; return 1; }
    $BG_SUDO sed -i "s/__BUILD_ID__/$build_id/g" "$dir/public/sw.js" || return 1
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
  # nginx (www-data) reads these; prove it can, or chunks silently fall back.
  $BG_SUDO chmod -R a+rX "$BG_STATIC_ROOT" || return 1
  bg_web_can_read "$BG_STATIC_ROOT/.builds/$build_id.list"
}

# 0 when nginx's user can read a file (each parent folder traversable).
# Skipped when not running through sudo (tests).
bg_web_can_read() {
  [ -z "$BG_SUDO" ] && return 0
  $BG_SUDO -n -u "$BG_WEB_USER" test -r "$1" && return 0
  echo "ERROR: $BG_WEB_USER cannot read $1 (check the folders above it)" >&2
  return 1
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
  bg_drain "$port" || return 1
  $BG_SUDO "$BG_SYSTEMCTL" restart "isaflow@$port" || return 1
  bg_wait_healthy "$port" || return 1
  bg_listener_is_unit "$port"
}

# 0 when the process listening on a colour's port is that colour's unit (not a
# stray answering in its place). Needs sudo to see another user's PIDs; skipped
# without it (tests).
bg_listener_is_unit() {
  local port="$1" main listener
  [ -z "$BG_SUDO" ] && return 0
  main=$($BG_SUDO "$BG_SYSTEMCTL" show -p MainPID --value "isaflow@$port")
  listener=$($BG_SUDO ss -Hltnp "sport = :$port" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  [ -n "$listener" ] && [ "$listener" = "$main" ] && return 0
  echo "ERROR: :$port is held by pid ${listener:-none}, not isaflow@$port (MainPID $main)" >&2
  return 1
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
  if $BG_SUDO test -f "$BG_UPSTREAM_FILE"; then $BG_SUDO cp -p "$BG_UPSTREAM_FILE" "$backup" || { $BG_SUDO rm -f "$tmp"; return 1; }; fi
  # From here until nginx has reloaded, a signal puts the previous file back, so
  # the file never names a colour nginx is not serving.
  local saved_traps
  saved_traps=$(trap -p INT TERM HUP)
  trap '_bg_restore_upstream "'"$backup"'"; exit 130' INT TERM HUP
  $BG_SUDO mv "$tmp" "$BG_UPSTREAM_FILE"
  if ! out=$($BG_SUDO "$BG_NGINX" -t 2>&1); then
    echo "ERROR: nginx -t failed with isaflow_live -> $port; previous upstream restored. nginx said:" >&2
    echo "$out" >&2
    _bg_restore_upstream "$backup"
    trap - INT TERM HUP; eval "$saved_traps"
    return 1
  fi
  if ! $BG_SUDO "$BG_NGINX" -s reload; then
    echo "ERROR: nginx reload failed; previous upstream restored" >&2
    _bg_restore_upstream "$backup"
    $BG_SUDO "$BG_NGINX" -s reload || true
    trap - INT TERM HUP; eval "$saved_traps"
    return 1
  fi
  trap - INT TERM HUP; eval "$saved_traps"
  [ "$(bg_live_port)" = "$port" ] || { echo "ERROR: upstream does not name $port after the switch" >&2; return 1; }
}

# 0 once nginx itself answers from the given colour (X-IsaFlow-Upstream, sent
# only to a request carrying the probe token), not merely once the file says so.
# The probe file cutover.sh installs (root-only): token -> colour header.
bg_probe_conf() {
  printf '# Written by scripts/deploy/cutover.sh: the deploy probe token. Root-only.\nmap $http_x_isaflow_probe $isaflow_upstream_probe {\n    "%s" $upstream_addr;\n    default "";\n}\n' "$1"
}

bg_probe_token() { $BG_SUDO sed -nE 's/^[[:space:]]*"([A-Za-z0-9]+)"[[:space:]]+\$upstream_addr;.*/\1/p' "$BG_PROBE_FILE" 2>/dev/null | head -1; }

bg_served_by() {
  local port="$1" got="" token
  token=$(bg_probe_token)
  [ -n "$token" ] || { echo "ERROR: no probe token in $BG_PROBE_FILE" >&2; return 1; }
  for _ in $(seq 1 15); do
    got=$(curl -s -o /dev/null --max-time 5 -H "X-IsaFlow-Probe: $token" -w '%header{x-isaflow-upstream}' "$BG_FRONT_URL/api/health" || true)
    [ "$got" = "127.0.0.1:$port" ] && return 0
    sleep 1
  done
  echo "ERROR: nginx at $BG_FRONT_URL answers from '${got:-nothing}', not 127.0.0.1:$port" >&2
  return 1
}

# Record the live colour's SHA where operators and checks read it.
bg_record_live() { bg_sha "$1" | $BG_SUDO tee "$BG_ENV_HOME/RELEASE_SHA" >/dev/null; }

# The deploy flow (bg_switch_proven, bg_deploy_release) and the clock and
# migration checks live next door.
# shellcheck source=bluegreen-deploy.sh
. "$(dirname "${BASH_SOURCE[0]}")/bluegreen-deploy.sh"
