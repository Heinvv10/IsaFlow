#!/bin/bash
# Deploy IsaFlow App to Velocity Server (standalone build)
set -e

DEPLOY_DIR="/home/velo/isaflow"
REPO_DIR="/home/hein/Workspace/IsaFlow"
SERVICE_NAME="isaflow"
BUN="/home/hein/.bun/bin/bun"

echo "=== Deploying IsaFlow ==="

# 1. Build locally with bun
echo "Installing dependencies..."
cd "$REPO_DIR"
$BUN install

echo "Building production bundle..."
NODE_ENV=production $BUN run build

# 2. Deploy standalone output (includes all deps, no npm install needed)
echo "Syncing standalone build..."
sudo -u velo bash -c "mkdir -p $DEPLOY_DIR"

# Standalone server + bundled node_modules
sudo rsync -a --delete \
  --exclude=.env.local \
  "$REPO_DIR/.next/standalone/" "$DEPLOY_DIR/"

# Static assets (not included in standalone by default)
sudo rsync -a --delete \
  "$REPO_DIR/.next/static/" "$DEPLOY_DIR/.next/static/"

# Public folder (logo, icons, manifest, sw.js)
sudo rsync -a --delete \
  "$REPO_DIR/public/" "$DEPLOY_DIR/public/"

# Fix ownership
sudo chown -R velo:velo "$DEPLOY_DIR"

# 3. Copy env file if not exists
if [ ! -f "$DEPLOY_DIR/.env.local" ]; then
  echo "Creating .env.local..."
  sudo -u velo cp "$REPO_DIR/.env.local" "$DEPLOY_DIR/.env.local"
fi

# 4. Install/update systemd service
echo "Updating systemd service..."
sudo cp "$REPO_DIR/scripts/${SERVICE_NAME}.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable $SERVICE_NAME

# 5. Install nginx config if not exists
if [ ! -f /etc/nginx/sites-available/app-isaflow ]; then
  echo "Installing nginx config..."
  sudo cp "$REPO_DIR/scripts/nginx-app-isaflow" /etc/nginx/sites-available/app-isaflow
  sudo ln -sf /etc/nginx/sites-available/app-isaflow /etc/nginx/sites-enabled/app-isaflow
  sudo nginx -t && sudo systemctl reload nginx
fi

# 6. Restart service
echo "Restarting service..."
sudo systemctl restart $SERVICE_NAME

# 7. Check status
sleep 2
sudo systemctl status $SERVICE_NAME --no-pager | head -15

echo ""
echo "=== Deploy complete ==="
echo "App: https://app.isaflow.co.za"
