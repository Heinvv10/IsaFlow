#!/bin/bash
# Deploy Accounting App to Velocity Server
set -e

DEPLOY_DIR="/home/velo/accounting"
REPO_DIR="/home/hein/Workspace/Accounting"

echo "=== Deploying Accounting App ==="

# 1. Sync files to deploy directory
echo "Syncing files..."
sudo -u velo bash -c "
  mkdir -p $DEPLOY_DIR
  rsync -a --delete \
    --exclude=node_modules \
    --exclude=.next \
    --exclude=.git \
    --exclude=.env.local \
    $REPO_DIR/ $DEPLOY_DIR/
"

# 2. Copy env file if not exists
if [ ! -f "$DEPLOY_DIR/.env.local" ]; then
  echo "Creating .env.local..."
  sudo -u velo bash -c "cp $REPO_DIR/.env.local $DEPLOY_DIR/.env.local"
fi

# 3. Install deps and build
echo "Installing dependencies..."
sudo -u velo bash -c "cd $DEPLOY_DIR && npm install --production"

echo "Building..."
sudo -u velo bash -c "cd $DEPLOY_DIR && npm run build"

# 4. Install systemd service if not exists
if [ ! -f /etc/systemd/system/fibreflow-accounting.service ]; then
  echo "Installing systemd service..."
  sudo cp $REPO_DIR/scripts/fibreflow-accounting.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable fibreflow-accounting
fi

# 5. Restart service
echo "Restarting service..."
sudo systemctl restart fibreflow-accounting

# 6. Check status
sleep 2
sudo systemctl status fibreflow-accounting --no-pager | head -15

echo ""
echo "=== Deploy complete ==="
echo "URL: https://fin.fibreflow.app"
