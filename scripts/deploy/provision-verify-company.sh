#!/bin/bash
# One-time (and safe to repeat) provisioning of the Deploy Verification company on production: resolves the three secrets
# from the same files deploy.sh and the app use, then runs scripts/deploy/provision-verify-company.ts with every target named.
#
#   bash scripts/deploy/provision-verify-company.sh --dry-run     # read-only: plan, database step rolled back
#   bash scripts/deploy/provision-verify-company.sh               # provision, then write E2E_VERIFY_* to the deploy env file
#
# Reads (names only, values never printed):
#   OWNER_DATABASE_URL         /etc/isaflow/owner.env, else $PROD_ENV (owner_database_url_for, as deploy.sh resolves it)
#   GOTRUE_URL                 $PROD_ENV (/home/velo/isaflow/.env.local), the instance the app logs in against
#   SUPABASE_SERVICE_ROLE_KEY  $PROD_ENV
# Both files are root/velo-only: read with `sudo cat`, as deploy.sh does. The secrets travel in the environment of the child,
# never its arguments.
#
# Overrides (all optional; PROVISION_ prefixed because BASE_URL and friends are set by other tools): PROVISION_PROD_ENV,
#   PROVISION_ENV_FILE (default /home/hein/isaflow-deploy.env, the file verify-deploy.sh reads), PROVISION_BASE_URL (default the
#   live colour behind nginx, http://127.0.0.1:3101: the seed goes through the running app, which must be backed by the same
#   database), PROVISION_EXPECT_DB (default isaflow, production's database name), SUDO, BUN.
# Run it outside 08:00-17:00 SAST Mon-Fri like any production write, and with Hein's approval.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PROD_ENV="${PROVISION_PROD_ENV:-/home/velo/isaflow/.env.local}"
SUDO="${SUDO-sudo}"
BUN="${BUN:-/home/hein/.bun/bin/bun}"
# shellcheck source=../ops/ownerDatabaseUrl.sh
. "$REPO_DIR/scripts/ops/ownerDatabaseUrl.sh"

# Literal read of one key from the env file, never `source`d (values are not valid shell, see deploy.sh).
# shellcheck disable=SC2086
env_value() { $SUDO cat "$PROD_ENV" | grep -m1 "^$1=" | cut -d= -f2- || true; }

# shellcheck disable=SC2086  # $SUDO is "sudo" or empty: it must split into zero or one words
DB_URL="$(owner_database_url_for "$PROD_ENV" $SUDO || true)"
GOTRUE="$(env_value GOTRUE_URL)"
KEY="$(env_value SUPABASE_SERVICE_ROLE_KEY)"
for pair in "OWNER_DATABASE_URL/DATABASE_URL:$DB_URL" "GOTRUE_URL:$GOTRUE" "SUPABASE_SERVICE_ROLE_KEY:$KEY"; do
  [ -n "${pair#*:}" ] || { echo "ERROR: ${pair%%:*} not found in ${OWNER_ENV_FILE:-/etc/isaflow/owner.env} or $PROD_ENV"; exit 1; }
done

VERIFY_COMPANY_DATABASE_URL="$DB_URL" GOTRUE_URL="$GOTRUE" SUPABASE_SERVICE_ROLE_KEY="$KEY" \
  exec "$BUN" "$REPO_DIR/scripts/deploy/provision-verify-company.ts" \
    --expect-database "${PROVISION_EXPECT_DB:-isaflow}" \
    --base-url "${PROVISION_BASE_URL:-http://127.0.0.1:3101}" \
    --env-file "${PROVISION_ENV_FILE:-/home/hein/isaflow-deploy.env}" "$@"
