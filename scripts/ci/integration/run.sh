#!/usr/bin/env bash
# The integration gate: every tests/integration/**/*.int.test.ts, against
# disposable PostgreSQL 16 clusters this script starts and removes itself.
# run-ci.sh runs it as the `integration` step on GitHub, and locally when asked
# for with CI_INTEGRATION=1. Everything here runs as the current user: no
# docker, no dev database, no secret.
#
# Schema source: scripts/ci/integration/baseline.sql.gz, a committed schema-only
# dump of isaflow_dev (no data, roles or passwords) with its
# schema_migrations rows, made by refresh-baseline.sh. On every run the repo's
# own runner (scripts/apply-migrations.ts) applies each migration newer than
# the baseline, so a branch's new migration is exercised here before it
# reaches any shared database. Refresh the baseline only when its age starts
# to cost time; see refresh-baseline.sh.
# Limit: the baseline is dev's LIVE schema, drift included, not what the
# migrations alone build, and not production's.
#
# Why not the alternatives: the migrations do not build a database from zero
# (151 of 443 fail on an empty one), and dumping isaflow_dev at run time needs
# a dev credential the GitHub runner does not have.
#
# Shape of a run:
#   0. This user's earlier runs that died without cleaning up (SIGKILL) are
#      swept: a run directory whose recorded run.sh pid is gone has its shard
#      sessions ended and its clusters stopped, and is deleted. Nothing else
#      is touched.
#   1. One cluster (initdb in a mktemp dir, 127.0.0.1, a port the OS hands
#      out, scram password random per run). Roles as production has them
#      (pg-cluster.sh pg_create_roles), baseline loaded into
#      isaflow_schema_fixture, then the newer migrations applied AS `postgres`
#      while it is NOT a superuser, as production's deploy applies them: a
#      migration that needs a superuser fails here, not on production. Then
#      `postgres` becomes a superuser for the suites, as on every fixture they
#      were written against. isaflow_test is cloned from it: the suites guard
#      themselves by database NAME and the two guards disagree, so both names
#      exist; plan.ts routes each suite to the one it accepts (suiteRoute.ts).
#   2. The stopped cluster is copied SHARDS times; each copy starts on its own
#      port and runs its share of each database's suites, one file at a time
#      (--no-file-parallelism: parallel files on one database deadlock), in
#      its own session (shard.sh, under a time limit).
#   3. Each shard's vitest log is printed; the step fails if any shard fails,
#      ran a different number of files than it was given, or timed out.
#   4. On exit (also on INT/TERM) every shard session is ended (TERM, then KILL
#      after a grace), every cluster is stopped (pg_ctl -m immediate) and the
#      mktemp dir is deleted, and nothing else.
#
# CI_INTEGRATION_GATE=1 (set by with_db) tells the few suites with a
# wall-clock bound to skip just that bound here (tests/helpers/integrationGate.ts).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
# shellcheck source=pg-cluster.sh
source scripts/ci/integration/pg-cluster.sh

SHARDS=6
pg_require_extensions

# 0. Sweep this user's runs that died without cleaning up (lifecycle.sh).
sweep_dead_runs

WORK=$(mktemp -d "${TMPDIR:-/tmp}/isaflow-ci-int.XXXXXX")
write_owner "$WORK"
# The suites' (and vite's) temporary files live and die with the run.
SUITE_TMP="$WORK/tmp"
mkdir "$SUITE_TMP"
export SUITE_TMP
# A second INT/TERM/HUP must not cut cleanup short of rm -rf: ignored from here
# on. The schema-building step running now, if any, is ended with the shards.
cleanup() {
  local step=""
  trap '' INT TERM HUP
  [ -f "$WORK/step" ] && step=$(cat "$WORK/step")
  remove_run "$WORK" "$step"
}
trap cleanup EXIT
# hold_signals / release_signals: around starting a background child and
# recording it, an INT/TERM is noted instead of acted on, so cleanup always
# finds the record. (Ignoring them would pass SIG_IGN on to the child; a
# handler is reset to the default in it.)
pending=""
release_signals() {
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  [ -z "$pending" ] || exit "$pending"
}
hold_signals() {
  trap 'pending=129' HUP
  trap 'pending=130' INT
  trap 'pending=143' TERM
}
release_signals

PGPASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
# The suites sign and verify their own session tokens with it; random per run.
JWT=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
export PGPASSWORD JWT
START=$(date +%s)

bun scripts/ci/integration/plan.ts "$SHARDS" > "$WORK/plan.tsv"

# bounded <what> <command...>: each schema-building command gets
# CI_INT_MIGRATE_TIMEOUT seconds (default 300; the whole build takes under 30 s),
# so a migration or load that hangs fails the step instead of holding the
# runner. It runs in the background and is waited for: bash runs a trap only
# once a FOREGROUND child returns, so a TERM would otherwise wait out the limit.
# cleanup() ends it (pid + start time in $WORK/step).
MIGRATE_LIMIT=${CI_INT_MIGRATE_TIMEOUT:-300}
bounded() {
  local what=$1 status=0 t0 pid
  shift
  t0=$(date +%s)
  hold_signals
  timeout -k 30 "$MIGRATE_LIMIT" "$@" &
  pid=$!
  echo "$pid $(proc_start "$pid")" > "$WORK/step"
  release_signals
  wait "$pid" || status=$?
  rm -f "$WORK/step"
  case $(shard_outcome "$status" "$(( $(date +%s) - t0 ))" "$MIGRATE_LIMIT") in
    timeout) echo "[integration] $what did not finish within ${MIGRATE_LIMIT}s (CI_INT_MIGRATE_TIMEOUT)" >&2 ;;
    killed) echo "[integration] $what was KILLED (SIGKILL, not the time limit)" >&2 ;;
  esac
  return "$status"
}

# 1. Template cluster.
mkdir "$WORK/c1"
pg_cluster_init "$WORK/c1"
PORT=$(pg_cluster_start "$WORK/c1")
PSQL=("$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$PG_SUPERUSER" -X -q -v ON_ERROR_STOP=1)
pg_create_roles "$PORT"
"${PSQL[@]}" -d postgres -c "CREATE DATABASE isaflow_schema_fixture OWNER postgres"
gunzip -c scripts/ci/integration/baseline.sql.gz > "$WORK/baseline.sql"
bounded "loading the baseline" "${PSQL[@]}" -d isaflow_schema_fixture -f "$WORK/baseline.sql" > /dev/null
# A schema-only dump leaves every materialized view unpopulated, and reading
# one then errors; populate them (empty) as a deploy would have.
bounded "listing the materialized views" "${PSQL[@]}" -d isaflow_schema_fixture -At -o "$WORK/refresh.sql" \
  -c "SELECT format('REFRESH MATERIALIZED VIEW %I.%I;', schemaname, matviewname) FROM pg_matviews"
bounded "refreshing the materialized views" "${PSQL[@]}" -d isaflow_schema_fixture -f "$WORK/refresh.sql"
# As production's deploy: `postgres`, not a superuser. The runner forces TLS
# unless the URL says sslmode=disable.
suite_env "$PORT" isaflow_schema_fixture
bounded "the migrations" env "${SUITE_ENV[@]}" \
  "DATABASE_URL=postgresql://postgres@127.0.0.1:$PORT/isaflow_schema_fixture?sslmode=disable" \
  bun scripts/apply-migrations.ts
"${PSQL[@]}" -d postgres -c "ALTER ROLE postgres SUPERUSER" \
  -c "CREATE DATABASE isaflow_test TEMPLATE isaflow_schema_fixture OWNER postgres"
pg_cluster_stop "$WORK/c1"
echo "[integration] schema built in $(( $(date +%s) - START ))s"

# 2. Shards: SHARDS copies of the stopped template, each on its own port.
# A copy of a running cluster's files would be torn: refuse one that did not stop.
if [ -f "$WORK/c1/data/postmaster.pid" ]; then
  echo "[integration] the template cluster did not stop; refusing to copy it" >&2
  exit 1
fi
for i in $(seq 2 "$SHARDS"); do mkdir "$WORK/c$i"; cp -a "$WORK/c1/data" "$WORK/c$i/data"; done
declare -a PORTS=()
for i in $(seq 1 "$SHARDS"); do PORTS+=("$(pg_cluster_start "$WORK/c$i")"); done

# migration-parity-gate.int.test.ts needs two more throwaway servers holding
# no database but its own (tests/helpers/parityTestGuard.ts): two empty ones.
for p in p1 p2; do mkdir "$WORK/c$p"; pg_cluster_init "$WORK/c$p"; done
parity="postgresql://$PG_SUPERUSER@127.0.0.1:$(pg_cluster_start "$WORK/cp1")/postgres"
parity2="postgresql://$PG_SUPERUSER@127.0.0.1:$(pg_cluster_start "$WORK/cp2")/postgres"

declare -a PIDS=()
for i in $(seq 1 "$SHARDS"); do
  hold_signals
  setsid --wait bash scripts/ci/integration/shard.sh "$i" "$SHARDS" "${PORTS[$((i - 1))]}" "$WORK" "$parity" "$parity2" &
  # Recorded here, at launch, so a TERM a moment later still finds the shard:
  # a background child is no process-group leader, so setsid(1) does not fork
  # and $! becomes the session leader (sid == pid). Were it ever to fork, the
  # session would not match and nothing would be signalled (the shard's own
  # timeout still bounds it).
  # The child may not have called setsid() yet; record it once it has (2 s at most).
  for n in $(seq 1 40); do [ "$(proc_sid "$!")" = "$!" ] && break; sleep 0.05; done
  echo "$! $(proc_start "$!")" > "$WORK/c$i/sid"
  PIDS+=("$!")
  release_signals
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
