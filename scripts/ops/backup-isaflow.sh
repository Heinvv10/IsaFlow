#!/bin/bash
# =============================================================================
# backup-isaflow.sh — daily Postgres backup for the IsaFlow production DB.
#
# Context: this server has ONE environment. There is no staging and there was
# no IsaFlow backup of any kind before this script — seven isaflow-* systemd
# timers were running and none of them was a backup, while the only dumps on
# the box belonged to QFieldCloud and Signum. Brightsphere and Velocity Fibre
# carry live ledgers.
#
# Lands on /srv/storage (a separate physical disk, 2.8T free). NOT on / , which
# sits at 82%.
#
# Custom format (-Fc), not plain SQL, so the restore drill can use
# `pg_restore --no-owner --no-acl` into a scratch database: the app role is not
# a superuser here, so a plain-SQL restore would choke on ownership statements
# and the drill would fail for a reason that has nothing to do with the backup.
#
# Writes a manifest of row counts alongside each dump. The drill compares the
# restored database against THAT, not against live — live moves between the
# dump and the drill, so comparing to live can only ever be approximate.
# =============================================================================

set -euo pipefail

# 077: these files are complete copies of every tenant's financial records.
# The directory is 0700, but the files should not depend on that alone —
# pg_dump would otherwise create them 0644 under the default umask.
umask 077

BACKUP_DIR="${ISAFLOW_BACKUP_DIR:-/srv/storage/backups/isaflow}"
PROD_ENV="${ISAFLOW_PROD_ENV:-/home/velo/isaflow/.env.local}"
DAILY_RETENTION_DAYS=30
MONTHLY_RETENTION_DAYS=400          # ~13 months of 1st-of-month dumps
TS=$(date -u +%Y%m%d_%H%M%SZ)
DAY_OF_MONTH=$(date -u +%d)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Tables whose row counts are recorded and later re-asserted by the drill.
# Ledger tables first — a backup that restores but loses journal lines is not
# a backup of an accounting system.
MANIFEST_TABLES=(
  gl_journal_entries gl_journal_lines gl_accounts
  companies customer_invoices supplier_invoices bank_transactions
)

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

on_error() {
  local rc=$?
  local lineno=$1
  local msg="IsaFlow backup FAILED at line $lineno (exit $rc, host=$(hostname))."
  log "$msg"
  {
    echo "$msg"
    echo ""
    echo "The IsaFlow production database was NOT backed up in this run."
    echo "There is no staging environment and no PITR — investigate now."
    echo ""
    echo "--- last 40 journald lines for isaflow-backup.service ---"
    journalctl -u isaflow-backup.service -n 40 --no-pager 2>/dev/null || echo "(no journald entries)"
  } | "$SCRIPT_DIR/alert-email.py" "IsaFlow backup FAILED ($TS)" || log "alert-email.py itself failed"
  exit "$rc"
}
trap 'on_error $LINENO' ERR

# DATABASE_URL lives in the prod env file (velo:velo 0600). `set -a; source` is
# deliberately NOT used: that file holds multi-line and unquoted values that
# break a naive source. Pull the one key we need.
DATABASE_URL=$(grep -E "^DATABASE_URL=" "$PROD_ENV" | head -1 | cut -d= -f2-)
if [[ -z "${DATABASE_URL:-}" ]]; then
  log "ERROR: DATABASE_URL not found in $PROD_ENV"
  false
fi

# Guard against ever dumping the DEV database into the prod backup directory —
# they differ only by db NAME on the same host:port, which has bitten this
# project before (the admin console ran on isaflow_dev for 3.5 months).
DB_NAME=$(psql "$DATABASE_URL" -tAc "SELECT current_database()")
if [[ "$DB_NAME" != "isaflow" ]]; then
  log "ERROR: refusing to run — expected database 'isaflow', got '$DB_NAME'"
  false
fi

mkdir -p "$BACKUP_DIR"

DUMP="$BACKUP_DIR/isaflow-$TS.dump"
MANIFEST="$BACKUP_DIR/isaflow-$TS.manifest.json"

log "Dumping $DB_NAME (custom format)..."
pg_dump --format=custom --compress=9 --file="$DUMP.tmp" "$DATABASE_URL"

# Verify the archive is READABLE before it is allowed to become "the backup".
# A truncated dump is silent until the day you need it; pg_restore --list walks
# the whole table of contents and fails on a corrupt archive.
log "Verifying archive integrity..."
TOC_ENTRIES=$(pg_restore --list "$DUMP.tmp" | grep -c ';' || true)
if [[ "$TOC_ENTRIES" -lt 100 ]]; then
  log "ERROR: archive table-of-contents has only $TOC_ENTRIES entries — refusing to publish"
  rm -f "$DUMP.tmp"
  false
fi

mv "$DUMP.tmp" "$DUMP"

log "Writing row-count manifest..."
{
  echo "{"
  echo "  \"timestamp\": \"$TS\","
  echo "  \"database\": \"$DB_NAME\","
  echo "  \"toc_entries\": $TOC_ENTRIES,"
  echo "  \"tables\": {"
  first=1
  for t in "${MANIFEST_TABLES[@]}"; do
    c=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM $t" 2>/dev/null || echo -1)
    [[ $first -eq 1 ]] && first=0 || echo ","
    printf '    "%s": %s' "$t" "$c"
  done
  echo ""
  echo "  }"
  echo "}"
} > "$MANIFEST.tmp"
mv "$MANIFEST.tmp" "$MANIFEST"

ln -sfn "$DUMP"     "$BACKUP_DIR/latest.dump"
ln -sfn "$MANIFEST" "$BACKUP_DIR/latest.manifest.json"

# Keep the 1st-of-month dump for ~13 months; everything else for 30 days.
if [[ "$DAY_OF_MONTH" == "01" ]]; then
  cp -f "$DUMP" "$BACKUP_DIR/monthly-$TS.dump"
  log "Retained monthly copy for $TS"
fi

log "Pruning: dailies older than ${DAILY_RETENTION_DAYS}d, monthlies older than ${MONTHLY_RETENTION_DAYS}d..."
find "$BACKUP_DIR" -maxdepth 1 -name 'isaflow-*.dump'          -mtime "+$DAILY_RETENTION_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'isaflow-*.manifest.json' -mtime "+$DAILY_RETENTION_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'monthly-*.dump'          -mtime "+$MONTHLY_RETENTION_DAYS" -delete

SIZE=$(stat -c %s "$DUMP")
JE=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM gl_journal_entries")
log "Backup OK: $DUMP (${SIZE} bytes, $TOC_ENTRIES toc entries, $JE journal entries)"

# ── PITR health ─────────────────────────────────────────────────────────────
# The WAL stream is the half of PITR that can fail QUIETLY. The pg_hba rule it
# depends on lives in the container's writable layer, so `docker compose up
# --force-recreate` reverts it and pg_receivewal simply stops reconnecting.
# Checked here because this job already has a working alert path.
WAL_DIR="${ISAFLOW_WAL_DIR:-$BACKUP_DIR/wal}"
SLOT="${ISAFLOW_WAL_SLOT:-isaflow_wal_archive}"
PITR_PROBLEMS=""

# Read the two fields separately. An earlier version concatenated them and
# pattern-matched `*/t`, but active::text renders 'true' in Postgres, not 't' —
# so the check reported INACTIVE on a perfectly healthy slot every night. A
# monitor that cries wolf nightly is worse than no monitor, because the real
# alert gets ignored with the rest.
SLOT_ACTIVE=$(psql "$DATABASE_URL" -tAc \
  "SELECT active FROM pg_replication_slots WHERE slot_name = '$SLOT'" 2>/dev/null | tr -d '[:space:]')
SLOT_WAL_STATUS=$(psql "$DATABASE_URL" -tAc \
  "SELECT coalesce(wal_status,'unknown') FROM pg_replication_slots WHERE slot_name = '$SLOT'" 2>/dev/null | tr -d '[:space:]')

if [[ -z "$SLOT_ACTIVE" ]]; then
  PITR_PROBLEMS+="- replication slot '$SLOT' does not exist — WAL archiving is NOT running.\n"
elif [[ "$SLOT_WAL_STATUS" == "lost" ]]; then
  # The 4GB cap invalidated it: production was protected, PITR was not.
  PITR_PROBLEMS+="- replication slot '$SLOT' is LOST (exceeded max_slot_wal_keep_size). There is a PITR GAP; take a fresh base backup.\n"
elif [[ "$SLOT_ACTIVE" != "t" && "$SLOT_ACTIVE" != "true" ]]; then
  PITR_PROBLEMS+="- replication slot '$SLOT' is INACTIVE (active=$SLOT_ACTIVE) — isaflow-wal-archive.service is not streaming.\n"
fi

if [[ -d "$WAL_DIR" ]]; then
  NEWEST=$(find "$WAL_DIR" -type f -newermt '-2 hours' 2>/dev/null | head -1)
  [[ -z "$NEWEST" ]] && PITR_PROBLEMS+="- no WAL segment written in the last 2h — the stream is stalled.\n"
else
  PITR_PROBLEMS+="- WAL directory $WAL_DIR is missing.\n"
fi

if [[ -n "$PITR_PROBLEMS" ]]; then
  log "PITR HEALTH DEGRADED:"
  printf '%b' "$PITR_PROBLEMS" | sed 's/^/  /'
  {
    echo "The nightly dump succeeded, but point-in-time recovery is degraded:"
    echo ""
    printf '%b' "$PITR_PROBLEMS"
    echo ""
    echo "Most likely cause: the isaflow-supabase-db container was recreated,"
    echo "reverting the pg_hba replication rule (it is in the container's"
    echo "writable layer, not a bind mount). Re-add it and restart"
    echo "isaflow-wal-archive.service — see scripts/ops/README.md."
    echo ""
    echo "Daily dumps are unaffected; only PITR is."
  } | "$SCRIPT_DIR/alert-email.py" "IsaFlow PITR degraded (dumps still OK)" \
    || log "alert-email.py failed while reporting PITR degradation"
else
  log "PITR health OK (slot $SLOT active, WAL fresh)"
fi
