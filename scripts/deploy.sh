#!/bin/bash
# Deploy IsaFlow App to Velocity Server (standalone build)
set -e

DEPLOY_DIR="/home/velo/isaflow"
REPO_DIR="/home/hein/Workspace/IsaFlow"
SERVICE_NAME="isaflow"
BUN="/home/hein/.bun/bin/bun"

echo "=== Deploying IsaFlow ==="

# Capture git SHA for Sentry release tagging
cd "$REPO_DIR"
export GIT_SHA=$(git rev-parse --short HEAD)
export SENTRY_RELEASE="$GIT_SHA"
export NEXT_PUBLIC_GIT_SHA="$GIT_SHA"
echo "Release SHA: $GIT_SHA"

# Load SENTRY_* keys from .env.local NOW (not later) so the Sentry webpack
# plugin can create the release during the build. Pull only the SENTRY_*
# keys — `set -a; .` trips on multi-line app values.
if [ -f "$REPO_DIR/.env.local" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && export "$line"
  done < <(grep -E '^SENTRY_(AUTH_TOKEN|URL|ORG|PROJECT)=' "$REPO_DIR/.env.local" || true)
fi
export PATH="$HOME/.local/bin:$PATH"

# 1. Build locally with bun
echo "Installing dependencies..."
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

# Inject BUILD_ID into sw.js so stale caches are evicted on every deploy
BUILD_ID=$(cat "$REPO_DIR/.next/BUILD_ID")
sudo sed -i "s/__BUILD_ID__/$BUILD_ID/g" "$DEPLOY_DIR/public/sw.js"

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

# 6. Run database migrations against production DB
# .env.local is owned by velo:velo (0600) so we read it with sudo.
echo "Running database migrations..."
PROD_ENV="$DEPLOY_DIR/.env.local"
if sudo test -f "$PROD_ENV"; then
  PROD_DB=$(sudo grep "^DATABASE_URL=" "$PROD_ENV" | cut -d= -f2-)
  if [ -n "$PROD_DB" ]; then
    DATABASE_URL="$PROD_DB" node "$REPO_DIR/scripts/run-migrations.mjs" 2>&1 | grep -E "Running:|Done|Failed|complete|==="
  else
    echo "WARNING: DATABASE_URL not found in $PROD_ENV — skipping migrations"
  fi
else
  echo "WARNING: $PROD_ENV not found — skipping migrations"
fi

# 7. Restart service
echo "Restarting service..."
sudo systemctl restart $SERVICE_NAME

# 7. Check status
sleep 2
sudo systemctl status $SERVICE_NAME --no-pager | head -15

echo ""
echo "=== Deploy complete ==="
echo "App: https://app.isaflow.co.za"

# 8. Finalize Sentry release (fail-open — never block a deploy).
# SENTRY_AUTH_TOKEN was already loaded at the top of this script so the
# webpack plugin could create the release during build.
if [ -n "$SENTRY_AUTH_TOKEN" ] && command -v sentry-cli >/dev/null 2>&1; then
  echo "Finalizing Sentry release $GIT_SHA..."
  sentry-cli releases finalize "$GIT_SHA" || echo "WARN: sentry-cli finalize failed (non-fatal)"
  sentry-cli releases deploys "$GIT_SHA" new -e production \
    || echo "WARN: sentry-cli deploys failed (non-fatal)"
else
  echo "Skipping Sentry release finalize (SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN:+set} sentry-cli=$(command -v sentry-cli || echo missing))"
fi
