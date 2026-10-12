#!/usr/bin/env bash
# The integration gate: every tests/integration/**/*.int.test.ts, against
# disposable PostgreSQL 16 clusters this script starts and removes itself.
# run-ci.sh runs it as the `integration` step, locally and on the GitHub runner
# alike (which has no dev database and no docker: everything here runs as the
# current user).
#
# Schema source: scripts/ci/integration/baseline.sql.gz, a committed schema-only
# dump of isaflow_dev (no data, roles or passwords) with its
# schema_migrations rows, made by refresh-baseline.sh. On every run the repo's
# own runner (scripts/apply-migrations.ts) applies each migration newer than
# the baseline, so a branch's new migration is exercised here before it
# reaches any shared database. Refresh the baseline only when its age starts
# to cost time; see refresh-baseline.sh.
#
# Why not the alternatives: the migrations do not build a database from zero
# (151 of 443 fail on an empty one), and dumping isaflow_dev at run time needs
# a dev credential the GitHub runner does not have.
#
# Shape of a run:
#   1. One cluster (initdb in a mktemp dir, 127.0.0.1, a port the OS hands
#      out, scram password random per run): roles app_user / platform_admin /
#      migration_admin without passwords, baseline loaded into
#      isaflow_schema_fixture, newer migrations applied, isaflow_test cloned
#      from it. The suites guard themselves by database NAME, and the two
#      guards disagree, so both names exist; plan.ts routes each suite to the
#      one it accepts (suiteRoute.ts).
#   2. The stopped cluster is copied SHARDS times; each copy starts on its own
#      port and runs its share of each database's suites, one file at a time
#      (--no-file-parallelism: parallel files on one database deadlock).
#   3. Each shard's vitest log is printed; the step fails if any shard fails or
#      ran a different number of files than it was given.
#   4. trap EXIT stops every cluster (pg_ctl -m immediate) and deletes the
#      mktemp dir, and nothing else.
#
# The suites get a fixed environment (env -i), so a developer's .env.local or
# shell can never point them at a shared database or a real GoTrue.
# CI_INTEGRATION_GATE=1 tells the few suites with a wall-clock bound to skip
# just that bound here (tests/helpers/integrationGate.ts).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
# shellcheck source=pg-cluster.sh
source scripts/ci/integration/pg-cluster.sh

SHARDS=6
pg_require_extensions

WORK=$(mktemp -d "${TMPDIR:-/tmp}/isaflow-ci-int.XXXXXX")
cleanup() {
  local dir
  for dir in "$WORK"/c*; do [ -d "$dir" ] && pg_cluster_stop "$dir"; done
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

PGPASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
export PGPASSWORD
# The suites sign and verify their own session tokens with it; random per run.
JWT=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
START=$(date +%s)

bun scripts/ci/integration/plan.ts "$SHARDS" > "$WORK/plan.tsv"

# with_db <port> <database> <command...>: run the command in the suites' fixed
# environment. No password in the URL: pg and psql read PGPASSWORD.
with_db() {
  local url="postgresql://postgres@127.0.0.1:$1/$2"
  shift 2
  env -i "PATH=$PATH" "HOME=$HOME" "TMPDIR=${TMPDIR:-/tmp}" "PGPASSWORD=$PGPASSWORD" NO_COLOR=1 \
    "DATABASE_URL=$url" "PLATFORM_ADMIN_DATABASE_URL=$url" "MIGRATION_ADMIN_DATABASE_URL=$url" \
    DATABASE_SSL=disable GOTRUE_URL=http://127.0.0.1:1/auth/v1 ISAFLOW_DISPOSABLE_AUTH_TEST=1 CI_INTEGRATION_GATE=1 \
    "JWT_SECRET=$JWT" "$@"
}

# 1. Template cluster.
mkdir "$WORK/c1"
pg_cluster_init "$WORK/c1"
PORT=$(pg_cluster_start "$WORK/c1")
PSQL=("$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)
pg_create_roles "$PORT"
"${PSQL[@]}" -d postgres -c "CREATE DATABASE isaflow_schema_fixture"
gunzip -c scripts/ci/integration/baseline.sql.gz | "${PSQL[@]}" -d isaflow_schema_fixture > /dev/null
# The runner forces TLS unless the URL says sslmode=disable.
with_db "$PORT" isaflow_schema_fixture \
  env "DATABASE_URL=postgresql://postgres@127.0.0.1:$PORT/isaflow_schema_fixture?sslmode=disable" \
  bun scripts/apply-migrations.ts
# A schema-only dump leaves every materialized view unpopulated, and reading
# one then errors; populate them (empty) as a deploy would have.
"${PSQL[@]}" -d isaflow_schema_fixture -At \
  -c "SELECT format('REFRESH MATERIALIZED VIEW %I.%I', schemaname, matviewname) FROM pg_matviews" \
  | "${PSQL[@]}" -d isaflow_schema_fixture
"${PSQL[@]}" -d postgres -c "CREATE DATABASE isaflow_test TEMPLATE isaflow_schema_fixture"
pg_cluster_stop "$WORK/c1"
echo "[integration] schema built in $(( $(date +%s) - START ))s"

# 2. Shards: SHARDS copies of the stopped template, each on its own port.
for i in $(seq 2 "$SHARDS"); do mkdir "$WORK/c$i"; cp -a "$WORK/c1/data" "$WORK/c$i/data"; done
declare -a PORTS=()
for i in $(seq 1 "$SHARDS"); do PORTS+=("$(pg_cluster_start "$WORK/c$i")"); done

# migration-parity-gate.int.test.ts needs two more throwaway servers holding
# no database but its own (tests/helpers/parityTestGuard.ts): two empty ones.
for p in p1 p2; do mkdir "$WORK/c$p"; pg_cluster_init "$WORK/c$p"; done
parity="postgresql://postgres@127.0.0.1:$(pg_cluster_start "$WORK/cp1")/postgres"
parity2="postgresql://postgres@127.0.0.1:$(pg_cluster_start "$WORK/cp2")/postgres"

declare -a PIDS=()
for i in $(seq 1 "$SHARDS"); do
  port=${PORTS[$((i - 1))]}
  (
    rc=0
    for db in isaflow_schema_fixture isaflow_test; do
      mapfile -t files < <(awk -F'\t' -v s="$i" -v d="$db" '$1 == s && $2 == d { print $3 }' "$WORK/plan.tsv")
      [ "${#files[@]}" -eq 0 ] && continue
      log="$WORK/c$i/$db.log"
      t0=$(date +%s)
      with_db "$port" "$db" env PARITY_TEST_PG_DISPOSABLE=1 "PARITY_TEST_PG_URL=$parity" "PARITY_TEST_PG_URL_2=$parity2" \
        node_modules/.bin/vitest run --config vitest.integration.config.ts \
        --no-file-parallelism --silent=passed-only "${files[@]}" > "$log" 2>&1 || rc=1
      # vitest drops a path it cannot find without failing: count what it ran.
      ran=$(grep -E '^ +Test Files ' "$log" | grep -oE '\(([0-9]+)\)' | tr -d '()' || true)
      if [ "$ran" != "${#files[@]}" ]; then
        echo "[integration] shard $i $db: vitest ran ${ran:-no} files of ${#files[@]}" >> "$log"
        rc=1
      fi
      echo "[integration] shard $i/$SHARDS $db: ${#files[@]} files, $(( $(date +%s) - t0 ))s, exit $rc" >> "$WORK/c$i/summary"
    done
    exit "$rc"
  ) &
  PIDS+=("$!")
done

FAILED=0
for pid in "${PIDS[@]}"; do wait "$pid" || FAILED=1; done

# 3. Report: every shard's log, then which suites skipped and why.
for i in $(seq 1 "$SHARDS"); do
  for db in isaflow_schema_fixture isaflow_test; do
    [ -f "$WORK/c$i/$db.log" ] || continue
    echo ""
    echo "----- [integration] shard $i/$SHARDS, $db -----"
    cat "$WORK/c$i/$db.log"
  done
done
echo ""
bun scripts/ci/report-skipped-integration.ts "$WORK"/c*/*.log || FAILED=1
echo ""
cat "$WORK"/c*/summary
echo "[integration] $(wc -l < "$WORK/plan.tsv") suites on $SHARDS shards in $(( $(date +%s) - START ))s"
exit "$FAILED"
