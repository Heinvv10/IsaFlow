# shellcheck shell=bash
# owner_database_url <label> < env-file
#
# Prints the URL the deploy must use for work that needs the schema owner:
# applying migrations, the schema-drift audit, the migration-parity gate and
# verify-deploy's integrity check. That is OWNER_DATABASE_URL. S-07b
# (migration 910) moves the app's DATABASE_URL to isaflow_app, which owns
# nothing and cannot apply a migration.
#
# Until the env file names OWNER_DATABASE_URL it falls back to DATABASE_URL,
# with a warning on stderr, so a deploy made before the env change still runs.
# Prints nothing (and returns 1) when the file names neither.
#
# The env file comes on stdin so the caller can read a root-only file with
# `sudo cat`; <label> names it in the warning.
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
