#!/bin/bash
# Blue/green deploy flow and checks (2026-10-29). Sourced by bluegreen.sh,
# whose variables and helpers it uses; see that file's header.

# Switch to a colour and prove nginx serves it; if that proof fails, switch
# back to where it was. Returns 1 after a switch-back, 2 if the switch-back
# also failed (the operator must act).
bg_switch_proven() {
  local port="$1" from="$2"
  bg_switch "$port" || return 1
  if bg_served_by "$port" && curl -sf --max-time 10 --retry 5 --retry-delay 2 --retry-all-errors -H "Host: $BG_PUBLIC_HOST" "$BG_PUBLIC_HEALTH" >/dev/null; then
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
  bg_stop_idle "$idle" || return 1
  bg_sync_release "$repo" "$idle" "$sha" || { bg_retire_failed "$idle" "$sha: copy failed"; return 1; }
  # The unit template: the previous one is kept and put back if this build
  # fails (the live colour restarts from it after a crash).
  # Replaced only when it changed: both colours run this one template, so a new
  # one also applies to the live colour if it crashes before the switch.
  local why="" unit_changed=""
  $BG_SUDO cmp -s "$repo/scripts/isaflow@.service" "$BG_UNIT_FILE" || unit_changed=1
  if [ -n "$unit_changed" ] && $BG_SUDO test -f "$BG_UNIT_FILE"; then
    if $BG_SUDO test -f "$BG_UNIT_FILE.prev"; then
      echo "ERROR: $BG_UNIT_FILE.prev exists (an earlier deploy did not finish); resolve it by hand first" >&2
      bg_retire_failed "$idle" "$sha: stale unit backup"; return 1
    fi
    $BG_SUDO cp -p "$BG_UNIT_FILE" "$BG_UNIT_FILE.prev" || { bg_retire_failed "$idle" "$sha: unit backup failed"; return 1; }
  fi
  if [ -n "$unit_changed" ] && { ! $BG_SUDO cp "$repo/scripts/isaflow@.service" "$BG_UNIT_FILE" || ! $BG_SUDO "$BG_SYSTEMCTL" daemon-reload; }; then
    why="unit install failed"
  elif ! $BG_SUDO "$BG_SYSTEMCTL" enable "isaflow@$idle"; then why="unit install failed"
  elif ! bg_start "$idle"; then why="did not start"
  elif ! "$BG_VERIFY" "http://localhost:$idle" 8>&- 9>&-; then why="VERIFICATION FAILED"
  fi
  if [ -n "$why" ]; then
    echo "!!! $why — users stay on isaflow@$live; retiring isaflow@$idle !!!" >&2
    bg_retire_failed "$idle" "$sha: $why" || true
    if $BG_SUDO test -f "$BG_UNIT_FILE.prev"; then
      $BG_SUDO mv "$BG_UNIT_FILE.prev" "$BG_UNIT_FILE" && $BG_SUDO "$BG_SYSTEMCTL" daemon-reload \
        || echo "WARNING: could not put the previous unit template back ($BG_UNIT_FILE.prev)" >&2
    fi
    return 1
  fi
  bg_clear_marker "$idle" || return 1
  $BG_SUDO rm -f "$BG_UNIT_FILE.prev" || true

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
