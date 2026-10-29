#!/bin/bash
# Deploy IsaFlow (blue/green, standalone build). DEPLOY_DIR holds the prod env file + live RELEASE_SHA.
set -e

DEPLOY_DIR="/home/velo/isaflow"
# Resolve the repo from the script's own location so the script works from any
# git worktree (parallel sessions share the main checkout's .next and clobber
# each other's builds). Override with REPO_DIR=... if needed.
if [ -z "${REPO_DIR:-}" ]; then
  if [ -z "${BASH_SOURCE[0]:-}" ]; then
    echo "ERROR: run as 'bash scripts/deploy.sh' (BASH_SOURCE unset) or set REPO_DIR explicitly." >&2
    exit 1
  fi
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
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
# Worktree bootstrap: .env.local is gitignored, so a fresh worktree lacks it
# and the build would run without DATABASE_URL etc. Copy it from the main
# checkout (same secrets, same machine, still gitignored in the worktree).
# node_modules is handled by the unconditional `bun install` further down.
MAIN_REPO="$(cd "$(git -C "$REPO_DIR" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
if [ ! -f "$REPO_DIR/.env.local" ] && [ -f "$MAIN_REPO/.env.local" ]; then
  echo "Worktree: copying .env.local from $MAIN_REPO"
  cp "$MAIN_REPO/.env.local" "$REPO_DIR/.env.local"
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

# 1-0. Blue/green (2026-10-29): the app runs as isaflow@3111 and isaflow@3112
# behind nginx. This deploy builds into the IDLE colour, verifies it on its own
# port, then switches nginx to it; the live colour is never written or
# restarted, so nobody's request is cut and the old colour is the rollback.
# Both refusals below come before the 20-minute CI gate and the build.
# shellcheck source=ops/ownerDatabaseUrl.sh
. "$REPO_DIR/scripts/ops/ownerDatabaseUrl.sh"
# shellcheck source=deploy/bluegreen.sh
. "$REPO_DIR/scripts/deploy/bluegreen.sh"
LIVE_PORT=$(bg_live_port)
if [ -z "$LIVE_PORT" ]; then
  echo "ERROR: no live colour in $BG_UPSTREAM_FILE — run scripts/deploy/cutover.sh once first"
  exit 1
fi
IDLE_PORT=$(bg_other_port "$LIVE_PORT")
echo "Live colour: isaflow@$LIVE_PORT; this deploy builds isaflow@$IDLE_PORT"
EARLY_DB=$(owner_database_url_for "$DEPLOY_DIR/.env.local" sudo || true)
bg_midday_migration_check "$EARLY_DB" "$REPO_DIR" || exit 1
unset EARLY_DB

# 1a-0. Migration-parity gate. Runs BEFORE the CI gate (and is not subject to
# SKIP_CI) because the CI gate runs DB-backed tests against isaflow_dev: dev
# must carry every migration this deploy will apply to prod, with identical
# checksums, or those tests fail for reasons unrelated to the code. Prod is
# opened read-only; --apply-dev applies missing pending migrations to DEV only.
# Fails closed: if prod's URL cannot be read, parity cannot be verified.
# Both sides use the schema owner's URL: --apply-dev applies migrations to
# dev, and the app's own login role cannot (S-07b). Prod's comes from
# $OWNER_ENV_FILE (root-only, outside the deploy dir), then .env.local's
# OWNER_DATABASE_URL, then its DATABASE_URL, each fallback with a warning;
# dev's from the workspace .env.local.
PARITY_PROD_ENV="$DEPLOY_DIR/.env.local"
PARITY_PROD_DB=""
if sudo test -f "$PARITY_PROD_ENV"; then
  PARITY_PROD_DB=$(owner_database_url_for "$PARITY_PROD_ENV" sudo || true)
fi
if [ -z "$PARITY_PROD_DB" ]; then
  echo "ERROR: cannot read OWNER_DATABASE_URL or DATABASE_URL from $OWNER_ENV_FILE or $PARITY_PROD_ENV - migration parity cannot be verified"
  exit 1
fi
PARITY_DEV_DB=$(owner_database_url "$ENV_LOCAL" < "$ENV_LOCAL" || true)
if [ -z "$PARITY_DEV_DB" ]; then
  echo "ERROR: cannot read OWNER_DATABASE_URL or DATABASE_URL from $ENV_LOCAL - migration parity cannot be verified"
  exit 1
fi
echo "Checking migration parity (dev vs prod vs repo)..."
DATABASE_URL="$PARITY_DEV_DB" PARITY_PROD_DATABASE_URL="$PARITY_PROD_DB" $BUN "$REPO_DIR/scripts/check-migration-parity.ts" --apply-dev
unset PARITY_DEV_DB
unset PARITY_PROD_DB

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
# Migrations run BEFORE the new colour starts, so a failing migration leaves
# the live colour serving untouched. .env.local is owned by velo:velo (0600)
# so we read it with sudo.
echo "Running database migrations..."
PROD_ENV="$DEPLOY_DIR/.env.local"
if sudo test -f "$PROD_ENV"; then
  # The schema owner's URL: the app's DATABASE_URL cannot migrate (S-07b).
  PROD_DB=$(owner_database_url_for "$PROD_ENV" sudo || true)
  if [ -n "$PROD_DB" ]; then
    # Again here: the clock may have crossed 08:00 during CI and the build.
    bg_midday_migration_check "$PROD_DB" "$REPO_DIR" || exit 1
    DATABASE_URL="$PROD_DB" $BUN "$REPO_DIR/scripts/apply-migrations.ts"

    echo "Running schema-drift audit..."
    DATABASE_URL="$PROD_DB" $BUN "$REPO_DIR/scripts/audit-schema-drift.ts"

    # S-07b: the app's login roles still cannot reach the owner, and, once they
    # can log in, the runbook's event trigger and reserved roles are in place.
    # Before the code switch: a failure here is configuration, which a code
    # rollback would not fix (docs/runbooks/s07b-app-pool-login-roles.md).
    DATABASE_URL="$PROD_DB" $BUN "$REPO_DIR/scripts/check-app-login-roles.ts"
  else
    echo "WARNING: neither OWNER_DATABASE_URL nor DATABASE_URL found in $OWNER_ENV_FILE or $PROD_ENV — skipping migrations"
  fi
else
  echo "WARNING: $PROD_ENV not found — skipping migrations"
fi

# 3. Copy the standalone build into the idle colour's folder.
echo "Syncing build into isaflow@$IDLE_PORT ($(bg_release_dir "$IDLE_PORT"))..."
bg_sync_release "$REPO_DIR" "$IDLE_PORT" "$GIT_SHA"

# 4. Copy env file if not exists. The production file is velo:velo 0600, so
# the deploy user cannot reliably stat it or copy into its directory without
# sudo. Use root only for the file operation and preserve the least-privilege
# owner/mode expected by the systemd service. Both colours read this one file.
if ! sudo test -f "$DEPLOY_DIR/.env.local"; then
  echo "Creating .env.local..."
  sudo install -o velo -g velo -m 600 "$ENV_LOCAL" "$DEPLOY_DIR/.env.local"
fi

# 5. Install/update the colour unit template (the previous one is kept, and put
# back if this build fails: the live colour restarts from it after a crash),
# then start the idle colour.
echo "Updating systemd unit template..."
sudo cp -p "$BG_UNIT_FILE" "$BG_UNIT_FILE.prev" 2>/dev/null || true
sudo cp "$REPO_DIR/scripts/${SERVICE_NAME}@.service" "$BG_UNIT_FILE"
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}@$IDLE_PORT"
# A failed build: users stay on the live colour; the idle one is disabled,
# stopped and marked FAILED so no rollback switches to it.
fail_idle() {
  echo ""
  echo "!!! $1 — users stay on isaflow@$LIVE_PORT; retiring isaflow@$IDLE_PORT !!!"
  bg_retire_failed "$IDLE_PORT" "$GIT_SHA: $1" || true
  if sudo test -f "$BG_UNIT_FILE.prev"; then sudo mv "$BG_UNIT_FILE.prev" "$BG_UNIT_FILE"; sudo systemctl daemon-reload; fi
  echo "Deploy of $GIT_SHA was NOT switched in (DB migrations, if any, stay"
  echo "applied: they are additive by project rule). Fix the regression, then redeploy."
  exit 1
}
echo "Starting isaflow@$IDLE_PORT..."
bg_start "$IDLE_PORT" || fail_idle "isaflow@$IDLE_PORT did not start"

# 6. Verification gate (P3.1), BEFORE any user reaches the new build: health +
# golden-paths suite vs prod Demo + integrity check, against the idle colour's
# own port. SKIP_VERIFY=1 is for genuine emergencies only and leaves the deploy
# UNVERIFIED — say so out loud in the deploy report.
if [ "${SKIP_VERIFY:-0}" != "1" ]; then
  echo ""
  echo "Verifying isaflow@$IDLE_PORT before the switch..."
  DATABASE_URL="$PROD_DB" bash "$REPO_DIR/scripts/verify-deploy.sh" "http://localhost:$IDLE_PORT" \
    || fail_idle "VERIFICATION FAILED"
  echo "Verification PASSED"
else
  echo "WARNING: SKIP_VERIFY=1 — verification gate bypassed (deploy is UNVERIFIED)"
fi

# 7. Add the build's hashed static files to the shared folder nginx serves
# (kept for the last few builds, so a page loaded before the switch still finds
# its chunks), then switch nginx (graceful reload: in-flight requests finish on
# the old colour). Proven by nginx's own answer and by the public URL; either
# failing switches back.
bg_sync_static "$REPO_DIR"
echo "Switching nginx: isaflow@$LIVE_PORT -> isaflow@$IDLE_PORT..."
bg_switch "$IDLE_PORT" || fail_idle "nginx switch failed"
if ! bg_served_by "$IDLE_PORT" \
  || ! curl -sf --max-time 10 --retry 5 --retry-delay 2 --retry-all-errors "https://app.isaflow.co.za/api/health" >/dev/null; then
  echo "!!! CHECK FAILED after the switch — switching back to isaflow@$LIVE_PORT !!!"
  bg_switch "$LIVE_PORT" || { echo "!!! SWITCH-BACK FAILED: nginx may still send users to isaflow@$IDLE_PORT. Run scripts/rollback-deploy.sh now."; exit 1; }
  fail_idle "post-switch check failed"
fi
sudo rm -f "$BG_UNIT_FILE.prev"
bg_record_live "$IDLE_PORT"
echo "Live: isaflow@$IDLE_PORT at $GIT_SHA. isaflow@$LIVE_PORT keeps running as the rollback (scripts/rollback-deploy.sh)."

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
