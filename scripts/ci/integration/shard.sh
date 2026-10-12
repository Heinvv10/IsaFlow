#!/usr/bin/env bash
# One shard of the integration gate. run.sh starts it with setsid, so the shard
# and every process it starts share one session (`timeout` moves vitest into a
# process group of its own, but not out of the session), which run.sh's cleanup
# ends as a whole.
#
#   shard.sh <i> <shards> <port> <work dir> <parity url> <parity url 2>
#
# Runs shard <i>'s suites from <work dir>/plan.tsv against the cluster on
# <port>: the isaflow_schema_fixture ones, then the isaflow_test ones, one file
# at a time. Logs to <work dir>/c<i>/<db>.log and appends a line per database
# to <work dir>/c<i>/summary. Exits non-zero if either database's run failed,
# ran a different number of files than it was given, or ran out of time.
#
# Time limit: the whole shard gets CI_INT_SHARD_TIMEOUT seconds (default 2100,
# 35 min; the slowest shard measured 23 min at load ~250). A suite that hangs
# is then killed, and the summary names the file that was running.
set -uo pipefail

i=$1 shards=$2 port=$3 work=$4 parity=$5 parity2=$6
dir="$work/c$i"
# shellcheck source=pg-cluster.sh
source scripts/ci/integration/pg-cluster.sh

ps -o sid= -p $$ | tr -d ' ' > "$dir/sid"
limit=${CI_INT_SHARD_TIMEOUT:-2100}
deadline=$(( $(date +%s) + limit ))
rc=0

for db in isaflow_schema_fixture isaflow_test; do
  mapfile -t files < <(awk -F'\t' -v s="$i" -v d="$db" '$1 == s && $2 == d { print $3 }' "$work/plan.tsv")
  [ "${#files[@]}" -eq 0 ] && continue
  log="$dir/$db.log"
  started="$dir/$db.started"
  db_rc=0
  t0=$(date +%s)
  left=$(( deadline - t0 ))
  if [ "$left" -le 0 ]; then
    echo "[integration] shard $i/$shards $db: TIMED OUT before it started (limit ${limit}s)" | tee -a "$log" >> "$dir/summary"
    rc=1
    continue
  fi
  with_db "$port" "$db" env PARITY_TEST_PG_DISPOSABLE=1 "PARITY_TEST_PG_URL=$parity" "PARITY_TEST_PG_URL_2=$parity2" \
    "INTEGRATION_STARTED_LOG=$started" \
    timeout -k 30 "$left" node_modules/.bin/vitest run --config vitest.integration.config.ts \
    --no-file-parallelism --silent=passed-only \
    --reporter=default --reporter=./scripts/ci/integration/startedFileReporter.ts \
    "${files[@]}" > "$log" 2>&1
  status=$?
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    last=$(tail -n 1 "$started" 2>/dev/null)
    echo "[integration] shard $i/$shards $db: TIMED OUT after $(( $(date +%s) - t0 ))s (shard limit ${limit}s); last file started: ${last:-none}" \
      | tee -a "$log" >> "$dir/summary"
    rc=1
    continue
  fi
  [ "$status" -ne 0 ] && db_rc=1
  # vitest drops a path it cannot find without failing: count what it ran.
  ran=$(grep -E '^ +Test Files ' "$log" | grep -oE '\(([0-9]+)\)' | tr -d '()' || true)
  if [ "$ran" != "${#files[@]}" ]; then
    echo "[integration] shard $i/$shards $db: vitest ran ${ran:-no} files of ${#files[@]}" >> "$log"
    db_rc=1
  fi
  echo "[integration] shard $i/$shards $db: ${#files[@]} files, $(( $(date +%s) - t0 ))s, exit $db_rc" >> "$dir/summary"
  [ "$db_rc" -ne 0 ] && rc=1
done
exit "$rc"
