# shellcheck shell=bash
# owner_database_url <label> < env-file
#
# Prints the URL the deploy must use for work that needs the schema owner:
# applying migrations, the schema-drift audit, the migration-parity gate and
# verify-deploy's integrity check, and the backups. That is OWNER_DATABASE_URL. S-07b
# (migration 915) moves the app's DATABASE_URL to isaflow_app, which owns
# nothing and cannot apply a migration.
#
# Until the env file names OWNER_DATABASE_URL it falls back to DATABASE_URL,
# with a warning on stderr, so a deploy made before the env change still runs.
# Prints nothing (and returns 1) when the file names neither.
#
# The env file comes on stdin so the caller can read a root-only file with
# `sudo cat`; <label> names it in the warning. scripts/ops/lib-pgconn.sh (the
# backups and the restore drill) uses it too, so install-backup-ops.sh installs
# it beside lib-pgconn.sh.
owner_database_url() {
  local label="$1" text url
  text=$(cat)
  url=$(printf '%s\n' "$text" | grep -E '^OWNER_DATABASE_URL=' | head -1 | cut -d= -f2- || true)
  if [ -n "$url" ]; then
    printf '%s\n' "$url"
    return 0
  fi
  url=$(printf '%s\n' "$text" | grep -E '^DATABASE_URL=' | head -1 | cut -d= -f2- || true)
  if [ -z "$url" ]; then
    return 1
  fi
  {
    echo "WARNING: OWNER_DATABASE_URL is not set in $label - falling back to DATABASE_URL."
    echo "WARNING: once DATABASE_URL logs in as isaflow_app (S-07b), migrations, the parity gate and verify-deploy FAIL with it."
  } >&2
  printf '%s\n' "$url"
}

# Production keeps OWNER_DATABASE_URL in its own file, root:root 0600, outside
# the deploy directory (rsync --delete would remove it from there) and outside
# what the app process loads: the app runs as velo with EnvironmentFile=.env.local,
# so an owner URL in .env.local is in the app's environment (S-07b follow-up F,
# docs/runbooks/s07b-app-pool-login-roles.md step 5).
OWNER_ENV_FILE=${OWNER_ENV_FILE:-/etc/isaflow/owner.env}

# owner_database_url_for <env-file> [<reader prefix>...]
#
# The owner URL for the database <env-file> points at: OWNER_DATABASE_URL from
# $OWNER_ENV_FILE first, then owner_database_url over <env-file> (its
# OWNER_DATABASE_URL, with a warning to move it, then DATABASE_URL, with the
# not-set warning). Both files are read as `<prefix> cat <file>`, so deploy.sh
# passes `sudo` and the root-run backup scripts pass nothing. A missing owner
# file counts as absent; one that exists but yields no OWNER_DATABASE_URL (no
# such line, or unreadable) counts as absent with a warning naming it.
#
# PRODUCTION ONLY: the owner file names production's database, and it wins
# over <env-file>. A caller after another database's owner URL (dev's parity
# side) uses owner_database_url on its own env file instead.
owner_database_url_for() {
  local env_file="$1" line text
  shift
  line=$("$@" cat "$OWNER_ENV_FILE" 2> /dev/null | grep -E '^OWNER_DATABASE_URL=.' | head -1 || true)
  if [ -n "$line" ]; then
    printf '%s\n' "${line#OWNER_DATABASE_URL=}"
    return 0
  fi
  if "$@" test -e "$OWNER_ENV_FILE" 2> /dev/null; then
    echo "WARNING: $OWNER_ENV_FILE exists but gave no OWNER_DATABASE_URL (missing, empty or unreadable) - falling back to $env_file." >&2
  fi
  text=$("$@" cat "$env_file") || return 1
  if printf '%s\n' "$text" | grep -qE '^OWNER_DATABASE_URL=.'; then
    echo "WARNING: OWNER_DATABASE_URL is read from $env_file, which the app process loads; move it to $OWNER_ENV_FILE (docs/runbooks/s07b-app-pool-login-roles.md step 5)." >&2
  fi
  printf '%s\n' "$text" | owner_database_url "$env_file"
}
