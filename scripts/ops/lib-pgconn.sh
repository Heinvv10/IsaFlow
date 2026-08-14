#!/bin/bash
# =============================================================================
# lib-pgconn.sh — load the production connection WITHOUT putting the password
# on any command line.
#
# WHY THIS EXISTS: passing a connection URL that embeds the password as an
# argv to psql / pg_dump / pg_receivewal puts the production password in
# /proc/<pid>/cmdline, which is mode 0444 on this host — readable by every
# local account (velo, claude, louis, zander, gharunner, gha-*). For the
# short-lived tools that is a window; for isaflow-wal-archive.service, a
# Restart=always long-lived process, it is permanent. `ps aux` was enough.
#
# libpq reads PGPASSWORD from the environment instead, and /proc/<pid>/environ
# is 0400 root-only — so the secret stays with the process owner.
#
# Sets, for the caller:
#   PGPASSWORD      exported; consumed by libpq, never passed as an argument
#   PG_URL          the connection URL with the password REMOVED (safe in argv,
#                   logs and journald)
#   PG_URL_BASE     scheme://user@host:port  — for building sibling-db URLs
#   PG_URL_PARAMS   ?sslmode=... (empty when the URL had none)
#   PG_DB_NAME      the database name from the URL
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib-pgconn.sh"
#   load_pg_conn "/home/velo/isaflow/.env.local"
#   psql "$PG_URL" -c '...'
# =============================================================================

load_pg_conn() {
  local env_file="$1"
  local raw

  raw=$(grep -E "^DATABASE_URL=" "$env_file" | head -1 | cut -d= -f2-)
  if [[ -z "$raw" ]]; then
    echo "load_pg_conn: DATABASE_URL not found in $env_file" >&2
    return 2
  fi

  local scheme rest creds hostpath userinfo host_and_path
  scheme="${raw%%://*}"
  rest="${raw#*://}"

  # Split credentials from host on the LAST '@' — a password may itself contain
  # '@', and splitting on the first would truncate the host.
  if [[ "$rest" == *"@"* ]]; then
    userinfo="${rest%@*}"
    host_and_path="${rest##*@}"
  else
    userinfo=""
    host_and_path="$rest"
  fi

  local user pass
  if [[ "$userinfo" == *":"* ]]; then
    user="${userinfo%%:*}"
    pass="${userinfo#*:}"
  else
    user="$userinfo"
    pass=""
  fi

  # Percent-decode the password — libpq decodes it out of a URL, so a literal
  # PGPASSWORD must be the decoded form or authentication silently fails for
  # any password containing an encoded character.
  if [[ "$pass" == *%* ]]; then
    pass=$(printf '%b' "${pass//%/\\x}")
  fi

  hostpath="${host_and_path%%\?*}"
  PG_URL_PARAMS=""
  [[ "$host_and_path" == *\?* ]] && PG_URL_PARAMS="?${host_and_path#*\?}"

  PG_DB_NAME="${hostpath##*/}"
  local hostport="${hostpath%/*}"

  export PGPASSWORD="$pass"
  PG_URL="${scheme}://${user}@${hostpath}${PG_URL_PARAMS}"
  PG_URL_BASE="${scheme}://${user}@${hostport}"
  export PG_URL PG_URL_BASE PG_URL_PARAMS PG_DB_NAME
}

# This file is sourced, never executed.
