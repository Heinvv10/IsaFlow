#!/bin/bash
# =============================================================================
# restore-drill-isaflow.sh — weekly proof that the backup actually restores.
#
# A backup nobody has restored is not a backup, it is a file. This restores the
# latest dump into a scratch database, asserts it against the manifest written
# at dump time, and — because this is an accounting system — asserts the
# RESTORED ledger still balances. Then drops the scratch database.
#
# Row counts are compared against the manifest, not against live: live moves
# between the dump and the drill, so a live comparison can only ever be fuzzy.
# The manifest makes it exact, which is what catches a partial restore.
# =============================================================================

set -euo pipefail

BACKUP_DIR="${ISAFLOW_BACKUP_DIR:-/srv/storage/backups/isaflow}"
PROD_ENV="${ISAFLOW_PROD_ENV:-/home/velo/isaflow/.env.local}"
TEST_DB="${ISAFLOW_RESTORE_TEST_DB:-isaflow_restore_test}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

DATABASE_URL=$(grep -E "^DATABASE_URL=" "$PROD_ENV" | head -1 | cut -d= -f2-)
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL not found in $PROD_ENV" >&2
  exit 2
fi

# Build maintenance + scratch URLs from the app URL. Strip any ?params first,
# then swap the database name.
APP_URL="${DATABASE_URL%%\?*}"
URL_PARAMS=""
[[ "$DATABASE_URL" == *\?* ]] && URL_PARAMS="?${DATABASE_URL#*\?}"
URL_BASE="${APP_URL%/*}"
MAINT_URL="$URL_BASE/postgres$URL_PARAMS"
TEST_URL="$URL_BASE/$TEST_DB$URL_PARAMS"

# Refuse to run if the scratch name resolves to something real. Dropping the
# production database because of a config typo is the one failure this script
# must never have.
if [[ "$TEST_DB" == "isaflow" || "$TEST_DB" == "isaflow_dev" || "$TEST_DB" == "postgres" ]]; then
  echo "ERROR: refusing — scratch DB name '$TEST_DB' is a real database" >&2
  exit 2
fi

cleanup_testdb() {
  psql "$MAINT_URL" -c "DROP DATABASE IF EXISTS $TEST_DB" >/dev/null 2>&1 || true
}

on_error() {
  local rc=$?
  local lineno=$1
  local msg="IsaFlow restore drill FAILED at line $lineno (exit $rc, host=$(hostname))."
  log "$msg"
  cleanup_testdb
  {
    echo "$msg"
    echo ""
    echo "The IsaFlow backup could NOT be proven restorable. Treat the backups"
    echo "as unverified until this passes — there is no staging and no PITR."
    echo ""
    echo "--- last 40 journald lines for isaflow-restore-drill.service ---"
    journalctl -u isaflow-restore-drill.service -n 40 --no-pager 2>/dev/null || echo "(no journald entries)"
  } | "$SCRIPT_DIR/alert-email.py" "IsaFlow restore drill FAILED" || log "alert-email.py itself failed"
  exit "$rc"
}
trap 'on_error $LINENO' ERR

LATEST="$BACKUP_DIR/latest.dump"
MANIFEST="$BACKUP_DIR/latest.manifest.json"
[[ -e "$LATEST"   ]] || { log "ERROR: $LATEST missing";   false; }
[[ -e "$MANIFEST" ]] || { log "ERROR: $MANIFEST missing"; false; }

# Staleness gate: a drill that passes against a three-week-old dump is a green
# light on a broken backup job.
DUMP_AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$(readlink -f "$LATEST")") ) / 3600 ))
if [[ "$DUMP_AGE_H" -gt 48 ]]; then
  log "ERROR: latest dump is ${DUMP_AGE_H}h old (>48h) — the backup timer is not running"
  false
fi
log "Latest dump is ${DUMP_AGE_H}h old."

log "Recreating scratch database $TEST_DB..."
cleanup_testdb
psql "$MAINT_URL" -c "CREATE DATABASE $TEST_DB;" >/dev/null

# --no-owner/--no-acl: the app role is not a superuser, so re-creating grants
# and ownership would fail for reasons unrelated to backup integrity.
# --exit-on-error is deliberately OFF; we judge the restore by the assertions
# below, not by whether every extension comment replayed cleanly.
log "Restoring into $TEST_DB..."
pg_restore --no-owner --no-acl --dbname="$TEST_URL" "$LATEST" 2>&1 | tail -5 || true

log "Asserting row counts against the dump-time manifest..."
FAILED=0
while IFS= read -r line; do
  table=$(echo "$line" | cut -d'"' -f2)
  expected=$(echo "$line" | sed 's/.*: *//; s/,//')
  [[ -z "$table" || -z "$expected" ]] && continue
  actual=$(psql "$TEST_URL" -tAc "SELECT count(*) FROM $table" 2>/dev/null || echo "ERR")
  if [[ "$actual" != "$expected" ]]; then
    log "  [FAIL] $table: manifest=$expected restored=$actual"
    FAILED=1
  else
    log "  [ok]   $table: $actual"
  fi
# Match only `    "table_name": 123` lines. An earlier version grepped for any
# indented quote, which also matched the `"tables": {` header itself and
# reported a phantom table called "tables" as a failure — the drill failing on
# its own parser rather than on the backup.
done < <(sed -n '/"tables"/,/}/p' "$MANIFEST" | grep -E '^[[:space:]]+"[a-z_]+"[[:space:]]*:[[:space:]]*-?[0-9]+')

if [[ "$FAILED" -ne 0 ]]; then
  log "ERROR: restored row counts do not match the manifest"
  false
fi

# The assertion that actually matters for an accounting system: the restored
# ledger still balances. A restore that loses journal LINES would keep entry
# counts intact and silently unbalance every company.
log "Asserting the restored ledger balances (posted entries, per company)..."
IMBALANCED=$(psql "$TEST_URL" -tAc "
  SELECT count(*) FROM (
    SELECT je.company_id
    FROM gl_journal_entries je
    JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
    WHERE je.status = 'posted'
    GROUP BY je.company_id
    HAVING ROUND(SUM(jl.debit)::numeric, 2) <> ROUND(SUM(jl.credit)::numeric, 2)
  ) x")
if [[ "$IMBALANCED" != "0" ]]; then
  log "ERROR: $IMBALANCED companies have an unbalanced trial balance in the RESTORED database"
  false
fi
log "  [ok]   0 companies imbalanced in the restored ledger"

log "Dropping scratch database..."
cleanup_testdb

log "Restore drill PASSED (dump age ${DUMP_AGE_H}h)"
