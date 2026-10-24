# shellcheck shell=bash
# Throwaway PostgreSQL 16 clusters for the integration gate (run.sh) and the
# baseline refresh (refresh-baseline.sh). Sourced, not run.
#
# Every cluster is a directory the caller made with mktemp. It is owned by the
# current user (gha-isaflow on the GitHub runner, you locally), listens on
# 127.0.0.1 only, on a port the OS just handed out, with no unix socket, and
# accepts only scram logins with the password in $PGPASSWORD. Its bootstrap
# superuser is `ci_superuser`, so that `postgres` can be created as production
# has it (pg_create_roles). A
# superuser that any local process could reach without a password could run
# COPY ... PROGRAM as the user who started it, so trust auth is not an option.
#
# Durability is off (fsync, full_page_writes, synchronous_commit): the data is
# thrown away when the run ends. Locale en_US.UTF-8 and timezone UTC are
# isaflow_dev's (Supabase) settings; initdb would otherwise take this
# machine's Africa/Johannesburg, and `'2026-11-11'::date::timestamptz` would
# land two hours before what dev and production store.

PG_BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
PG_SUPERUSER=ci_superuser
# shellcheck source=lifecycle.sh
source "$(dirname "${BASH_SOURCE[0]}")/lifecycle.sh"

# A port the kernel says is free right now. Another process can take it before
# postgres binds it, so pg_cluster_start retries on a fresh one.
free_port() {
  bun -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

# pg_cluster_init <dir>: initdb into <dir>/data; ci_superuser's password is $PGPASSWORD.
pg_cluster_init() {
  local dir=$1
  printf '%s\n' "$PGPASSWORD" > "$dir/pwfile"
  "$PG_BIN/initdb" -D "$dir/data" -U "$PG_SUPERUSER" --auth=scram-sha-256 --pwfile="$dir/pwfile" \
    -E UTF8 --locale=en_US.UTF-8 > "$dir/initdb.log" 2>&1 || { cat "$dir/initdb.log" >&2; return 1; }
  rm -f "$dir/pwfile"
}

# pg_cluster_start <dir>: start the cluster in <dir>/data and print its port.
pg_cluster_start() {
  local dir=$1 port try
  # A record from an earlier start of this directory would hide a new postmaster.
  rm -f "$dir/postmaster.start"
  for try in 1 2 3 4 5; do
    port=$(free_port) || return 1
    if "$PG_BIN/pg_ctl" -D "$dir/data" -l "$dir/server.log" -w -t 120 -o "-p $port \
        -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c max_connections=200 \
        -c timezone=UTC -c log_timezone=UTC \
        -c fsync=off -c full_page_writes=off -c synchronous_commit=off" start > /dev/null; then
      proc_start "$(head -n 1 "$dir/data/postmaster.pid")" > "$dir/postmaster.start"
      echo "$port"
      return 0
    fi
    echo "[integration] postgres could not start on port $port (attempt $try); retrying" >&2
    # A start that timed out can leave its postmaster still coming up and
    # holding the data directory: stop it before the next attempt reuses it.
    pg_cluster_stop "$dir"
  done
  tail -20 "$dir/server.log" >&2
  return 1
}

# pg_cluster_stop <dir>: stop the cluster at once. Safe to call on one that never
# started, and on a stale postmaster.pid: pg_ctl signals the pid in that file,
# so it runs only while that pid is a postmaster working in this data directory
# and, where recorded, the same process pg_cluster_start started.
pg_cluster_stop() {
  local dir=$1 pid
  [ -f "$dir/data/postmaster.pid" ] || return 0
  pid=$(head -n 1 "$dir/data/postmaster.pid")
  [ -n "$pid" ] && [ "$(readlink "/proc/$pid/cwd" 2> /dev/null)" = "$(cd "$dir/data" && pwd -P)" ] || return 0
  if [ -f "$dir/postmaster.start" ]; then same_proc "$pid" "$(cat "$dir/postmaster.start")" || return 0; fi
  "$PG_BIN/pg_ctl" -D "$dir/data" -m immediate stop > /dev/null 2>&1 || true
}

# pg_create_roles <port>: the roles the schema's grants, policies and owners
# name, with production's attributes: migration_admin and platform_admin bypass
# RLS (SECURITY DEFINER functions owned by migration_admin read through FORCE
# RLS on that basis); `postgres`, the role production's deploy connects and
# migrates as, is NOT a superuser, bypasses RLS and inherits migration_admin
# and app_user. Only `postgres` can log in, with $PGPASSWORD. It holds ADMIN
# OPTION on app_user because migration 915 grants app_user to the app's login
# roles: on PG 15 (production) CREATEROLE alone allows that, on PG 16 it needs
# ADMIN OPTION on the granted role. Supabase's `supabase_read_only_user`
# (LOGIN, BYPASSRLS, in pg_read_all_data) exists on production's cluster, and
# production's `postgres` is in pg_read_all_data too, so a migration that
# asserts who can read a table meets them here first (931 did not, #817). The
# role has no password, so nothing can log in as it.
pg_create_roles() {
  "$PG_BIN/psql" -h 127.0.0.1 -p "$1" -U "$PG_SUPERUSER" -X -q -v ON_ERROR_STOP=1 -d postgres <<'SQL'
\getenv pw PGPASSWORD
CREATE ROLE app_user NOLOGIN;
CREATE ROLE migration_admin NOLOGIN BYPASSRLS;
CREATE ROLE platform_admin NOLOGIN BYPASSRLS;
CREATE ROLE postgres NOSUPERUSER INHERIT CREATEDB CREATEROLE LOGIN BYPASSRLS PASSWORD :'pw';
GRANT migration_admin TO postgres;
GRANT app_user TO postgres WITH ADMIN OPTION;
CREATE ROLE supabase_read_only_user NOSUPERUSER INHERIT LOGIN BYPASSRLS IN ROLE pg_read_all_data;
GRANT pg_read_all_data TO postgres;
SQL
}

# suite_env <port> <database>: set SUITE_ENV to `env` arguments for the suites'
# fixed environment; with_db <port> <database> <command...> runs a command in it:
# the suites' fixed environment (env -i: a developer's .env.local or shell can never point it at
# a shared database or a real GoTrue), connected as `postgres`. No password in
# the URL: pg and psql read PGPASSWORD. RUNNER_TRACKING_ID is kept so the
# GitHub runner can still find and end what the step started. Temporary files
# go to $SUITE_TMP (run.sh: inside the run directory, so they go with it).
suite_env() {
  local url="postgresql://postgres@127.0.0.1:$1/$2"
  local keep=()
  [ -n "${RUNNER_TRACKING_ID:-}" ] && keep+=("RUNNER_TRACKING_ID=$RUNNER_TRACKING_ID")
  SUITE_ENV=(-i "PATH=$PATH" "HOME=$HOME" "TMPDIR=${SUITE_TMP:-${TMPDIR:-/tmp}}" "PGPASSWORD=$PGPASSWORD" NO_COLOR=1 "${keep[@]}"
    "DATABASE_URL=$url" "PLATFORM_ADMIN_DATABASE_URL=$url" "MIGRATION_ADMIN_DATABASE_URL=$url"
    DATABASE_SSL=disable GOTRUE_URL=http://127.0.0.1:1/auth/v1 ISAFLOW_DISPOSABLE_AUTH_TEST=1 CI_INTEGRATION_GATE=1
    "JWT_SECRET=$JWT")
}
with_db() {
  suite_env "$1" "$2"
  shift 2
  env "${SUITE_ENV[@]}" "$@"
}

# pg_require_extensions: fail, saying how to fix it, when the server lacks an
# extension the schema creates. pgvector is the one the stock package lacks.
pg_require_extensions() {
  local share ext
  share=$("$PG_BIN/pg_config" --sharedir) || return 1
  for ext in vector btree_gist pg_trgm pgcrypto; do
    if [ ! -f "$share/extension/$ext.control" ]; then
      echo "[integration] PostgreSQL 16 at $PG_BIN has no '$ext' extension ($share/extension/$ext.control)." >&2
      [ "$ext" = vector ] && echo "[integration] Install it: sudo apt install postgresql-16-pgvector" >&2
      return 1
    fi
  done
}
