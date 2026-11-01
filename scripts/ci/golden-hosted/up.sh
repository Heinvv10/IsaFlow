#!/usr/bin/env bash
# Stands up everything Golden Paths needs on a GitHub-hosted runner, where
# velo's shared isaflow_dev, GoTrue and /home/hein/isaflow-ci.env do not exist:
#
#   1. a throwaway PostgreSQL 16 cluster (the integration gate's own helpers,
#      scripts/ci/integration/pg-cluster.sh), loaded from the committed schema
#      baseline plus the repo's migrations, exactly as integration/run.sh builds
#      its template, but left running for the steps that follow;
#   2. a real GoTrue (the image velo runs) on its own database, as in
#      production, where GoTrue's `auth` schema is not the app's database;
#   3. the Demo company and the E2E admin (seed-demo.sql, and the admin through
#      GoTrue's admin API, so the password is a real GoTrue password);
#   4. a generated .env.local of random, run-local values. Nothing here is a
#      secret and none of it can reach anything outside this runner.
#
# Output: .env.local in the repo root; E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD in
# $ADMIN_ENV_FILE (default: $RUNNER_TEMP/golden-admin.env) for the Playwright
# step to source. Nothing secret is printed. The cluster and the GoTrue container die with the runner.
#
#   bash scripts/ci/golden-hosted/up.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
# shellcheck source=../integration/pg-cluster.sh
source scripts/ci/integration/pg-cluster.sh

# The image velo runs (v2.186.0), from Docker Hub, then Supabase's own ECR
# mirror when the pull fails (a Hub outage or throttle must not fail the gate).
GOTRUE_IMAGES=${GOTRUE_IMAGES:-"supabase/gotrue:v2.186.0 public.ecr.aws/supabase/gotrue:v2.186.0"}
APP_DB=isaflow_golden
AUTH_DB=gotrue_golden
START=$(date +%s)

rand() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
# pg_url <database>: the throwaway cluster's URL, as `postgres`. No password in
# it: pg, psql and GoTrue's driver read this run's random PGPASSWORD (the
# integration suites connect the same way, pg-cluster.sh suite_env).
pg_url() { printf 'postgresql://postgres@127.0.0.1:%s/%s' "$PORT" "$1"; }

PGPASSWORD=$(rand 24)
JWT_SECRET=$(rand 32)
JWT=$JWT_SECRET
export PGPASSWORD JWT JWT_SECRET
ADMIN_ENV_FILE=${ADMIN_ENV_FILE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/golden-admin.env}
ADMIN_EMAIL=golden-admin@isaflow.test
ADMIN_PASSWORD="Gp-$(rand 12)-Aa1"
echo "::add-mask::$ADMIN_PASSWORD"

WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/isaflow-golden-db.XXXXXX")
mkdir "$WORK/c1"
pg_require_extensions
pg_cluster_init "$WORK/c1"
PORT=$(pg_cluster_start "$WORK/c1")
PSQL=("$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$PG_SUPERUSER" -X -q -v ON_ERROR_STOP=1)
pg_create_roles "$PORT"
"${PSQL[@]}" -d postgres -c "CREATE DATABASE $APP_DB OWNER postgres" -c "CREATE DATABASE $AUTH_DB OWNER postgres"
# GoTrue's migrations expect the `auth` schema to exist (Supabase's own init
# creates it); its tables go there, in a database of its own, and its queries
# name no schema, so the database's search_path is `auth` as Supabase's
# supabase_auth_admin role has it.
"${PSQL[@]}" -d "$AUTH_DB" -c "CREATE SCHEMA auth AUTHORIZATION postgres" \
  -c "ALTER DATABASE $AUTH_DB SET search_path = auth"

# The schema, as integration/run.sh builds it (see its header for why a
# baseline plus newer migrations, and why `postgres` is not a superuser while
# the migrations run).
gunzip -c scripts/ci/integration/baseline.sql.gz > "$WORK/baseline.sql"
"${PSQL[@]}" -d "$APP_DB" -f "$WORK/baseline.sql" > /dev/null
"${PSQL[@]}" -d "$APP_DB" -At -o "$WORK/refresh.sql" \
  -c "SELECT format('REFRESH MATERIALIZED VIEW %I.%I;', schemaname, matviewname) FROM pg_matviews"
"${PSQL[@]}" -d "$APP_DB" -f "$WORK/refresh.sql"
suite_env "$PORT" "$APP_DB"
env "${SUITE_ENV[@]}" "DATABASE_URL=postgresql://postgres@127.0.0.1:$PORT/$APP_DB?sslmode=disable" \
  bun scripts/apply-migrations.ts > "$WORK/migrate.log" 2>&1 || { tail -40 "$WORK/migrate.log" >&2; echo "::error::migrations failed" >&2; exit 1; }
echo "[golden-hosted] schema built in $(( $(date +%s) - START ))s"

# GoTrue, on host networking, migrating its own database.
GOTRUE_IMAGE=""
for img in $GOTRUE_IMAGES; do
  for _ in 1 2 3; do
    if docker pull -q "$img" > /dev/null; then GOTRUE_IMAGE=$img; break 2; fi
    sleep 5
  done
done
[ -n "$GOTRUE_IMAGE" ] || { echo "::error::could not pull a GoTrue image ($GOTRUE_IMAGES)" >&2; exit 1; }
GPORT=$(free_port)
eval "$(bun scripts/ci/golden-hosted/mint-keys.ts | sed 's/^/export /')"
docker run -d --name golden-gotrue --network host \
  -e GOTRUE_API_HOST=127.0.0.1 -e GOTRUE_API_PORT="$GPORT" \
  -e GOTRUE_DB_DRIVER=postgres -e PGPASSWORD \
  -e GOTRUE_DB_DATABASE_URL="$(pg_url "$AUTH_DB")?sslmode=disable" \
  -e GOTRUE_JWT_SECRET="$JWT_SECRET" -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated \
  -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated -e GOTRUE_JWT_ADMIN_ROLES=service_role \
  -e GOTRUE_SITE_URL=http://localhost:3200 -e API_EXTERNAL_URL="http://127.0.0.1:$GPORT" \
  -e GOTRUE_DISABLE_SIGNUP=false -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=false \
  -e GOTRUE_EXTERNAL_PHONE_ENABLED=false -e GOTRUE_SMS_AUTOCONFIRM=false -e GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false \
  -e GOTRUE_MFA_TOTP_ENROLL_ENABLED=true -e GOTRUE_MFA_TOTP_VERIFY_ENABLED=true \
  -e GOTRUE_DB_MIGRATIONS_PATH=/usr/local/etc/auth/migrations \
  "$GOTRUE_IMAGE" > /dev/null
GOTRUE_URL="http://127.0.0.1:$GPORT"
ready=0
for _ in $(seq 1 60); do
  if curl -sf "$GOTRUE_URL/health" > /dev/null; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "::error::GoTrue did not become healthy" >&2
  docker logs golden-gotrue 2>&1 | tail -30 | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g' >&2
  exit 1
fi
echo "[golden-hosted] GoTrue healthy on $GPORT"

# The E2E admin: a confirmed GoTrue user, so the password is judged by GoTrue
# itself at login.
ADMIN_ID=$(curl -sf -X POST "$GOTRUE_URL/admin/users" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"email_confirm\":true}" | jq -r .id)
[ -n "$ADMIN_ID" ] && [ "$ADMIN_ID" != null ] || { echo "::error::GoTrue refused to create the E2E admin" >&2; exit 1; }

"${PSQL[@]}" -d "$APP_DB" -v admin_id="$ADMIN_ID" -v admin_email="$ADMIN_EMAIL" -f scripts/ci/golden-hosted/seed-demo.sql
echo "[golden-hosted] Demo company and E2E admin seeded"

APP_URL=$(pg_url "$APP_DB")
umask 077
cat > .env.local <<ENV
PGPASSWORD=$PGPASSWORD
DATABASE_URL=$APP_URL
PLATFORM_ADMIN_DATABASE_URL=$APP_URL
MIGRATION_ADMIN_DATABASE_URL=$APP_URL
DATABASE_SSL=disable
JWT_SECRET=$JWT_SECRET
GOTRUE_URL=$GOTRUE_URL
SUPABASE_URL=$GOTRUE_URL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
SUPABASE_CAPTURED_DOCS_BUCKET=captured-docs
ENCRYPTION_KEY=$(rand 32)
PORTAL_JWT_SECRET=$(rand 32)
IMPERSONATION_JWT_SECRET=$(rand 32)
EXTENSION_SIGNING_KEY=$(rand 32)
CRON_SECRET=$(rand 32)
ENV

# The Playwright step sources this. Not GITHUB_ENV: a step's own `env:` beats
# it, and the real E2E_ADMIN_* secrets must never reach a hosted run anyway.
printf 'E2E_ADMIN_EMAIL=%s\nE2E_ADMIN_PASSWORD=%s\n' "$ADMIN_EMAIL" "$ADMIN_PASSWORD" > "$ADMIN_ENV_FILE"
echo "[golden-hosted] ready in $(( $(date +%s) - START ))s"
