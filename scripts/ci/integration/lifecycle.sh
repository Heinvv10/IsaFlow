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
# nothing when no such process is visible.
proc_start() {
  local stat
  stat=$(cat "/proc/$1/stat" 2> /dev/null) || return 0
  stat=${stat##*) } # the command name may hold spaces; fields resume after ") "
  # shellcheck disable=SC2086
  set -- $stat
  echo "${20}"
}

# same_proc <pid> <start>: the recorded process is still running.
same_proc() { [ -n "$2" ] && [ "$(proc_start "$1")" = "$2" ]; }

my_pidns() { readlink /proc/self/ns/pid; }
boot_id() { cat /proc/sys/kernel/random/boot_id; }

# write_owner <run dir>: record this run (run.sh's pid) for later sweeps.
write_owner() { echo "$$ $(proc_start $$) $(my_pidns) $(boot_id)" > "$1/owner"; }

# owner_dead <pid> <start>: true only when the recorded process is certainly
# gone: no such process (ESRCH), or its pid now belongs to a newer process.
# A process we may not signal (EPERM) counts as alive.
owner_dead() {
  local err
  if err=$(export LC_ALL=C; kill -0 "$1" 2>&1); then
    [ "$(proc_start "$1")" != "$2" ]
    return
  fi
  case "$err" in *"No such process"*) return 0 ;; *) return 1 ;; esac
}

# session_pids <sid>: every live process in the session (a zombie has already
# ended; only its parent's wait remains).
session_pids() { ps -eo pid=,sid=,stat= | awk -v s="$1" '$2 == s && $3 !~ /^Z/ { print $1 }'; }

# session_ours <sid> <leader start>: the session is still the one recorded:
# its leader is alive with the recorded start time. A session whose leader has
# gone is never signalled: its id may by now belong to someone else's session
# whose own leader has exited (a daemon's). What a lost shard leader leaves
# behind is bounded by its `timeout -k 30` instead.
session_ours() { same_proc "$1" "$2"; }

# remove_run <run dir>: end every shard session it recorded that is still its
# own (TERM, then KILL after up to 10 s), stop its clusters, delete it.
remove_run() {
  local run=$1 f n live sid start
  local -a mine=()
  for f in "$run"/c*/sid; do
    [ -f "$f" ] || continue
    read -r sid start < "$f" || continue
    session_ours "$sid" "$start" && mine+=("$sid")
  done
  for sid in "${mine[@]}"; do session_pids "$sid" | xargs -r kill -TERM 2> /dev/null || true; done
  for n in $(seq 1 20); do
    live=0
    for sid in "${mine[@]}"; do [ -n "$(session_pids "$sid")" ] && live=1; done
    [ "$live" -eq 0 ] && break
    sleep 0.5
  done
  for sid in "${mine[@]}"; do session_pids "$sid" | xargs -r kill -KILL 2> /dev/null || true; done
  for f in "$run"/c*; do [ -d "$f" ] && pg_cluster_stop "$f"; done
  rm -rf "$run"
}

# sweep_dead_runs: remove this user's run directories whose run.sh is
# certainly dead (SIGKILL leaves them behind). One from an earlier boot is only
# deleted. Symlinks, other users' directories, directories from another pid
# namespace and ones without a complete owner record are left alone.
sweep_dead_runs() {
  local old pid start ns boot
  for old in "${TMPDIR:-/tmp}"/isaflow-ci-int.??????; do
    [ -d "$old" ] && [ ! -L "$old" ] && [ -O "$old" ] && [ -f "$old/owner" ] || continue
    read -r pid start ns boot < "$old/owner" || continue
    [ -n "$boot" ] || continue
    if [ "$boot" != "$(boot_id)" ]; then
      rm -rf "$old"
      echo "[integration] removed the leftovers of a run from an earlier boot: $old"
      continue
    fi
    [ "$ns" = "$(my_pidns)" ] || continue
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
