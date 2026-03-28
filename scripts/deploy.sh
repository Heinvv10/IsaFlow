#!/bin/bash
# Deploy IsaFlow App to Velocity Server
set -e

DEPLOY_DIR="/home/velo/isaflow"
REPO_DIR="/home/hein/Workspace/Accounting"
SERVICE_NAME="isaflow"

echo "=== Deploying IsaFlow ==="

# 1. Sync files to deploy directory
echo "Syncing files..."
sudo -u velo bash -c "
  mkdir -p $DEPLOY_DIR
  rsync -a --delete \
    --exclude=node_modules \
    --exclude=.next \
    --exclude=.git \
    --exclude=.env.local \
    --exclude=tests \
    --exclude=test-results \
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

# 4. Install systemd service
if [ ! -f /etc/systemd/system/${SERVICE_NAME}.service ]; then
  echo "Installing systemd service..."
  sudo cp $REPO_DIR/scripts/${SERVICE_NAME}.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable $SERVICE_NAME
fi

# 5. Install nginx config if not exists
if [ ! -f /etc/nginx/sites-available/app-isaflow ]; then
  echo "Installing nginx config..."
  sudo cp $REPO_DIR/scripts/nginx-app-isaflow /etc/nginx/sites-available/app-isaflow
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
