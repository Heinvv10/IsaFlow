# shellcheck shell=bash
# Process bookkeeping for the integration gate (run.sh, shard.sh): which
# processes and directories belong to a run, and how to end them without ever
# signalling someone else's. Sourced, not run. Unit-tested by
# tests/unit/ci/integrationLifecycle.test.ts.
#
# A pid alone does not name a process here: pids wrap within the hour on this
# machine, and every shell a tool starts is a session leader. So every pid the
# gate records is stored with its start time (field 22 of /proc/<pid>/stat), and
# is signalled only while a process with that pid AND that start time exists.
# A run directory also records the pid namespace and boot it was made in; a
# run from another pid namespace is never judged from here, and one from an
# earlier boot is deleted without signalling anything (nothing from an earlier
# boot can be running).

# proc_start <pid>: the process's start time in clock ticks since boot, or
# nothing when no such process is running (gone, or a zombie: it has ended and
# only its parent's wait remains).
proc_start() {
  local stat
  stat=$(cat "/proc/$1/stat" 2> /dev/null) || return 0
  stat=${stat##*) } # the command name may hold spaces; fields resume after ") "
  # shellcheck disable=SC2086
  set -- $stat
  [ "$1" = Z ] && return 0
  echo "${20}"
}

# proc_sid <pid>: the session the process is in (field 6 of /proc/<pid>/stat).
proc_sid() {
  local stat
  stat=$(cat "/proc/$1/stat" 2> /dev/null) || return 0
  stat=${stat##*) }
  # shellcheck disable=SC2086
  set -- $stat
  echo "$4"
}

# same_proc <pid> <start>: the recorded process is still running.
same_proc() { [ -n "$2" ] && [ "$(proc_start "$1")" = "$2" ]; }

my_pidns() { readlink /proc/self/ns/pid; }
boot_id() { cat /proc/sys/kernel/random/boot_id; }

# write_owner <run dir>: record this run (run.sh's pid) for later sweeps.
write_owner() { echo "$$ $(proc_start $$) $(my_pidns) $(boot_id)" > "$1/owner"; }

# owner_dead <pid> <start>: true only when the recorded process is certainly
# gone: no such process, a zombie, or its pid now belongs to a newer process
# (/proc/<pid>/stat, readable for any user's process, gives its start time).
owner_dead() {
  [ -r "/proc/$1/stat" ] || return 0
  [ "$(proc_start "$1")" != "$2" ]
}

# session_pids <sid>: every live process in the session (a zombie has already
# ended; only its parent's wait remains).
session_pids() { ps -eo pid=,sid=,stat= | awk -v s="$1" '$2 == s && $3 !~ /^Z/ { print $1 }'; }

# session_ours <sid> <leader start>: the session is still the one recorded:
# its leader is alive with the recorded start time. A session whose leader has
# gone is never signalled: its id may by now belong to someone else's session
# whose own leader has exited (a daemon's). A shard ends its own session's
# leftovers before it exits (end_own_session); what a SIGKILLed shard leaves
# behind is not ended by anyone here.
session_ours() { same_proc "$1" "$2"; }

# snapshot <sid> [exclude pid]: "pid start" for every live member of the session
# now. Once taken, members are signalled by this list, each only while it still
# has that start time: never by session id again, since a session can end and
# its id pass to another process while we are still waiting on it.
snapshot() {
  local pid start
  for pid in $(session_pids "$1"); do
    # Not the excluded pid, nor this very subshell (it is in the session too).
    [ "$pid" = "${2:-}" ] || [ "$pid" = "$BASHPID" ] && continue
    start=$(proc_start "$pid")
    [ -n "$start" ] && echo "$pid $start"
  done
  return 0
}

# signal_list <signal> <lines>: send it to each listed process that still matches.
signal_list() {
  local pid start
  [ -n "$2" ] || return 0
  # A process may end between the check and the kill: never let that stop a cleanup.
  while read -r pid start; do
    if same_proc "$pid" "$start"; then kill -"$1" "$pid" 2> /dev/null || true; fi
  done <<< "$2"
  return 0
}

# wait_list <half-seconds> <lines>: wait until none of them matches any more.
wait_list() {
  local n pid start live
  for n in $(seq 1 "$1"); do
    live=0
    if [ -n "$2" ]; then
      while read -r pid start; do same_proc "$pid" "$start" && live=1; done <<< "$2"
    fi
    [ "$live" -eq 0 ] && return 0
    sleep 0.5
  done
}

# end_snapshot <lines>: TERM each listed process that still matches, wait up to
# 10 s for them to go, then KILL any that still match.
end_snapshot() {
  signal_list TERM "$1"
  wait_list 20 "$1"
  signal_list KILL "$1"
}

# end_own_session: for a session leader on its way out (shard.sh's EXIT trap).
# While the leader lives its session id cannot pass to anyone else, so it may
# re-read its members: TERM them, round after round (a member may fork after a
# snapshot), for up to 10 s, then KILL what is left, and return.
# 10 s by the clock, not by a count of rounds: a snapshot reads every process on
# the machine (ps), which took ~0.6 s a round at 24k processes, and remove_run
# gives a leader 30 s for all of this. The clock is the monotonic uptime, in
# hundredths of a second (a wall-clock step cannot stretch or cut the phase).
uptime_cs() {
  local up rest
  read -r up rest < /proc/uptime
  echo $(( ${up%.*} * 100 + 10#${up#*.} ))
}
end_own_session() {
  local n list pid start until=$(( $(uptime_cs) + 1000 ))
  while [ "$(uptime_cs)" -lt "$until" ]; do
    list=$(snapshot $$ $$)
    [ -n "$list" ] || return 0
    while read -r pid start; do same_proc "$pid" "$start" && kill -TERM "$pid" 2> /dev/null; done <<< "$list"
    sleep 0.5
  done
  for n in 1 2 3 4 5; do
    list=$(snapshot $$ $$)
    [ -n "$list" ] || return 0
    while read -r pid start; do same_proc "$pid" "$start" && kill -KILL "$pid" 2> /dev/null; done <<< "$list"
    sleep 0.2
  done
  return 0
}

# remove_run <run dir>: end every session it recorded (shards, the schema-build
# step) that is still its own, stop its clusters, delete it. In this order:
# snapshot each session's members; TERM the members and the leaders, so no
# shard starts its next vitest; stop the clusters; give the members 10 s, then
# KILL them; give the leaders 30 s, longer than their own end_own_session takes,
# then KILL them last.
remove_run() {
  local run=$1 f sid start more members="" leaders=""
  for f in "$run"/c*/sid; do
    [ -f "$f" ] || continue
    read -r sid start < "$f" || continue
    session_ours "$sid" "$start" || continue
    leaders+="$sid $start"$'\n'
    members+="$(snapshot "$sid" "$sid")"$'\n'
  done
  members=$(printf '%s' "$members" | sed '/^$/d' | sort -u)
  leaders=$(printf '%s' "$leaders" | sed '/^$/d')
  signal_list TERM "$members"
  signal_list TERM "$leaders"
  # A leader may have forked (a shard its next vitest) after the snapshot: while
  # it lives its session is still its own, so look again.
  while read -r sid start; do
    [ -n "$sid" ] && same_proc "$sid" "$start" || continue
    more=$(snapshot "$sid" "$sid")
    signal_list TERM "$more"
    members+=$'\n'"$more"
  done <<< "$leaders"
  members=$(printf '%s' "$members" | sed '/^$/d' | sort -u)
  for f in "$run"/c*; do [ -d "$f" ] && pg_cluster_stop "$f"; done
  wait_list 20 "$members"
  signal_list KILL "$members"
  wait_list 60 "$leaders"
  signal_list KILL "$leaders"
  rm -rf "$run"
}

# end_run <run dir>: run.sh's cleanup. A second INT/TERM/HUP must not cut it
# short of rm -rf, so they are ignored from here on.
end_run() {
  trap '' INT TERM HUP
  remove_run "$1"
}

# hold_signals / release_signals: around starting a background child and
# recording it, an INT/TERM/HUP is noted instead of acted on, so cleanup always
# finds the record. (Ignoring them would pass SIG_IGN on to the child; a
# handler is reset to the default in it.) release_signals acts on a held one.
pending=""
hold_signals() {
  trap 'pending=129' HUP
  trap 'pending=130' INT
  trap 'pending=143' TERM
}
release_signals() {
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  [ -z "$pending" ] || exit "$pending"
}

# launch_session <record> <command...>: start the command as the leader of a new
# session and record "pid start" in <record>, signals held meanwhile. A
# background child is no process-group leader, so setsid(1) does not fork and
# the child's pid becomes the session id; it is recorded once the child has
# called setsid() (2 s at most). Sets LAUNCHED to the pid.
launch_session() {
  local record=$1 n
  shift
  hold_signals
  setsid --wait "$@" &
  LAUNCHED=$!
  for n in $(seq 1 40); do [ "$(proc_sid "$LAUNCHED")" = "$LAUNCHED" ] && break; sleep 0.05; done
  echo "$LAUNCHED $(proc_start "$LAUNCHED")" > "$record"
  release_signals
}

# boot_time: when this boot began, in seconds since the epoch (/proc/stat btime).
boot_time() { awk '$1 == "btime" { print $2 }' /proc/stat; }

# sweep_dead_runs: remove this user's run directories whose run.sh is
# certainly dead (SIGKILL leaves them behind). Without signalling anything, it
# also deletes one made before this boot began. Anything it cannot judge is
# left alone and said so: another boot id but newer than this boot (another
# kernel sharing the directory), and any other pid namespace. Named limit: a
# run SIGKILLed inside another pid namespace stays until removed by hand; whether
# that namespace still lives cannot be told from here (other users' /proc ns
# links are unreadable, so a live one looks gone).
# Symlinks, other users' directories and incomplete owner records are skipped.
sweep_dead_runs() {
  local old pid start ns boot made
  for old in "${TMPDIR:-/tmp}"/isaflow-ci-int.??????; do
    [ -d "$old" ] && [ ! -L "$old" ] && [ -O "$old" ] && [ -f "$old/owner" ] || continue
    read -r pid start ns boot < "$old/owner" || continue
    [ -n "$boot" ] || continue
    made=$(stat -c %Z "$old" 2> /dev/null) || continue # a concurrent sweep removed it
    if [ "$boot" != "$(boot_id)" ]; then
      if [ "$made" -lt "$(boot_time)" ]; then
        rm -rf "$old"
        echo "[integration] removed the leftovers of a run from an earlier boot: $old"
      else
        echo "[integration] left alone: $old (another kernel's boot id, made since this boot)"
      fi
      continue
    fi
    if [ "$ns" != "$(my_pidns)" ]; then
      echo "[integration] left alone: $old (other pid namespace)"
      continue
    fi
    owner_dead "$pid" "$start" || continue
    remove_run "$old"
    echo "[integration] removed the leftovers of a run that died: $old"
  done
}

# shard_outcome <status> <elapsed s> <limit s>: how a shard's vitest ended.
# `timeout` exits 124 when it stopped the command, and 137 when it had to KILL
# it after the grace; a 137 before the limit is a SIGKILL from elsewhere (the
# kernel's OOM killer, say).
shard_outcome() {
  if [ "$1" -eq 124 ] || { [ "$1" -eq 137 ] && [ "$2" -ge "$3" ]; }; then
    echo timeout
  elif [ "$1" -eq 137 ]; then
    echo killed
  elif [ "$1" -eq 0 ]; then
    echo ok
  else
    echo failed
  fi
}
