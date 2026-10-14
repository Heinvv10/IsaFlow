# shellcheck shell=bash
# The integration gate's report (sourced by run.sh; kept apart so its output
# contract is unit-tested without starting PostgreSQL:
# tests/unit/ci/integrationReport.test.ts).
#
# stdout is all there is on GitHub: the job uploads nothing. So the report is
# compact for a passing database and specific for a failing one:
#   - every database: vitest's totals, its failing files (result-lines.ts, the
#     reader shard.sh uses), vitest's failure section (capped) and the gate's
#     own [integration] notes (report_shard_results);
#   - a failed shard: named, always; then the bounded tail of each of its
#     databases' logs that did not pass (a hang, or an error before vitest's
#     summary, is in no excerpt), and a database with no log or no summary
#     line named as such (report_integration_failure_logs).
# Successful shard logs are deliberately quiet: they can exceed 20 MB, and a
# burst that large made the GitHub runner's stdout return EAGAIN.
#
# The report is written to a file and printed in one go (print_report), after
# stdout is made blocking again; a failed print never changes the verdict.

# report_shard_results <work dir> <shard count>
report_shard_results() {
  local work=$1 shards=$2 i db log
  for i in $(seq 1 "$shards"); do
    for db in isaflow_schema_fixture isaflow_test; do
      log="$work/c$i/$db.log"
      [ -f "$log" ] || continue
      echo ""
      echo "----- [integration] shard $i/$shards, $db -----"
      grep -E '^ +(Test Files|Tests) ' "$log"
      bun scripts/ci/integration/result-lines.ts failed "$log"
      awk '/⎯ Failed (Tests|Suites) /{on=1} on && n < 300 {print; n++} /^ +Test Files /{on=0}' "$log"
      grep -E '^\[integration\]' "$log"
    done
  done
  return 0
}

# wait_shards <pid>...: waits for each shard (pid k is shard k) and sets
# FAILED=1 and FAILED_SHARDS (" 2 5") from their exit statuses: the input of
# report_integration_failure_logs. Run in the current shell (a subshell cannot
# wait for run.sh's children).
wait_shards() {
  local k=0 pid
  FAILED_SHARDS=""
  for pid in "$@"; do
    k=$((k + 1))
    if ! wait "$pid"; then
      FAILED=1
      FAILED_SHARDS+=" $k"
    fi
  done
  return 0
}

# cut_columns <n>: each line cut to n CHARACTERS (cut -c counts bytes and
# would split a ✓); bytes that are not UTF-8 become U+FFFD.
cut_columns() {
  perl -MEncode -ne 'BEGIN { binmode STDOUT, ":encoding(UTF-8)" } chomp;
    print substr(decode("UTF-8", $_), 0, '"$1"'), "\n"'
}

# report_integration_failure_logs <work dir> <shard count> <failed shard ids>
# Every failed shard is named, even one that left nothing behind. For each of
# its databases: the last CI_INT_FAILURE_LOG_LINES lines (default 400) of its
# log, each cut to CI_INT_FAILURE_LOG_COLUMNS characters (default 400; a JSON
# log line can be far longer). A database stays quiet only when its shard
# summary says it passed (exit 0); one with no log, or no summary line, is
# named as such.
report_integration_failure_logs() {
  local work=$1 shards=$2 failed_shards=$3 i db log status planned
  local lines=${CI_INT_FAILURE_LOG_LINES:-400}
  local columns=${CI_INT_FAILURE_LOG_COLUMNS:-400}
  for i in $failed_shards; do
    echo ""
    echo "[integration] shard $i/$shards FAILED"
    for db in isaflow_schema_fixture isaflow_test; do
      log="$work/c$i/$db.log"
      status=$(grep -E "^\[integration\] shard $i/$shards $db: " "$work/c$i/summary" 2> /dev/null | tail -n 1)
      if [ ! -f "$log" ]; then
        planned=unknown
        [ -f "$work/plan.tsv" ] && planned=$(awk -F'\t' -v s="$i" -v d="$db" '$1 == s && $2 == d { n++ } END { print n + 0 }' "$work/plan.tsv")
        case $planned in
          unknown) echo "[integration] shard $i/$shards $db: NO LOG" ;;
          0) echo "[integration] shard $i/$shards $db: NO LOG (no files planned)" ;;
          1) echo "[integration] shard $i/$shards $db: NO LOG (1 file planned)" ;;
          *) echo "[integration] shard $i/$shards $db: NO LOG ($planned files planned)" ;;
        esac
        continue
      fi
      case $status in
        *", exit 0") echo "[integration] shard $i/$shards $db: passed (exit 0), log not printed"; continue ;;
        "") echo "[integration] shard $i/$shards $db: NO SUMMARY LINE" ;;
      esac
      echo "----- [integration] shard $i/$shards, $db (failed; last $lines lines, $columns columns max) -----"
      tail -n "$lines" "$log" | cut_columns "$columns"
    done
  done
  return 0
}

# unblock_stdio: bun leaves stdout/stderr O_NONBLOCK (one open file
# description, shared with this shell). On a pipe read slowly (the GitHub
# runner's) a write from this shell can then fail with EAGAIN; under set -e a
# failed echo would end the step.
unblock_stdio() {
  perl -MFcntl -e 'for my $fd (1, 2) { open(my $h, ">&=", $fd) or next;
    my $f = fcntl($h, F_GETFL, 0) or next; fcntl($h, F_SETFL, $f & ~O_NONBLOCK) }' 2> /dev/null || true
}

# print_report <report file> <where a local run keeps the full logs>
print_report() {
  unblock_stdio
  if ! cat "$1"; then
    echo "[integration] could not print the whole report (stdout write failed); the verdict stands; a local run keeps the full logs in $2" >&2 || true
  fi
  return 0
}
