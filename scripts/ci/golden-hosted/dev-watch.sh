#!/usr/bin/env bash
# Evidence for a hosted Golden Paths run's dev server: when did its process
# restart, and how big was it? Hosted failures (page.goto ERR_EMPTY_RESPONSE /
# ERR_CONNECTION_REFUSED on localhost, 1 to 3 specs of ~200, minutes after the
# server last answered) leave nothing in the last 80 log lines, because the
# server is back by then. This keeps a sample line every few seconds and prints
# only what bears on a restart. Nothing printed can hold a secret: process ids,
# sizes, and the few non-request lines of the dev log that match the filter.
#
#   dev-watch.sh sample <samples-file> [seconds]   run in the background
#   dev-watch.sh report <samples-file> <dev-log>    print the summary
set -u

sample() {
  local out=$1 every=${2:-10}
  while :; do
    ps -eo pid=,ppid=,rss=,etimes=,args= | awk -v ts="$(date +%T)" -v avail="$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)" '
      /next-server|next dev|next\/dist\/bin\/next/ && !/awk/ { printf "%s availMB=%s pid=%s ppid=%s rssMB=%d up=%ss %s\n", ts, avail, $1, $2, $3/1024, $4, substr($5 " " $6, 1, 36) }' >> "$out"
    sleep "$every"
  done
}

report() {
  local samples=$1 devlog=$2
  echo "::group::dev server lifecycle (filtered)"
  echo "-- restart evidence in the dev log (non-request lines only):"
  grep -nE "approaching the used memory|restarting|Restarting|Found a change|JavaScript heap|FATAL|Killed|SIGKILL|SIGTERM|uncaughtException|Unhandled|ELIFECYCLE|exited with" "$devlog" | cut -c1-200 | head -40
  echo "-- 'Ready in' lines (1 = never restarted): $(grep -c 'Ready in' "$devlog")"
  echo "-- distinct next-server pids: $(grep 'next-server' "$samples" | sed -E 's/.* pid=([0-9]+) .*/\1/' | sort -u | tr '\n' ' ')"
  echo "-- next-server rss over time (MB), one sample in 12, and the max:"
  grep 'next-server' "$samples" | awk 'NR % 12 == 1 { printf "%s pid=%s rss=%s avail=%s | ", $1, $3, $5, $2 } END { print "" }' | sed 's/pid=//g;s/rssMB=//g;s/availMB=//g' | fold -w 200
  grep 'next-server' "$samples" | sed -E 's/.*rssMB=([0-9]+).*/\1/' | sort -n | tail -1 | sed 's/^/max rssMB: /'
  echo "-- kernel OOM kills:"
  (sudo -n dmesg 2>/dev/null || true) | grep -iE "out of memory|oom-kill|killed process" | tail -5
  echo "::endgroup::"
}

case "${1:-}" in
  sample) shift; sample "$@" ;;
  report) shift; report "$@" ;;
  *) echo "usage: dev-watch.sh sample <file> [seconds] | report <samples> <devlog>" >&2; exit 2 ;;
esac
