#!/usr/bin/env bash
# Advisory CI check (job "Migrations on prod schema (advisory)" in ci.yml):
# do this branch's pending migrations apply on PRODUCTION's schema?
#
#   PROD_BASELINE_DIR=<dir> bash scripts/ci/prod-baseline/phase-a.sh
#
# The integration gate (integration/run.sh) builds its schema from a dump of
# isaflow_dev, so a migration can pass it and still fail on production, whose
# schema differs. This loads a schema-only dump of production instead, into a
# throwaway cluster built with the gate's own helpers (pg-cluster.sh,
# lifecycle.sh), and runs the repo's runner on top exactly as run.sh does,
# then the schema-drift audit (scripts/audit-schema-drift.ts) on the result.
#
# <dir> holds the three files of the private repo Heinvv10/isaflow-prod-schema:
# prod-baseline.sql.gz, prod-baseline.sql.gz.sha256, prod-baseline.meta.json.
#
# CONFIDENTIAL: the baseline is production's schema and this repo and its CI
# logs are public. Nothing from it is printed, kept or copied into the repo:
# the only output is migration file names, the meta file's counts and
# release_sha, and the error lines of a failed load or migration. psql runs
# quiet with stdout discarded; never add `set -x`, `cat` or `head` near it.
#
# Exit: 0 every pending migration applied and the audit found no drift, or
# the branch predates the baseline's release (a ::notice::, nothing run); 1 the
# baseline did not load, a migration failed or the audit failed; 2 bad input
# (no dir, checksum, meta).
set -euo pipefail
umask 077

die() { echo "::error::prod-baseline: $1" >&2; exit "${2:-2}"; }

DIR=${PROD_BASELINE_DIR:-}
[ -n "$DIR" ] || die "PROD_BASELINE_DIR is not set (the directory holding prod-baseline.sql.gz, .sha256 and .meta.json)"
[ -d "$DIR" ] || die "PROD_BASELINE_DIR is not a directory: $DIR"
DIR=$(cd "$DIR" && pwd -P)
for f in prod-baseline.sql.gz prod-baseline.sql.gz.sha256 prod-baseline.meta.json; do
  [ -f "$DIR/$f" ] || die "$DIR has no $f"
done

cd "$(git rev-parse --show-toplevel)"

# The checksum file must name exactly the dump: sha256sum -c checks whatever it names.
read -r _ named < "$DIR/prod-baseline.sql.gz.sha256" || true
if [ "$(wc -l < "$DIR/prod-baseline.sql.gz.sha256")" -ne 1 ] || [ "${named#\*}" != prod-baseline.sql.gz ]; then
  die "prod-baseline.sql.gz.sha256 must hold exactly one line, for prod-baseline.sql.gz"
fi
(cd "$DIR" && sha256sum --check --strict --status prod-baseline.sql.gz.sha256) \
  || die "prod-baseline.sql.gz does not match prod-baseline.sql.gz.sha256"

# Hex only, so the one value printed from the meta file is a commit id.
RELEASE=$(jq -r '.release_sha // empty' "$DIR/prod-baseline.meta.json" 2> /dev/null) || RELEASE=""
[[ "$RELEASE" =~ ^[0-9a-f]{7,40}$ ]] || die "prod-baseline.meta.json has no release_sha (7-40 hex digits)"
COUNTS=$(jq -r '.counts // {} | to_entries | map(select((.key | test("^[a-z_]+$")) and (.value | type) == "number") | "\(.key)=\(.value)") | join(" ")' \
  "$DIR/prod-baseline.meta.json" 2> /dev/null) || COUNTS=""

# Stale-branch guard: a branch that does not contain the release production
# runs would list (and try) migrations production already has. Not a failure.
if ! git cat-file -e "$RELEASE^{commit}" 2> /dev/null; then
  git fetch -q origin master > /dev/null 2>&1 || true
  git cat-file -e "$RELEASE^{commit}" 2> /dev/null \
    || die "release $RELEASE (prod-baseline.meta.json) is not a commit here, even after fetching origin master" 1
fi
if ! git merge-base --is-ancestor "$RELEASE" HEAD; then
  echo "::notice::prod-baseline: this branch does not contain production's release $RELEASE; merge master to check its migrations against production's schema"
  exit 0
fi

# shellcheck source=scripts/ci/integration/pg-cluster.sh
source scripts/ci/integration/pg-cluster.sh
pg_require_extensions
# This user's integration or prod-baseline runs that died without cleaning up (lifecycle.sh).
sweep_dead_runs

# The run directory as run.sh makes it (isaflow-ci-int.*, owner record), so a
# SIGKILLed run is swept like the gate's. Cleanup (lifecycle.sh end_run) stops
# the cluster and deletes the directory, the unpacked baseline with it.
hold_signals
WORK=$(mktemp -d "${TMPDIR:-/tmp}/isaflow-ci-int.XXXXXX")
write_owner "$WORK"
SUITE_TMP="$WORK/tmp"
mkdir "$SUITE_TMP"
export SUITE_TMP
cleanup() { end_run "$WORK"; }
trap cleanup EXIT
release_signals

PGPASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
JWT=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
export PGPASSWORD JWT
START=$(date +%s)
LIMIT=${CI_INT_MIGRATE_TIMEOUT:-300}

# load_failed <what> <stderr file>: say so, with at most 20 of psql's own
# error lines (never the statement text psql echoes after them), and fail.
load_failed() {
  echo "::error::prod-baseline: $1 failed on production's schema (release $RELEASE)" >&2
  grep -E '^(ERROR:|psql:)' "$2" | head -n 20 >&2 || true
  exit 1
}

mkdir "$WORK/c1"
pg_cluster_init "$WORK/c1"
PORT=$(pg_cluster_start "$WORK/c1")
PSQL=("$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$PG_SUPERUSER" -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse)
# The gate's roles, then the four production has that the gate does not
# create (dev's dump names none of them; production's grants and owners do).
pg_create_roles "$PORT"
"${PSQL[@]}" -d postgres > /dev/null <<'SQL'
CREATE ROLE app_service NOLOGIN;
CREATE ROLE supabase_admin NOLOGIN SUPERUSER;
CREATE ROLE isaflow_app NOLOGIN NOINHERIT;
CREATE ROLE isaflow_service NOLOGIN;
GRANT app_user TO app_service;
GRANT app_user TO isaflow_app;
GRANT app_service TO isaflow_service;
SQL
"${PSQL[@]}" -d postgres -c "CREATE DATABASE isaflow_schema_fixture OWNER postgres" > /dev/null

gunzip -c "$DIR/prod-baseline.sql.gz" > "$WORK/baseline.sql"
# client_min_messages=error: the dump's notices would name its objects.
PGOPTIONS='-c client_min_messages=error' timeout -k 30 "$LIMIT" \
  "${PSQL[@]}" -d isaflow_schema_fixture -f "$WORK/baseline.sql" > /dev/null 2> "$WORK/load.err" \
  || load_failed "loading the baseline" "$WORK/load.err"
rm -f "$WORK/baseline.sql"
# As run.sh: a schema-only dump leaves every materialized view unpopulated.
PGOPTIONS='-c client_min_messages=error' timeout -k 30 "$LIMIT" "${PSQL[@]}" -d isaflow_schema_fixture -At -o "$WORK/refresh.sql" \
  -c "SELECT format('REFRESH MATERIALIZED VIEW %I.%I;', schemaname, matviewname) FROM pg_matviews" 2> "$WORK/load.err" \
  || load_failed "listing the materialized views" "$WORK/load.err"
PGOPTIONS='-c client_min_messages=error' timeout -k 30 "$LIMIT" \
  "${PSQL[@]}" -d isaflow_schema_fixture -f "$WORK/refresh.sql" > /dev/null 2> "$WORK/load.err" \
  || load_failed "refreshing the materialized views" "$WORK/load.err"
echo "prod-baseline: release $RELEASE loaded in $(( $(date +%s) - START ))s${COUNTS:+ ($COUNTS)}"

# Pending: the runner's own plan (planApply) against the loaded tracking rows.
"${PSQL[@]}" -d isaflow_schema_fixture -At -o "$WORK/applied.txt" -c "SELECT name FROM schema_migrations"
bun scripts/ci/prod-baseline/pending.ts "$WORK/applied.txt" > "$WORK/pending.txt"
PENDING=$(grep -c . "$WORK/pending.txt" || true)
echo "prod-baseline: release $RELEASE, $PENDING migration(s) pending"
sed 's/^/  /' "$WORK/pending.txt"

# Exactly as run.sh: the runner AS `postgres`, not a superuser, in the suites'
# fixed environment (pg-cluster.sh suite_env), TLS off in the URL. One
# addition: PGOPTIONS keeps the server's notices and warnings from the runner,
# which prints them ("... does not exist, skipping" would describe
# production's schema); a migration's ERROR still reaches it and is printed.
suite_env "$PORT" isaflow_schema_fixture
status=0
timeout -k 30 "$LIMIT" env "${SUITE_ENV[@]}" \
  "DATABASE_URL=postgresql://postgres@127.0.0.1:$PORT/isaflow_schema_fixture?sslmode=disable" \
  'PGOPTIONS=-c client_min_messages=error' \
  bun scripts/apply-migrations.ts 2>&1 | tee "$WORK/migrate.log" || status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  failed=$(sed -n 's/^applying \(.*\) \.\.\.$/\1/p' "$WORK/migrate.log" | tail -n 1)
  [ "$status" -eq 124 ] && echo "::error::prod-baseline: the migrations did not finish within ${LIMIT}s (CI_INT_MIGRATE_TIMEOUT)" >&2
  echo "::error::prod-baseline: ${failed:-the migration runner} failed on production's schema (release $RELEASE); its error is above" >&2
  exit 1
fi
echo "prod-baseline: $PENDING pending migration(s) applied on production's schema (release $RELEASE) in $(( $(date +%s) - START ))s"

# The drift audit (bun run db:audit-drift) on the migrated database: every
# table and column the repo's migrations declare must exist on it, less
# scripts/schema-drift-allowlist.txt. It prints only names those (public)
# migrations declare. Same environment as the runner.
status=0
timeout -k 30 "$LIMIT" env "${SUITE_ENV[@]}" 'PGOPTIONS=-c client_min_messages=error' \
  bun scripts/audit-schema-drift.ts 2>&1 || status=$?
if [ "$status" -ne 0 ]; then
  [ "$status" -eq 124 ] && echo "::error::prod-baseline: the schema-drift audit did not finish within ${LIMIT}s (CI_INT_MIGRATE_TIMEOUT)" >&2
  echo "::error::prod-baseline: the schema-drift audit failed (exit $status) on production's schema plus the pending migrations (release $RELEASE); its output is above" >&2
  exit 1
fi
