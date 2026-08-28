#!/bin/bash
# Deploy IsaFlow App to Velocity Server (standalone build)
set -e

DEPLOY_DIR="/home/velo/isaflow"
# Resolve the repo from the script's own location so the script works from any
# git worktree (parallel sessions share the main checkout's .next and clobber
# each other's builds). Override with REPO_DIR=... if needed.
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVICE_NAME="isaflow"
BUN="/home/hein/.bun/bin/bun"

# Concurrent-deploy lock (P3.1): two overlapping deploys would race on the
# rollback snapshot AND interleave golden-suite money flows on the prod Demo.
# flock releases automatically when this process exits, so a killed deploy
# never leaves a stale lock behind.
LOCK_FILE="/tmp/isaflow-deploy.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "ERROR: another deploy is already running (lock: $LOCK_FILE). Wait for it to finish."
  exit 1
fi

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
# Worktree bootstrap: .env.local and node_modules are gitignored, so a fresh
# worktree has neither. Copy the env from the main checkout and install deps.
MAIN_REPO="$(cd "$(git -C "$REPO_DIR" rev-parse --git-common-dir)/.." && pwd)"
if [ ! -f "$REPO_DIR/.env.local" ] && [ -f "$MAIN_REPO/.env.local" ]; then
  echo "Worktree: copying .env.local from $MAIN_REPO"
  cp "$MAIN_REPO/.env.local" "$REPO_DIR/.env.local"
fi
if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "Worktree: node_modules missing — running bun install"
  "$BUN" install --frozen-lockfile
fi
ENV_LOCAL="$REPO_DIR/.env.local"
if [ -f "$ENV_LOCAL" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && export "$line"
  done < <(grep -E '^SENTRY_(AUTH_TOKEN|URL|ORG|PROJECT)=' "$ENV_LOCAL" || true)
fi

# NEXT_PUBLIC_* vars are inlined at build time. The workspace .env.local
# holds dev URLs (localhost); reading NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_ADMIN_URL
# from the prod env file ensures GoTrue recovery/invite links point at prod.
if sudo test -f /home/velo/isaflow/.env.local; then
  export NEXT_PUBLIC_APP_URL=$(sudo grep -E '^NEXT_PUBLIC_APP_URL=' /home/velo/isaflow/.env.local | tail -1 | cut -d= -f2-)
  export NEXT_PUBLIC_ADMIN_URL=$(sudo grep -E '^NEXT_PUBLIC_ADMIN_URL=' /home/velo/isaflow/.env.local | tail -1 | cut -d= -f2-)
  if [ -z "$NEXT_PUBLIC_ADMIN_URL" ]; then
    echo "ERROR: NEXT_PUBLIC_ADMIN_URL is missing from /home/velo/isaflow/.env.local"
    exit 1
  fi
  case "$NEXT_PUBLIC_ADMIN_URL" in
    http://localhost*|https://localhost*|http://127.0.0.1*|https://127.0.0.1*|http://[::1]*|https://[::1]*)
      echo "ERROR: NEXT_PUBLIC_ADMIN_URL must not point at localhost for production builds: $NEXT_PUBLIC_ADMIN_URL"
      exit 1
      ;;
  esac
  if [ "$NEXT_PUBLIC_ADMIN_URL" != "https://admin.isaflow.co.za" ]; then
    echo "ERROR: NEXT_PUBLIC_ADMIN_URL must be https://admin.isaflow.co.za for production builds: $NEXT_PUBLIC_ADMIN_URL"
    exit 1
  fi
  # instrumentation.ts runs validateEnv() during page-data collection. Without
  # these in the build env the build dies with a generic ENOENT on pages-manifest.
  #
  # PLATFORM_ADMIN_DATABASE_URL is deliberately NOT pulled from prod here.
  # validateEnv now requires it to name the same database as DATABASE_URL, and
  # DATABASE_URL during a build comes from the workspace .env.local (isaflow_dev)
  # — so importing prod's value (isaflow) makes the build fail its own guard.
  # The workspace file already defines all four of these, and none is a
  # NEXT_PUBLIC_* var, so none is inlined into the artifact; they exist purely to
  # satisfy the boot check while building. The real prod values reach the app at
  # runtime through the systemd EnvironmentFile, not through this build.
  export ENCRYPTION_KEY=$(sudo grep -E '^ENCRYPTION_KEY=' /home/velo/isaflow/.env.local | tail -1 | cut -d= -f2-)
  export PORTAL_JWT_SECRET=$(sudo grep -E '^PORTAL_JWT_SECRET=' /home/velo/isaflow/.env.local | tail -1 | cut -d= -f2-)
  export IMPERSONATION_JWT_SECRET=$(sudo grep -E '^IMPERSONATION_JWT_SECRET=' /home/velo/isaflow/.env.local | tail -1 | cut -d= -f2-)
  echo "Build URL: NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL"
fi
export PATH="$HOME/.local/bin:$PATH"

# 1. Build locally with bun
echo "Installing dependencies..."
$BUN install

# 1a. CI gate — type-check, lint, unit tests must pass before we build
if [ "${SKIP_CI:-0}" != "1" ]; then
  echo "Running CI gate (bun run ci)..."
  $BUN run ci
else
  echo "WARNING: SKIP_CI=1 — CI gate bypassed"
fi

echo "Building production bundle..."
NODE_ENV=production $BUN run build

# 1b. Build-integrity gate — a surviving dev-server watcher once rewrote
# pages-manifest.json mid-build (2026-06-11: the standalone output shipped a
# 6-page dev manifest → 11-minute all-404 outage). Refuse to go further with
# a manifest that is obviously not a full production build; real builds carry
# ~1125 entries. Runs BEFORE migrations so an aborted deploy touches nothing.
MANIFEST="$REPO_DIR/.next/standalone/.next/server/pages-manifest.json"
# Floor = ~89% of the 1125 entries in the current live build: loose enough to
# survive normal page-count drift, tight enough that no partial/dev manifest
# (the incident shipped 6) can pass. Raise alongside major page-count growth.
MIN_MANIFEST_ENTRIES=1000
if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: $MANIFEST missing — build did not produce a standalone pages-manifest"
  exit 1
fi
# jq takes the path as an argument (no shell-into-JS quoting surface), emits a
# bare integer on stdout, and exits non-zero on malformed JSON (set -e aborts).
MANIFEST_ENTRIES=$(jq 'length' "$MANIFEST")
if ! [ "$MANIFEST_ENTRIES" -ge "$MIN_MANIFEST_ENTRIES" ] 2>/dev/null; then
  echo "ERROR: pages-manifest has $MANIFEST_ENTRIES entries (need >= $MIN_MANIFEST_ENTRIES) — refusing to deploy a corrupted build"
  echo "Likely cause: a dev server's watcher is still running against this checkout. Sweep processes by /proc/*/cwd, rm -rf .next, rebuild."
  exit 1
fi
echo "Build integrity OK: $MANIFEST_ENTRIES pages-manifest entries"

# 2. Run database migrations against production DB
# Migrations run BEFORE rsync so that a failing migration leaves both the
# on-disk standalone and the running service untouched (consistent rollback
# state). Once the script aborts here, /home/velo/isaflow/ still matches the
# previously-deployed code and DB schema. .env.local is owned by velo:velo
# (0600) so we read it with sudo.
echo "Running database migrations..."
PROD_ENV="$DEPLOY_DIR/.env.local"
if sudo test -f "$PROD_ENV"; then
  PROD_DB=$(sudo grep "^DATABASE_URL=" "$PROD_ENV" | cut -d= -f2-)
  if [ -n "$PROD_DB" ]; then
    DATABASE_URL="$PROD_DB" $BUN "$REPO_DIR/scripts/apply-migrations.ts"

    echo "Running schema-drift audit..."
    DATABASE_URL="$PROD_DB" $BUN "$REPO_DIR/scripts/audit-schema-drift.ts"
  else
    echo "WARNING: DATABASE_URL not found in $PROD_ENV — skipping migrations"
  fi
else
  echo "WARNING: $PROD_ENV not found — skipping migrations"
fi

# 3. Deploy standalone output (includes all deps, no npm install needed)
echo "Syncing standalone build..."
sudo -u velo bash -c "mkdir -p $DEPLOY_DIR"

# 3a. Pre-deploy snapshot for rollback (P3.1). Taken after the build +
# migration gates, immediately before the overwrite. If the post-deploy
# verification gate fails, scripts/rollback-deploy.sh restores this snapshot.
BACKUP_DIR="/home/velo/isaflow-rollback"
if sudo test -f "$DEPLOY_DIR/server.js"; then
  PREV_SHA=$(sudo cat "$DEPLOY_DIR/RELEASE_SHA" 2>/dev/null || echo 'unknown')
  echo "Snapshotting current release ($PREV_SHA) to $BACKUP_DIR..."
  sudo rsync -a --delete \
    --exclude=.env.local \
    --exclude='.env.*.bak' \
    --exclude='.env.pre-*' \
    --exclude='.env.backup-*' \
    "$DEPLOY_DIR/" "$BACKUP_DIR/"
else
  echo "WARNING: no existing deployment at $DEPLOY_DIR — no rollback snapshot taken"
fi

# Standalone server + bundled node_modules
# Preserve .env.local plus any .env.*.bak / .env.pre-* rollback backups that
# ops created for cutover safety. rsync --delete wipes everything else in
# the target that isn't in source.
sudo rsync -a --delete \
  --exclude=.env.local \
  --exclude='.env.*.bak' \
  --exclude='.env.pre-*' \
  --exclude='.env.backup-*' \
  "$REPO_DIR/.next/standalone/" "$DEPLOY_DIR/"

# Static assets (not included in standalone by default)
sudo rsync -a --delete \
  "$REPO_DIR/.next/static/" "$DEPLOY_DIR/.next/static/"

# Public folder (logo, icons, manifest, sw.js)
sudo rsync -a --delete \
  "$REPO_DIR/public/" "$DEPLOY_DIR/public/"

# Sharp belt-and-braces: outputFileTracingIncludes in next.config.js should
# already pull sharp into .next/standalone/node_modules, but the trace has
# historically missed native binaries. Copy the resolved tree directly so
# image optimization never logs "sharp-missing in production" again.
if [ -d "$REPO_DIR/node_modules/sharp" ]; then
  sudo rsync -a "$REPO_DIR/node_modules/sharp/" "$DEPLOY_DIR/node_modules/sharp/"
fi
if [ -d "$REPO_DIR/node_modules/@img" ]; then
  sudo rsync -a "$REPO_DIR/node_modules/@img/" "$DEPLOY_DIR/node_modules/@img/"
fi

# Inject BUILD_ID into sw.js so stale caches are evicted on every deploy
BUILD_ID=$(cat "$REPO_DIR/.next/BUILD_ID")
sudo sed -i "s/__BUILD_ID__/$BUILD_ID/g" "$DEPLOY_DIR/public/sw.js"

# Record the deployed SHA so the next deploy's snapshot (and any rollback)
# can name the release it restores.
echo "$GIT_SHA" | sudo tee "$DEPLOY_DIR/RELEASE_SHA" >/dev/null

# Fix ownership
sudo chown -R velo:velo "$DEPLOY_DIR"

# 4. Copy env file if not exists
if [ ! -f "$DEPLOY_DIR/.env.local" ]; then
  echo "Creating .env.local..."
  sudo -u velo cp "$ENV_LOCAL" "$DEPLOY_DIR/.env.local"
fi

# 5. Install/update systemd service
echo "Updating systemd service..."
sudo cp "$REPO_DIR/scripts/${SERVICE_NAME}.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable $SERVICE_NAME

# 6. Install nginx config if not exists
if [ ! -f /etc/nginx/sites-available/app-isaflow ]; then
  echo "Installing nginx config..."
  sudo cp "$REPO_DIR/scripts/nginx-app-isaflow" /etc/nginx/sites-available/app-isaflow
  sudo ln -sf /etc/nginx/sites-available/app-isaflow /etc/nginx/sites-enabled/app-isaflow
  sudo nginx -t && sudo systemctl reload nginx
fi

# 7. Restart service
echo "Restarting service..."
sudo systemctl restart $SERVICE_NAME

# 7b. Check status
sleep 2
sudo systemctl status $SERVICE_NAME --no-pager | head -15

# 7c. Post-deploy verification gate (P3.1): health + golden-paths suite vs
# prod Demo + integrity check (committed baseline waives ONLY the known
# HUMAN-GATED failure). Failure = automatic rollback to the 3a snapshot.
# SKIP_VERIFY=1 is for genuine emergencies only and leaves the deploy
# UNVERIFIED — say so out loud in the deploy report.
if [ "${SKIP_VERIFY:-0}" != "1" ]; then
  echo ""
  echo "Running post-deploy verification gate..."
  if DATABASE_URL="$PROD_DB" bash "$REPO_DIR/scripts/verify-deploy.sh" "https://app.isaflow.co.za"; then
    echo "Post-deploy verification PASSED"
  else
    echo ""
    echo "!!! POST-DEPLOY VERIFICATION FAILED — rolling back to the pre-deploy snapshot !!!"
    # `|| rc=$?` keeps set -e from killing the script here: the compound
    # failure (bad deploy AND failed/unavailable rollback) is exactly when
    # the operator needs the framing below, not a mid-script death.
    ROLLBACK_RC=0
    bash "$REPO_DIR/scripts/rollback-deploy.sh" || ROLLBACK_RC=$?
    echo ""
    if [ "$ROLLBACK_RC" -eq 0 ]; then
      echo "Deploy of $GIT_SHA was ROLLED BACK (code only — DB migrations are"
      echo "additive by project rule and were NOT reverted). Fix the regression,"
      echo "re-run the battery, then redeploy."
    else
      echo "!!! ROLLBACK ALSO FAILED (exit $ROLLBACK_RC) after deploying $GIT_SHA —"
      echo "service state is UNKNOWN. Recover manually:"
      echo "  1. sudo journalctl -u $SERVICE_NAME -n 100 --no-pager"
      echo "  2. If no snapshot existed: git checkout <last-good SHA> && SKIP_VERIFY=1 bash scripts/deploy.sh"
      echo "  3. Verify by hand: bash scripts/verify-deploy.sh https://app.isaflow.co.za"
    fi
    exit 1
  fi
else
  echo "WARNING: SKIP_VERIFY=1 — post-deploy verification gate bypassed (deploy is UNVERIFIED)"
fi

echo ""
echo "=== Deploy complete ==="
echo "App: https://app.isaflow.co.za"

# 8. Finalize Sentry release (fail-open — never block a deploy).
# SENTRY_AUTH_TOKEN was already loaded at the top of this script so the
# webpack plugin could create the release during build.
#
# NB: errors.isaflow.co.za runs Bugsink, which doesn't implement the
# /api/0/organizations or /api/0/projects release endpoints — sentry-cli
# release commands will always fail against it. Event ingestion + source
# maps (via the webpack plugin) are what matter; release tagging is a nice-to-have
# we skip on Bugsink. Opt-in via SENTRY_RELEASE_MGMT=true if pointed at real Sentry.
if [ "$SENTRY_RELEASE_MGMT" = "true" ] && [ -n "$SENTRY_AUTH_TOKEN" ] && command -v sentry-cli >/dev/null 2>&1; then
  echo "Recording Sentry release $GIT_SHA..."
  sentry-cli releases new "$GIT_SHA" \
    || echo "WARN: sentry-cli new failed (non-fatal)"
  sentry-cli releases set-commits "$GIT_SHA" --auto \
    || echo "WARN: sentry-cli set-commits failed (non-fatal)"
  sentry-cli releases finalize "$GIT_SHA" \
    || echo "WARN: sentry-cli finalize failed (non-fatal)"
  sentry-cli releases deploys "$GIT_SHA" new -e production \
    || echo "WARN: sentry-cli deploys failed (non-fatal)"
else
  echo "Skipping Sentry release finalize (set SENTRY_RELEASE_MGMT=true to enable; Bugsink doesn't support it)"
fi
