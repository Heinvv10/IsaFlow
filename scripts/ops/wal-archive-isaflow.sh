#!/bin/bash
# =============================================================================
# wal-archive-isaflow.sh — continuous WAL streaming for point-in-time recovery.
#
# Runs under systemd as a long-lived process (isaflow-wal-archive.service,
# Restart=always). Streams WAL from the production database into
# /srv/storage/backups/isaflow/wal via a physical replication slot.
#
# PITR = physical base backup (basebackup-isaflow.sh) + this WAL stream.
# The daily pg_dump is a separate, logical backup: you CANNOT replay WAL onto a
# pg_restore'd database, so the dump alone can never provide PITR.
#
# WHY A SLOT IS SAFE HERE: a replication slot normally risks filling the
# server's disk if the receiver stops, because the server retains WAL the slot
# has not consumed. This server already has max_slot_wal_keep_size = 4GB, so
# Postgres invalidates the slot instead of running out of disk. Production
# cannot be taken down by this process stalling — but an invalidated slot means
# a PITR GAP, which is why backup-isaflow.sh asserts slot health daily.
#
# The connection goes to 127.0.0.1 (the published port), which the container
# sees as the bridge gateway 172.28.0.1 — the address the pg_hba rule added on
# 2026-08-14 permits.
# =============================================================================

set -euo pipefail

WAL_DIR="${ISAFLOW_WAL_DIR:-/srv/storage/backups/isaflow/wal}"
PROD_ENV="${ISAFLOW_PROD_ENV:-/home/velo/isaflow/.env.local}"
SLOT="${ISAFLOW_WAL_SLOT:-isaflow_wal_archive}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-pgconn.sh
source "$SCRIPT_DIR/lib-pgconn.sh"

umask 077

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

# PGPASSWORD via env, never argv: this is a Restart=always long-lived process,
# so a password in its command line sits permanently in a world-readable
# /proc/<pid>/cmdline. See lib-pgconn.sh.
load_pg_conn "$PROD_ENV" || exit 2

# Replication is permitted from the bridge gateway only, which is what a
# connection to 127.0.0.1 on the published port presents as. The tailnet
# address (100.96.203.105) is deliberately NOT permitted.
REPL_URL=$(echo "$PG_URL" | sed 's|@100\.96\.203\.105:|@127.0.0.1:|')

mkdir -p "$WAL_DIR"

log "Ensuring replication slot '$SLOT' exists..."
pg_receivewal --dbname="$REPL_URL" --slot="$SLOT" --create-slot --if-not-exists 2>&1 | sed 's/^/  /' || true

log "Streaming WAL into $WAL_DIR (slot=$SLOT)..."
# --synchronous is deliberately omitted: this is an archive, not a synchronous
# standby, and enabling it would make client commits wait on this process.
exec pg_receivewal \
  --dbname="$REPL_URL" \
  --directory="$WAL_DIR" \
  --slot="$SLOT" \
  --compress=5 \
  --verbose
