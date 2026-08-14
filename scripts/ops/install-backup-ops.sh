#!/bin/bash
# =============================================================================
# install-backup-ops.sh — install/refresh the IsaFlow backup + restore-drill
# ops tooling from this repo onto the host.
#
# WHY /opt/isaflow-ops AND NOT /home/velo/isaflow/scripts:
#   deploy.sh rsyncs the standalone build into /home/velo/isaflow with
#   `--delete`. Anything placed there is wiped by the next deploy — including,
#   silently, the backup job. /opt/isaflow-ops is outside every deploy target.
#
# The repo remains the source of truth (CLAUDE.md: deploy directories are
# targets, not workspaces). Re-run this after changing anything in scripts/ops.
#
# Idempotent. Safe to re-run.
# =============================================================================

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=/opt/isaflow-ops
UNIT_DIR=/etc/systemd/system

echo "Installing IsaFlow backup ops from $SRC → $DEST"

sudo mkdir -p "$DEST"
sudo install -m 0755 -o root -g root "$SRC/backup-isaflow.sh"        "$DEST/backup-isaflow.sh"
sudo install -m 0755 -o root -g root "$SRC/restore-drill-isaflow.sh" "$DEST/restore-drill-isaflow.sh"
sudo install -m 0755 -o root -g root "$SRC/alert-email.py"           "$DEST/alert-email.py"
sudo install -m 0644 -o root -g root "$SRC/lib-pgconn.sh"             "$DEST/lib-pgconn.sh"
sudo install -m 0755 -o root -g root "$SRC/wal-archive-isaflow.sh"   "$DEST/wal-archive-isaflow.sh"
sudo install -m 0755 -o root -g root "$SRC/basebackup-isaflow.sh"    "$DEST/basebackup-isaflow.sh"

# 0700: the backup directory holds full copies of every tenant's financial
# data. It must not be world-readable on a shared host.
sudo mkdir -p /srv/storage/backups/isaflow
sudo chmod 0700 /srv/storage/backups/isaflow
sudo chown root:root /srv/storage/backups/isaflow

for u in isaflow-backup.service isaflow-backup.timer \
         isaflow-restore-drill.service isaflow-restore-drill.timer \
         isaflow-basebackup.service isaflow-basebackup.timer \
         isaflow-wal-archive.service; do
  sudo install -m 0644 -o root -g root "$SRC/systemd/$u" "$UNIT_DIR/$u"
done

sudo systemctl daemon-reload
sudo systemctl enable --now isaflow-backup.timer isaflow-restore-drill.timer isaflow-basebackup.timer
# WAL archiving is a long-lived service, not a timer — it must be running
# continuously or PITR has gaps.
sudo systemctl enable --now isaflow-wal-archive.service

echo
echo "Installed. Timers:"
systemctl list-timers 'isaflow-backup*' 'isaflow-restore-drill*' 'isaflow-basebackup*' --no-pager
echo
echo "WAL archiving (continuous):"
systemctl is-active isaflow-wal-archive.service
echo
echo "Run once now:      sudo systemctl start isaflow-backup.service"
echo "Prove it restores: sudo systemctl start isaflow-restore-drill.service"
echo "Logs:              journalctl -u isaflow-backup.service -n 50 --no-pager"
