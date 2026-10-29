#!/bin/bash
# Blue/green helpers for scripts/deploy.sh, scripts/rollback-deploy.sh and
# scripts/deploy/cutover.sh (2026-10-29). Source it; it defines functions only.
#
# Two colours, named by port: isaflow@3111 and isaflow@3112, each running its
# own release folder. nginx fronts the live one (:80 and :3101) through the
# upstream in BG_UPSTREAM_FILE, which only bg_switch writes. A deploy builds
# into the idle colour, verifies it on its own port, then switches; the old
# colour keeps running untouched, so in-flight requests finish and a rollback
# is a switch back.
#
# Every path and command can be overridden so tests can run it against a
# scratch folder with stub commands. Defaults are production.

BG_PORTS="${BG_PORTS:-3111 3112}"
BG_RELEASE_ROOT="${BG_RELEASE_ROOT:-/home/velo}"            # releases: $BG_RELEASE_ROOT/isaflow-<port>
BG_STATIC_ROOT="${BG_STATIC_ROOT:-/home/velo/isaflow-static}" # served as /_next/static/
BG_UPSTREAM_FILE="${BG_UPSTREAM_FILE:-/etc/nginx/conf.d/isaflow-live.conf}"
BG_ENV_HOME="${BG_ENV_HOME:-/home/velo/isaflow}"            # .env.local + RELEASE_SHA of the live colour
BG_KEEP_BUILDS="${BG_KEEP_BUILDS:-5}"
BG_HEALTH_TRIES="${BG_HEALTH_TRIES:-60}"
BG_SUDO="${BG_SUDO-sudo}"
BG_SYSTEMCTL="${BG_SYSTEMCTL:-systemctl}"
BG_NGINX="${BG_NGINX:-nginx}"
BG_OWNER="${BG_OWNER:-velo:velo}"

bg_release_dir() { echo "$BG_RELEASE_ROOT/isaflow-$1"; }

# The live port, read from the upstream file. Empty when there is none (before
# the cutover) or it names anything but one of BG_PORTS.
bg_live_port() {
  local port
  port=$($BG_SUDO cat "$BG_UPSTREAM_FILE" 2>/dev/null \
    | sed -nE 's/^[[:space:]]*server[[:space:]]+127\.0\.0\.1:([0-9]+);.*/\1/p' | head -1)
  for p in $BG_PORTS; do
    [ "$p" = "$port" ] && { echo "$p"; return 0; }
  done
  echo ""
}

bg_other_port() {
  for p in $BG_PORTS; do
    [ "$p" != "$1" ] && { echo "$p"; return 0; }
  done
}

# Copy a built tree into the idle colour's release folder. Never touches the
# live colour's folder.
bg_sync_release() {
  local repo="$1" port="$2" sha="$3" dir
  dir=$(bg_release_dir "$port")
  [ "$port" = "$(bg_live_port)" ] && { echo "ERROR: refusing to write the LIVE colour's folder $dir" >&2; return 1; }
  $BG_SUDO mkdir -p "$dir"
  $BG_SUDO rsync -a --delete "$repo/.next/standalone/" "$dir/"
  $BG_SUDO mkdir -p "$dir/.next" "$dir/public"
  $BG_SUDO rsync -a --delete "$repo/.next/static/" "$dir/.next/static/"
  $BG_SUDO rsync -a --delete "$repo/public/" "$dir/public/"
  # Sharp belt-and-braces: the standalone trace has historically missed its
  # native binaries (next.config.js outputFileTracingIncludes).
  [ -d "$repo/node_modules/sharp" ] && $BG_SUDO rsync -a "$repo/node_modules/sharp/" "$dir/node_modules/sharp/"
  [ -d "$repo/node_modules/@img" ] && $BG_SUDO rsync -a "$repo/node_modules/@img/" "$dir/node_modules/@img/"
  # Inject BUILD_ID into sw.js so stale caches are evicted on every deploy.
  $BG_SUDO sed -i "s/__BUILD_ID__/$(cat "$repo/.next/BUILD_ID")/g" "$dir/public/sw.js"
  echo "$sha" | $BG_SUDO tee "$dir/RELEASE_SHA" >/dev/null
  $BG_SUDO chown -R "$BG_OWNER" "$dir"
}

# Add this build's hashed static files to the shared folder (never --delete),
# record which files the build has, and remove only files that none of the
# last BG_KEEP_BUILDS builds has. Content-hashed names never collide.
bg_sync_static() {
  local repo="$1" build_id lists keep
  build_id=$(cat "$repo/.next/BUILD_ID")
  $BG_SUDO mkdir -p "$BG_STATIC_ROOT/_next/static" "$BG_STATIC_ROOT/.builds"
  $BG_SUDO rsync -a "$repo/.next/static/" "$BG_STATIC_ROOT/_next/static/"
  (cd "$repo/.next/static" && find . -type f | LC_ALL=C sort) | $BG_SUDO tee "$BG_STATIC_ROOT/.builds/$build_id.list" >/dev/null
  $BG_SUDO touch "$BG_STATIC_ROOT/.builds/$build_id.list"
  lists=$($BG_SUDO ls -t "$BG_STATIC_ROOT/.builds/" | grep '\.list$' | head -n "$BG_KEEP_BUILDS")
  keep=$(for l in $lists; do $BG_SUDO cat "$BG_STATIC_ROOT/.builds/$l"; done | LC_ALL=C sort -u)
  # Fail closed: an empty keep-set would delete everything.
  [ -z "$keep" ] && { echo "ERROR: static keep-set is empty; nothing pruned" >&2; return 1; }
  (cd "$BG_STATIC_ROOT/_next/static" && $BG_SUDO find . -type f | LC_ALL=C sort) \
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

# (Re)start a colour that is NOT live and wait for it to answer.
bg_start() {
  local port="$1"
  [ "$port" = "$(bg_live_port)" ] && { echo "ERROR: refusing to restart the LIVE colour $port" >&2; return 1; }
  $BG_SUDO "$BG_SYSTEMCTL" restart "isaflow@$port"
  bg_wait_healthy "$port"
}

# Point nginx at a port. The new file is validated before nginx reloads; if
# validation fails the previous file is put back and nothing changes. A
# reload is graceful: old workers finish their in-flight requests.
bg_switch() {
  local port="$1" tmp backup
  tmp="$BG_UPSTREAM_FILE.new"
  backup="$BG_UPSTREAM_FILE.prev"
  printf 'upstream isaflow_live {\n    server 127.0.0.1:%s;\n}\n' "$port" | $BG_SUDO tee "$tmp" >/dev/null
  $BG_SUDO test -f "$BG_UPSTREAM_FILE" && $BG_SUDO cp -p "$BG_UPSTREAM_FILE" "$backup"
  $BG_SUDO mv "$tmp" "$BG_UPSTREAM_FILE"
  if ! $BG_SUDO "$BG_NGINX" -t >/dev/null 2>&1; then
    echo "ERROR: nginx -t failed with isaflow_live -> $port; previous upstream restored" >&2
    if $BG_SUDO test -f "$backup"; then $BG_SUDO mv "$backup" "$BG_UPSTREAM_FILE"; else $BG_SUDO rm -f "$BG_UPSTREAM_FILE"; fi
    return 1
  fi
  if ! $BG_SUDO "$BG_NGINX" -s reload; then
    echo "ERROR: nginx reload failed; previous upstream restored" >&2
    if $BG_SUDO test -f "$backup"; then $BG_SUDO mv "$backup" "$BG_UPSTREAM_FILE"; else $BG_SUDO rm -f "$BG_UPSTREAM_FILE"; fi
    return 1
  fi
  [ "$(bg_live_port)" = "$port" ] || { echo "ERROR: upstream does not name $port after the switch" >&2; return 1; }
}

# Record the live colour's SHA where operators and checks read it.
bg_record_live() {
  local sha
  sha=$($BG_SUDO cat "$(bg_release_dir "$1")/RELEASE_SHA" 2>/dev/null || echo unknown)
  echo "$sha" | $BG_SUDO tee "$BG_ENV_HOME/RELEASE_SHA" >/dev/null
  echo "$sha"
}

# 0 when it is a weekday 08:00-16:59 in Johannesburg.
bg_business_hours() {
  local dow hour
  dow=$(TZ=Africa/Johannesburg date +%u)
  hour=$((10#$(TZ=Africa/Johannesburg date +%H)))
  [ "$dow" -le 5 ] && [ "$hour" -ge 8 ] && [ "$hour" -lt 17 ]
}
