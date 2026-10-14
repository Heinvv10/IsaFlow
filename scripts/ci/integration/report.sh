# shellcheck shell=bash
# Bounded GitHub-log reporting for integration failures. Sourced by run.sh and
# kept separate so the output contract can be unit-tested without starting PG.

# report_integration_failure_logs <work dir> <shard count> <failed shard ids>
# Successful shard logs are deliberately quiet: they can exceed 20 MB, and a
# burst that large made the GitHub runner's stdout return EAGAIN. The useful
# success evidence is the compact per-database summary printed by run.sh.
report_integration_failure_logs() {
  local work=$1 shards=$2 failed_shards=$3 i db log
  local lines=${CI_INT_FAILURE_LOG_LINES:-300}
  local columns=${CI_INT_FAILURE_LOG_COLUMNS:-2000}
  for i in $failed_shards; do
    for db in isaflow_schema_fixture isaflow_test; do
      log="$work/c$i/$db.log"
      [ -f "$log" ] || continue
      echo ""
      echo "----- [integration] shard $i/$shards, $db (failed; last $lines lines, $columns columns max) -----"
      tail -n "$lines" "$log" | cut -c1-"$columns"
    done
  done
}
