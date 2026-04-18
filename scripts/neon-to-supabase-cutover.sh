#!/usr/bin/env bash
# ============================================================
# Production Cutover: Neon -> Supabase (self-hosted on Velocity)
# Target: IsaFlow
# ============================================================
# One-off script. Run on velo-server, after hours, with Hein's approval.
# Produces its own logs under /home/velo/backups/cutover-isaflow/<ts>/.
#
# Usage:
#   ./neon-to-supabase-cutover.sh              # full cutover (stops service)
#   ./neon-to-supabase-cutover.sh --dry-run    # dump + restore + diff only,
#                                              # does NOT stop prod or swap env
#
# Rollback (after a real run):
#   sudo cp /home/velo/isaflow/.env.pre-cutover.<ts> /home/velo/isaflow/.env.local
#   sudo systemctl restart isaflow.service
#
# PREREQ — the app code must already be on the pg.Pool-backed neon.ts.
# Running this while the serverless-driver build is live will break /api/health
# because `neon()` cannot speak to Supabase/Supavisor.
# ============================================================
set -euo pipefail
trap 'echo "[FAILED] line $LINENO -- see logs in ${LOGDIR:-/tmp}"; exit 1' ERR

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  echo "[dry-run] no service stop, no env swap"
fi

TS=$(date +%Y-%m-%d-%H%M%S)
LOGDIR="/home/velo/backups/cutover-isaflow/${TS}"
mkdir -p "$LOGDIR"

# ---------- configuration ----------
NEON_HOST="ep-dry-surf-al35kgz6.c-3.eu-central-1.aws.neon.tech"   # direct, not -pooler
NEON_USER="neondb_owner"
NEON_DB="neondb"
NEON_PASS="npg_TDuKN9ao1sZB"

SUPABASE_HOST="localhost"
SUPABASE_PORT="5437"            # current direct port of supabase-db container
SUPABASE_SUPERUSER="postgres"
SUPABASE_SUPERPASS="a23f6104debd1d3e88e8f00c0067f22f"
SUPABASE_DB="isaflow"

APP_DEPLOY_DIR="/home/velo/isaflow"
APP_SERVICE="isaflow.service"
APP_HEALTH_URL="http://localhost:3101/api/health"

# App-runtime connection. Prefer Supavisor transaction pooler (:6543) so the
# 335 API routes share a warm connection pool. Swap to 5437 for direct TCP if
# the pooler is ever down.
NEW_DATABASE_URL="postgresql://${SUPABASE_SUPERUSER}:${SUPABASE_SUPERPASS}@${SUPABASE_HOST}:6543/${SUPABASE_DB}?sslmode=disable"

# Tables used for row-count verification. If any of these drift, abort.
PROBE_TABLES=(
  companies
  users
  gl_journal_entries
  gl_journal_lines
  bank_transactions
  customer_invoices
  supplier_invoices
  gl_accounts
  bank_accounts
  audit_log
  schema_migrations
)

log() { echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOGDIR/cutover.log"; }

psql_supa() {
  PGPASSWORD="$SUPABASE_SUPERPASS" psql \
    -h "$SUPABASE_HOST" -p "$SUPABASE_PORT" \
    -U "$SUPABASE_SUPERUSER" -d "$SUPABASE_DB" "$@"
}

psql_neon() {
  PGPASSWORD="$NEON_PASS" psql \
    -h "$NEON_HOST" \
    -U "$NEON_USER" -d "$NEON_DB" "$@"
}

# ---------- Step 0: pre-flight ----------
log "Step 0: pre-flight checks"
# Use `systemctl cat` — returns 0 if unit is installed, non-zero otherwise.
# Avoids quirks of `list-unit-files --type=service` under `set -e` pipelines.
systemctl cat "$APP_SERVICE" >/dev/null 2>&1 \
  || { log "FAIL: ${APP_SERVICE} not installed"; exit 1; }
psql_supa -c 'SELECT 1' >/dev/null
psql_neon -c 'SELECT 1' >/dev/null
log "  OK: service exists, both DBs reachable"

# ---------- Step 1: safety dump of current Supabase isaflow ----------
log "Step 1: safety dump of current Supabase isaflow (rollback point)"
PGPASSWORD="$SUPABASE_SUPERPASS" pg_dump \
  -h "$SUPABASE_HOST" -p "$SUPABASE_PORT" \
  -U "$SUPABASE_SUPERUSER" -d "$SUPABASE_DB" \
  --no-owner --no-acl --schema=public \
  -f "$LOGDIR/supabase-pre-cutover.sql" 2>>"$LOGDIR/cutover.log"
log "  OK: $(du -h "$LOGDIR/supabase-pre-cutover.sql" | cut -f1)"

# ---------- Step 2: stop prod BEFORE dumping Neon (consistent snapshot) ----------
if [[ "$DRY_RUN" -eq 0 ]]; then
  log "Step 2: stopping ${APP_SERVICE}"
  sudo systemctl stop "$APP_SERVICE"
  log "  OK: service stopped. maintenance page serving."
else
  log "Step 2: [dry-run] skipping service stop"
fi

# ---------- Step 3: fresh Neon dump ----------
log "Step 3: fresh Neon prod dump"
PGPASSWORD="$NEON_PASS" pg_dump \
  -h "$NEON_HOST" \
  -U "$NEON_USER" -d "$NEON_DB" \
  --no-owner --no-acl --schema=public \
  -f "$LOGDIR/neon-final.sql" 2>>"$LOGDIR/cutover.log"
log "  OK: $(du -h "$LOGDIR/neon-final.sql" | cut -f1)"

# ---------- Step 4: wipe Supabase public schema ----------
log "Step 4: wiping Supabase isaflow public schema"
psql_supa -t -A -c \
  "SELECT 'DROP TABLE IF EXISTS public.'||quote_ident(tablename)||' CASCADE;'
   FROM pg_tables WHERE schemaname='public'" \
  > "$LOGDIR/drops.sql"
psql_supa -f "$LOGDIR/drops.sql" > "$LOGDIR/drop-exec.log" 2>&1 || true
psql_supa -t -A -c \
  "SELECT 'DROP SEQUENCE IF EXISTS public.'||quote_ident(sequence_name)||' CASCADE;'
     FROM information_schema.sequences WHERE sequence_schema='public'
   UNION ALL
   SELECT 'DROP VIEW IF EXISTS public.'||quote_ident(viewname)||' CASCADE;'
     FROM pg_views WHERE schemaname='public'
   UNION ALL
   SELECT 'DROP FUNCTION IF EXISTS public.'||quote_ident(p.proname)||'('||pg_get_function_identity_arguments(p.oid)||') CASCADE;'
     FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public'
   UNION ALL
   SELECT 'DROP TYPE IF EXISTS public.'||quote_ident(t.typname)||' CASCADE;'
     FROM pg_type t JOIN pg_namespace n ON t.typnamespace=n.oid
     WHERE n.nspname='public' AND t.typtype='e'" \
  > "$LOGDIR/drops-other.sql"
psql_supa -f "$LOGDIR/drops-other.sql" >> "$LOGDIR/drop-exec.log" 2>&1 || true
REMAINING=$(psql_supa -t -A -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
[[ "$REMAINING" -eq 0 ]] || { log "FAIL: $REMAINING tables remain"; exit 1; }
log "  OK: schema empty"

# ---------- Step 5: restore Neon dump into Supabase ----------
log "Step 5: restoring Neon dump into Supabase"
psql_supa -v ON_ERROR_STOP=0 -f "$LOGDIR/neon-final.sql" > "$LOGDIR/restore.log" 2>&1
ERR_COUNT=$(grep -c -iE '^ERROR' "$LOGDIR/restore.log" || true)
log "  restore errors: $ERR_COUNT"
[[ "$ERR_COUNT" -lt 20 ]] || { log "FAIL: too many restore errors — see $LOGDIR/restore.log"; exit 1; }

# ---------- Step 6: row-count verification ----------
log "Step 6: row-count diff (Neon vs Supabase)"
{
  printf '| %-30s | %10s | %10s | %6s |\n' Table Neon Supabase Diff
  printf '|--------------------------------|------------|------------|--------|\n'
  MISMATCH=0
  for t in "${PROBE_TABLES[@]}"; do
    N=$(psql_neon -t -A -c "SELECT count(*) FROM public.\"$t\"" 2>/dev/null || echo ERR)
    S=$(psql_supa -t -A -c "SELECT count(*) FROM public.\"$t\"" 2>/dev/null || echo ERR)
    if [[ "$N" =~ ^[0-9]+$ && "$S" =~ ^[0-9]+$ ]]; then
      D=$((N - S))
      printf '| %-30s | %10s | %10s | %6s |\n' "$t" "$N" "$S" "$D"
      [[ "$D" -ne 0 ]] && MISMATCH=$((MISMATCH + 1))
    else
      printf '| %-30s | %10s | %10s | %6s |\n' "$t" "$N" "$S" "ERR"
      MISMATCH=$((MISMATCH + 1))
    fi
  done
} | tee "$LOGDIR/rowcount.md"
if [[ "$MISMATCH" -gt 0 ]]; then
  log "WARN: $MISMATCH probe tables differ. Review $LOGDIR/rowcount.md before proceeding."
  if [[ "$DRY_RUN" -eq 0 ]]; then
    log "Aborting cutover. Service still stopped — restart with: sudo systemctl start ${APP_SERVICE}"
    exit 1
  fi
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "DRY-RUN COMPLETE. Logs in $LOGDIR"
  log "No env swap, no service restart."
  exit 0
fi

# ---------- Step 7: swap .env.local DATABASE_URL ----------
log "Step 7: swapping DATABASE_URL in ${APP_DEPLOY_DIR}/.env.local"
sudo cp "$APP_DEPLOY_DIR/.env.local" "$APP_DEPLOY_DIR/.env.pre-cutover.${TS}"
sudo sed -i "s|^DATABASE_URL=.*$|DATABASE_URL=${NEW_DATABASE_URL}|" \
  "$APP_DEPLOY_DIR/.env.local"
log "  OK: old saved to .env.pre-cutover.${TS}"

# ---------- Step 8: restart prod service ----------
log "Step 8: starting ${APP_SERVICE}"
sudo systemctl start "$APP_SERVICE"
sleep 10
if curl -fsS "$APP_HEALTH_URL" >/dev/null; then
  log "  OK: /api/health = 200"
else
  log "FAIL: /api/health not responding — check: journalctl -u ${APP_SERVICE} -n 100"
  exit 1
fi

log "CUTOVER COMPLETE. Logs in $LOGDIR"
log "Rollback: sudo cp ${APP_DEPLOY_DIR}/.env.pre-cutover.${TS} ${APP_DEPLOY_DIR}/.env.local"
log "          sudo systemctl restart ${APP_SERVICE}"
