#!/bin/bash
# One-time (and safe to repeat) provisioning of the Deploy Verification company on production: resolves the three secrets
# from the same files deploy.sh and the app use, then runs scripts/deploy/provision-verify-company.ts with every target named.
#
#   bash scripts/deploy/provision-verify-company.sh --dry-run     # read-only: plan, database step rolled back
#   bash scripts/deploy/provision-verify-company.sh               # provision, then write E2E_VERIFY_* and E2E_VERIFY_APPROVER_* to the deploy env file
#
# Reads (names only, values never printed):
#   OWNER_DATABASE_URL         /etc/isaflow/owner.env, else $PROD_ENV (owner_database_url_for, as deploy.sh resolves it)
#   GOTRUE_URL                 $PROD_ENV (/home/velo/isaflow/.env.local), the instance the app logs in against
#   SUPABASE_SERVICE_ROLE_KEY  $PROD_ENV
#   JWT_SECRET, SUPABASE_ANON_KEY  $PROD_ENV (optional: only --reset-password uses them, to end the login's sessions)
# Both files are root/velo-only: read with `sudo cat`, as deploy.sh does. The secrets travel in the environment of the child,
# never its arguments.
#
# Overrides (all optional; PROVISION_ prefixed because BASE_URL and friends are set by other tools): PROVISION_PROD_ENV,
#   PROVISION_ENV_FILE (default /home/hein/isaflow-deploy.env, the file verify-deploy.sh reads), PROVISION_BASE_URL (default the
#   live colour behind nginx, http://127.0.0.1:3101: the seed goes through the running app, which must be backed by the same
#   database), PROVISION_EXPECT_DB (default isaflow, production's database name), SUDO, BUN.
# The secrets sit in the child process's environment for the run (readable by the same user, as the deploy's are): accepted.
# Never pass --reset-password to a GoTrue that is also dev's (it is one instance): it resets production's login.
# A real run holds /tmp/isaflow-deploy.lock and /tmp/isaflow-colours.lock (the deploy's own locks) for its whole duration and is
# refused while a deploy, rollback or restart runs; a --dry-run takes neither. The deploy env file ($PROVISION_ENV_FILE) must be
# mode 0600 (or stricter) and is written through its symlink target if it is one; a looser mode is refused, not widened.
# Run it outside 08:00-17:00 SAST Mon-Fri like any production write, and with Hein's approval.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PROD_ENV="${PROVISION_PROD_ENV:-/home/velo/isaflow/.env.local}"
SUDO="${SUDO-sudo}"
BUN="${BUN:-/home/hein/.bun/bin/bun}"
# shellcheck source=../ops/ownerDatabaseUrl.sh
. "$REPO_DIR/scripts/ops/ownerDatabaseUrl.sh"

# clean <value>: a CRLF file's trailing CR, and one pair of surrounding quotes, are not part of the value (systemd's
# EnvironmentFile, which loads this file for the app, drops them; a literal read must too).
clean() {
  local v="${1%$'\r'}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

# Literal read of one key from the env file, never `source`d (values are not valid shell, see deploy.sh).
# shellcheck disable=SC2086  # $SUDO is "sudo" or empty: it must split into zero or one words
env_value() { clean "$($SUDO cat "$PROD_ENV" | grep -m1 "^$1=" | cut -d= -f2- || true)"; }

# shellcheck disable=SC2086
DB_URL="$(clean "$(owner_database_url_for "$PROD_ENV" $SUDO || true)")"
GOTRUE="$(env_value GOTRUE_URL)"
KEY="$(env_value SUPABASE_SERVICE_ROLE_KEY)"
JWT="$(env_value JWT_SECRET)"          # only a --reset-password needs these two (to end the login's sessions);
ANON="$(env_value SUPABASE_ANON_KEY)"  # the CLI refuses a reset without them, before changing anything
for pair in "OWNER_DATABASE_URL/DATABASE_URL:$DB_URL" "GOTRUE_URL:$GOTRUE" "SUPABASE_SERVICE_ROLE_KEY:$KEY"; do
  [ -n "${pair#*:}" ] || { echo "ERROR: ${pair%%:*} not found in ${OWNER_ENV_FILE:-/etc/isaflow/owner.env} or $PROD_ENV" >&2; exit 1; }
done

VERIFY_COMPANY_DATABASE_URL="$DB_URL" GOTRUE_URL="$GOTRUE" SUPABASE_SERVICE_ROLE_KEY="$KEY" JWT_SECRET="$JWT" SUPABASE_ANON_KEY="$ANON" \
  exec "$BUN" "$REPO_DIR/scripts/deploy/provision-verify-company.ts" \
    --expect-database "${PROVISION_EXPECT_DB:-isaflow}" \
    --base-url "${PROVISION_BASE_URL:-http://127.0.0.1:3101}" \
    --env-file "${PROVISION_ENV_FILE:-/home/hein/isaflow-deploy.env}" "$@"
