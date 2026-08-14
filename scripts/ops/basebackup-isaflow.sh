#!/bin/bash
# =============================================================================
# basebackup-isaflow.sh — weekly PHYSICAL base backup (pg_basebackup).
#
# This is the other half of PITR. The daily pg_dump is a logical backup: useful,
# portable, selectively restorable — and useless for point-in-time recovery,
# because WAL cannot be replayed onto a pg_restore'd database. PITR needs a
# physical base plus the WAL stream from wal-archive-isaflow.sh.
#
# Kept weekly rather than daily: at ~200MB physical per copy this is the right
# trade against 2.8T, and the WAL stream covers every point between bases.
# =============================================================================

set -euo pipefail

umask 077

BASE_DIR="${ISAFLOW_BASEBACKUP_DIR:-/srv/storage/backups/isaflow/base}"
PROD_ENV="${ISAFLOW_PROD_ENV:-/home/velo/isaflow/.env.local}"
RETENTION_DAYS=35            # > the 30d WAL retention, so the oldest WAL always has a base
TS=$(date -u +%Y%m%d_%H%M%SZ)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

on_error() {
  local rc=$?
  local lineno=$1
  local msg="IsaFlow base backup FAILED at line $lineno (exit $rc, host=$(hostname))."
  log "$msg"
  rm -rf "$BASE_DIR/$TS.tmp"
  {
    echo "$msg"
    echo ""
    echo "PITR requires a physical base backup plus the WAL stream. Without a"
    echo "recent base, the archived WAL cannot be replayed to a point in time."
    echo ""
    echo "--- last 40 journald lines for isaflow-basebackup.service ---"
    journalctl -u isaflow-basebackup.service -n 40 --no-pager 2>/dev/null || echo "(no journald entries)"
  } | "$SCRIPT_DIR/alert-email.py" "IsaFlow base backup FAILED ($TS)" || log "alert-email.py itself failed"
  exit "$rc"
}
trap 'on_error $LINENO' ERR

DATABASE_URL=$(grep -E "^DATABASE_URL=" "$PROD_ENV" | head -1 | cut -d= -f2-)
[[ -n "${DATABASE_URL:-}" ]] || { log "ERROR: DATABASE_URL not found"; false; }
REPL_URL=$(echo "$DATABASE_URL" | sed 's|@100\.96\.203\.105:|@127.0.0.1:|')

mkdir -p "$BASE_DIR"
rm -rf "$BASE_DIR/$TS.tmp"
mkdir -p "$BASE_DIR/$TS.tmp"

# -X none: WAL is NOT bundled into the base. The continuous stream already has
# it, and bundling would duplicate it. This makes the base UNUSABLE ALONE — it
# must be replayed with archived WAL, which is exactly the PITR contract.
log "Taking physical base backup..."
pg_basebackup \
  --dbname="$REPL_URL" \
  --pgdata="$BASE_DIR/$TS.tmp" \
  --format=tar --gzip --compress=6 \
  --wal-method=none \
  --checkpoint=fast \
  --progress --no-password 2>&1 | tail -2

# Record the WAL position the base starts from — without it you are guessing
# which archived segments the restore needs.
if [[ -f "$BASE_DIR/$TS.tmp/backup_manifest" ]]; then
  START_LSN=$(grep -oE '"Start-LSN": *"[^"]+"' "$BASE_DIR/$TS.tmp/backup_manifest" | head -1 | cut -d'"' -f4 || echo "unknown")
else
  START_LSN="unknown"
fi

mv "$BASE_DIR/$TS.tmp" "$BASE_DIR/$TS"
ln -sfn "$BASE_DIR/$TS" "$BASE_DIR/latest"

log "Pruning base backups older than ${RETENTION_DAYS}d..."
find "$BASE_DIR" -maxdepth 1 -type d -name '20*Z' -mtime "+$RETENTION_DAYS" -exec rm -rf {} + 2>/dev/null || true

SIZE=$(du -sh "$BASE_DIR/$TS" | cut -f1)
log "Base backup OK: $BASE_DIR/$TS ($SIZE, start LSN $START_LSN)"
