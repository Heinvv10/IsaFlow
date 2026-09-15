#!/usr/bin/env bash
# Stand up the disposable integration-test fixture database from the repository alone.
#
#   usage: bash scripts/forensic/fixture-up.sh [port]   (no port: allocates a free one, 33150-33199)
#   then:  eval "$(bash scripts/forensic/fixture-env.sh [port])"
#          bun run test:integration
#   down:  bash scripts/forensic/fixture-down.sh [port]
#
# Creates ONE container, isaflow-forensic-<port>, bound to 127.0.0.1 only, holding the database
# isaflow_schema_fixture restored from fixture/schema.sql. Nothing else on the machine is touched:
# no pull, no prune, no shared volume. Teardown removes that container BY NAME.
#
# WHY A SNAPSHOT AND NOT `bun run db:migrate`: a from-scratch apply of the migration set does NOT
# reproduce this application's schema. Two divergences are proven (2026-09-14) and there may be
# more: (1) no migration ever converts company_users.user_id from UUID to TEXT, yet the live column
# is TEXT — and 348_rls_and_auth_helpers.sql builds every tenant_isolation policy on
# "user_id = auth.uid()", which is text, so from scratch 348 dies and ~90 later migrations die with
# it; (2) 253_missing_tables.sql creates stock_items as a VIEW over products.sku, but products has
# no sku column and the live stock_items is a base table. fixture/schema.sql descends from the real
# schema instead, so the fixture models what the code actually runs against.
#
# The snapshot is only trustworthy while it matches the branch. schema-match.ts is the check, and
# fixture-verify.sh runs it. See fixture/README.md for how to regenerate after new migrations land.
set -euo pipefail

DB=isaflow_schema_fixture
IMAGE=pgvector/pgvector:pg16
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STATE=${ISAFLOW_FIXTURE_STATE:-$HOME/.cache/isaflow-fixture}
say(){ printf '[fixture-up] %s\n' "$*"; }
die(){ printf '[fixture-up] REFUSED: %s\n' "$*" >&2; exit 2; }
free_port(){ ! docker inspect "isaflow-forensic-$1" >/dev/null 2>&1 && ! ss -ltn 2>/dev/null | grep -q ":$1 "; }

# WITHOUT an argument, ALLOCATE a free port instead of defaulting everyone to 33150.
#
# The container name must be exactly isaflow-forensic-<port> — `validateFixtureTarget` in
# tests/integration/forensic-fixture.ts requires the label to match the port — so the port IS the
# identity, and several sessions defaulting to the same one collide. In practice they did worse
# than collide: a peer running `fixture-down.sh` with the default removed a fixture another session
# was testing against. Allocating makes that stop happening rather than asking people to remember.
if [ $# -ge 1 ]; then
  PORT=$1
  [[ $PORT =~ ^[0-9]{5}$ ]] || die "port must be five digits (got '$PORT')"
  docker inspect "isaflow-forensic-$PORT" >/dev/null 2>&1 && die "container isaflow-forensic-$PORT already exists — it may be another session's; run fixture-down.sh $PORT only if it is yours, or omit the port to allocate a free one"
  ss -ltn 2>/dev/null | grep -q ":$PORT " && die "port $PORT is already in use"
else
  PORT=""
  for p in $(seq 33150 33199); do free_port "$p" && { PORT=$p; break; }; done
  [ -n "$PORT" ] || die "no free port in 33150-33199 — tear down a fixture first"
  say "allocated port $PORT (pass one explicitly to pin it)"
fi
NAME=isaflow-forensic-$PORT
# Identifies the run that created this container, so fixture-down refuses to remove a peer's.
OWNER=$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE is missing (this script never pulls: docker pull $IMAGE)"
[ -s "$HERE/fixture/schema.sql" ] || die "$HERE/fixture/schema.sql is missing or empty"

# Throwaway, loopback-only, regenerated on every run. Never a secret worth keeping.
PGPASS=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')

say "postgres $NAME on 127.0.0.1:$PORT"
docker run -d --name "$NAME" --label purpose=isaflow-integration-fixture --label owner="$OWNER" \
  -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$DB" \
  -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null
# EXIT, not ERR: a `die` or any other non-zero path must also clean up. Without this a failed run
# leaves a half-built container behind, and the next fixture-up on that port refuses because the
# name is taken — which reads as a stale-lock problem rather than the failure it actually was.
CLEANUP=1
trap '[ "$CLEANUP" = 1 ] && { echo "[fixture-up] FAILED — removing $NAME" >&2; docker rm -f "$NAME" >/dev/null 2>&1; }' EXIT

# The image starts a TEMPORARY server to run initdb, then shuts it down and starts the real one.
# `pg_isready` answers yes during that temporary window, so a single check plus a fixed sleep is a
# race — under load it loses, and the restore then dies on "the database system is shutting down".
# Require the server to answer a real query THREE times a second apart: the shutdown falls inside
# any such window, so three consecutive successes mean the restart is behind us.
ok=0
for _ in $(seq 90); do
  if docker exec "$NAME" psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 3 ] && break
  else
    ok=0
  fi
  sleep 1
done
[ "$ok" -ge 3 ] || die "postgres did not become stably ready (saw $ok consecutive successful queries)"

say "roles"
docker exec -i "$NAME" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < "$HERE/fixture/roles.sql"

say "schema (fixture/schema.sql)"
docker exec -i "$NAME" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 < "$HERE/fixture/schema.sql"

# Rows that MIGRATIONS insert, not rows a fixture run creates: `pg_dump -s` drops them, and routes
# validate against them — without permission_modules the control routes answer 400 "Unknown
# moduleKey: audit". Company-agnostic tables only (none has a company_id; the asset_categories GL
# columns are all NULL), so no tenant data is carried.
say "reference data (permission_modules, feature_flags, asset_categories)"
docker exec -i "$NAME" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 < "$HERE/fixture/reference-data.sql"

# Both roles carry LOGIN in the live cluster; give them this run's throwaway password so a caller
# that connects as them (PLATFORM_ADMIN_DATABASE_URL) works without editing anything.
docker exec "$NAME" psql -U postgres -q -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE platform_admin PASSWORD '$PGPASS'; ALTER ROLE migration_admin PASSWORD '$PGPASS';"

# Written where fixture-env.sh and fixture-down.sh can find it; 0600, outside the repo tree.
mkdir -p "$STATE"; chmod 700 "$STATE"
# Throwaway app secrets, generated ONCE per fixture and kept in the state file. Generating them
# per run instead would make rows this fixture already holds undecryptable on the next run:
# control evidence is encrypted with ENCRYPTION_KEY and fingerprinted with CONTROL_FINGERPRINT_KEY.
secret(){ head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
( umask 077; { cat <<EOF
ISAFLOW_FORENSIC_FIXTURE_OPT_IN=1
ISAFLOW_FORENSIC_FIXTURE_URL=postgresql://postgres:$PGPASS@127.0.0.1:$PORT/$DB
ISAFLOW_FORENSIC_FIXTURE_PORT=$PORT
ISAFLOW_FORENSIC_FIXTURE_LABEL=$NAME
ISAFLOW_FIXTURE_OWNER=$OWNER
DATABASE_URL=postgresql://postgres:$PGPASS@127.0.0.1:$PORT/$DB
PLATFORM_ADMIN_DATABASE_URL=postgresql://platform_admin:$PGPASS@127.0.0.1:$PORT/$DB
ISAFLOW_AUDIT_WORKER_DATABASE_URL=postgresql://postgres:$PGPASS@127.0.0.1:$PORT/$DB
DATABASE_SSL=disable
ISAFLOW_DISPOSABLE_AUTH_TEST=1
GOTRUE_URL=http://127.0.0.1:1
EOF
for n in ENCRYPTION_KEY CONTROL_FINGERPRINT_KEY CONTROL_SNAPSHOT_SIGNING_KEY PORTAL_JWT_SECRET \
         IMPERSONATION_JWT_SECRET EXTENSION_SIGNING_KEY CRON_SECRET PRINT_TOKEN_SECRET; do
  echo "$n=$(secret)"
done
} > "$STATE/$NAME.env" )
CLEANUP=0
TABLES=$(docker exec "$NAME" psql -U postgres -d "$DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
say "UP: $NAME, $TABLES public tables. Env: eval \"\$(bash $HERE/fixture-env.sh $PORT)\""
say "Verify it matches this branch: bash $HERE/fixture-verify.sh $PORT"
