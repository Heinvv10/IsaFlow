#!/usr/bin/env bash
# Stand up the disposable integration-test fixture database from the repository alone.
#
#   usage: bash scripts/forensic/fixture-up.sh [port]        (default port 33150)
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

PORT=${1:-33150}
[[ $PORT =~ ^[0-9]{5}$ ]] || { echo "REFUSED: port must be five digits (got '$PORT')" >&2; exit 2; }
NAME=isaflow-forensic-$PORT
DB=isaflow_schema_fixture
IMAGE=pgvector/pgvector:pg16
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
say(){ printf '[fixture-up] %s\n' "$*"; }
die(){ printf '[fixture-up] REFUSED: %s\n' "$*" >&2; exit 2; }

docker inspect "$NAME" >/dev/null 2>&1 && die "container $NAME already exists — run fixture-down.sh $PORT first"
ss -ltn 2>/dev/null | grep -q ":$PORT " && die "port $PORT is already in use"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE is missing (this script never pulls: docker pull $IMAGE)"
[ -s "$HERE/fixture/schema.sql" ] || die "$HERE/fixture/schema.sql is missing or empty"

# Throwaway, loopback-only, regenerated on every run. Never a secret worth keeping.
PGPASS=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')

say "postgres $NAME on 127.0.0.1:$PORT"
docker run -d --name "$NAME" --label purpose=isaflow-integration-fixture \
  -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$DB" \
  -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null
trap 'echo "[fixture-up] FAILED — removing $NAME" >&2; docker rm -f "$NAME" >/dev/null 2>&1 || true' ERR

for _ in $(seq 60); do docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
docker exec "$NAME" pg_isready -U postgres -q || die "postgres did not become ready"
sleep 2  # the image restarts once after initdb

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
STATE=${ISAFLOW_FIXTURE_STATE:-$HOME/.cache/isaflow-fixture}
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
trap - ERR
TABLES=$(docker exec "$NAME" psql -U postgres -d "$DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
say "UP: $NAME, $TABLES public tables. Env: eval \"\$(bash $HERE/fixture-env.sh $PORT)\""
say "Verify it matches this branch: bash $HERE/fixture-verify.sh $PORT"
