# shellcheck shell=bash
# Throwaway PostgreSQL 16 clusters for the integration gate (run.sh) and the
# baseline refresh (refresh-baseline.sh). Sourced, not run.
#
# Every cluster is a directory the caller made with mktemp. It is owned by the
# current user (gha-isaflow on the GitHub runner, you locally), listens on
# 127.0.0.1 only, on a port the OS just handed out, with no unix socket, and
# accepts only scram logins as `postgres` with the password in $PGPASSWORD. A
# superuser that any local process could reach without a password could run
# COPY ... PROGRAM as the user who started it, so trust auth is not an option.
#
# Durability is off (fsync, full_page_writes, synchronous_commit): the data is
# thrown away when the run ends.

PG_BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}

# A port the kernel says is free right now. Another process can take it before
# postgres binds it, so pg_cluster_start retries on a fresh one.
free_port() {
  bun -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

# pg_cluster_init <dir>: initdb into <dir>/data with $PGPASSWORD as postgres's password.
pg_cluster_init() {
  local dir=$1
  printf '%s\n' "$PGPASSWORD" > "$dir/pwfile"
  "$PG_BIN/initdb" -D "$dir/data" -U postgres --auth=scram-sha-256 --pwfile="$dir/pwfile" \
    -E UTF8 --locale=C.UTF-8 > "$dir/initdb.log" 2>&1 || { cat "$dir/initdb.log" >&2; return 1; }
  rm -f "$dir/pwfile"
}

# pg_cluster_start <dir>: start the cluster in <dir>/data and print its port.
pg_cluster_start() {
  local dir=$1 port try
  for try in 1 2 3 4 5; do
    port=$(free_port) || return 1
    if "$PG_BIN/pg_ctl" -D "$dir/data" -l "$dir/server.log" -w -t 120 -o "-p $port \
        -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c max_connections=200 \
        -c fsync=off -c full_page_writes=off -c synchronous_commit=off" start > /dev/null; then
      echo "$port"
      return 0
    fi
    echo "[integration] postgres could not start on port $port (attempt $try); retrying" >&2
  done
  tail -20 "$dir/server.log" >&2
  return 1
}

# pg_cluster_stop <dir>: stop the cluster at once. Safe to call on one that never started.
pg_cluster_stop() {
  [ -f "$1/data/postmaster.pid" ] || return 0
  "$PG_BIN/pg_ctl" -D "$1/data" -m immediate stop > /dev/null 2>&1 || true
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
