#!/bin/bash
# Roll the deployed IsaFlow standalone back to the pre-deploy snapshot taken
# by scripts/deploy.sh (A–Z programme P3.1).
#
# Restores CODE only: DB migrations are NOT reverted — they are additive
# (IF NOT EXISTS) by project rule, so the previous build runs against the
# migrated schema. If a migration itself is the problem, that is a
# HUMAN-GATED incident, not something this script decides.
#
# Env overrides (defaults = production; override for drills):
#   DEPLOY_DIR   (/home/velo/isaflow)
#   BACKUP_DIR   (/home/velo/isaflow-rollback)
#   SERVICE_NAME (isaflow)
#   HEALTH_URL   (https://app.isaflow.co.za/api/health)
#   ROLLBACK_NO_SUDO=1     plain rsync/cp for drill dirs owned by the caller
#   ROLLBACK_SKIP_SERVICE=1  skip systemctl restart + health check (drills)
set -e

DEPLOY_DIR="${DEPLOY_DIR:-/home/velo/isaflow}"
BACKUP_DIR="${BACKUP_DIR:-/home/velo/isaflow-rollback}"
SERVICE_NAME="${SERVICE_NAME:-isaflow}"
HEALTH_URL="${HEALTH_URL:-https://app.isaflow.co.za/api/health}"

SUDO="sudo"
[ "${ROLLBACK_NO_SUDO:-0}" = "1" ] && SUDO=""

echo "=== Rolling back $DEPLOY_DIR from $BACKUP_DIR ==="

if ! $SUDO test -f "$BACKUP_DIR/server.js"; then
  echo "ERROR: $BACKUP_DIR has no server.js — no pre-deploy snapshot to restore."
  echo "Manual recovery: git checkout <previous SHA> && bash scripts/deploy.sh"
  exit 1
fi

PREV_SHA="$($SUDO cat "$BACKUP_DIR/RELEASE_SHA" 2>/dev/null || echo 'unknown')"
echo "Restoring snapshot of release: $PREV_SHA"

# Same env-file exclusions as deploy.sh: rollback must never touch secrets.
# --checksum: the default size+mtime quick-check can silently SKIP a file
# whose broken and good versions match on both (proven in the P3.1 drill with
# same-second same-size files). A rollback must be byte-exact; the extra
# read time on a local disk is an acceptable price on the emergency path.
$SUDO rsync -a --checksum --delete \
  --exclude=.env.local \
  --exclude='.env.*.bak' \
  --exclude='.env.pre-*' \
  --exclude='.env.backup-*' \
  "$BACKUP_DIR/" "$DEPLOY_DIR/"
if [ -z "$SUDO" ]; then
  true # drill dirs keep caller ownership
else
  $SUDO chown -R velo:velo "$DEPLOY_DIR"
fi

if [ "${ROLLBACK_SKIP_SERVICE:-0}" = "1" ]; then
  echo "Service restart SKIPPED (ROLLBACK_SKIP_SERVICE=1 — drill mode)"
else
  echo "Restarting $SERVICE_NAME..."
  $SUDO systemctl restart "$SERVICE_NAME"
  HEALTHY=0
  for _ in $(seq 1 30); do
    if curl -sf --max-time 5 "$HEALTH_URL" >/dev/null; then HEALTHY=1; break; fi
    sleep 2
  done
  if [ "$HEALTHY" != "1" ]; then
    echo "ERROR: service unhealthy AFTER rollback ($HEALTH_URL) — manual intervention required:"
    echo "  sudo journalctl -u $SERVICE_NAME -n 100 --no-pager"
    exit 1
  fi
  echo "OK: service healthy on restored release $PREV_SHA"
fi

echo "=== Rollback complete (code restored to $PREV_SHA; migrations NOT reverted) ==="
