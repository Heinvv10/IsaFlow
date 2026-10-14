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
#   - a failed shard: the bounded tail of each of its databases' logs that did
#     not pass, because a hang, or an error before vitest's summary, is in no
#     excerpt (report_integration_failure_logs).
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

# report_integration_failure_logs <work dir> <shard count> <failed shard ids>
# The last CI_INT_FAILURE_LOG_LINES lines (default 400) of each failed shard's
# database logs, each cut to CI_INT_FAILURE_LOG_COLUMNS characters (default
# 400; a JSON log line can be far longer). A database whose shard summary says
# it passed (exit 0) stays quiet even when the other one failed.
report_integration_failure_logs() {
  local work=$1 shards=$2 failed_shards=$3 i db log
  local lines=${CI_INT_FAILURE_LOG_LINES:-400}
  local columns=${CI_INT_FAILURE_LOG_COLUMNS:-400}
  for i in $failed_shards; do
    for db in isaflow_schema_fixture isaflow_test; do
      log="$work/c$i/$db.log"
      [ -f "$log" ] || continue
      grep -qE "^\[integration\] shard $i/$shards $db: .*, exit 0\$" "$work/c$i/summary" 2> /dev/null && continue
      echo ""
      echo "----- [integration] shard $i/$shards, $db (failed; last $lines lines, $columns columns max) -----"
      tail -n "$lines" "$log" | cut -c1-"$columns"
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
