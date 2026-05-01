# Secrets Rotation Runbook

**Companion:** `docs/audits/2026-04-15/secrets-inventory.md`

## When to use this
- Scheduled rotation (quarterly for auth-critical, annually for third-party).
- Suspected compromise (rotate immediately, skip maintenance window).
- Staff offboarding with access to the secret.

## Generic playbook (all secrets)

### Pre-flight
1. Check inventory. What class is the secret?
2. For auth-critical: schedule maintenance window. Notify users.
3. For data: confirm deploy tooling restarts cleanly (pod drain → replace → health check via /api/health).
4. For third-party: confirm vendor can issue the new credential with grace period (dual-cred window).
5. Capture the current value in 1Password (not git) for rollback.

### Rotate
1. Generate new value (vendor console, or `openssl rand -hex 32` for local crypto secrets).
2. Update value in deploy config (systemd env file on the Velocity server, or wherever it lives).
3. Do NOT revoke the old value yet.

### Deploy
1. Trigger deploy via `bash scripts/deploy.sh` (or project's standard deploy script).
2. Watch `/api/health` — expect 200 within ~30s.
3. Check `/api/health/deep` — all deps healthy (db, smtp, paystack).

### Verify
1. Functional check (log in for JWT_SECRET, send email for SMTP, etc.).
2. Check structured logs for auth failures, connection errors, vendor 401s.
3. Watch for 15 minutes before declaring success.

### Post-flight
1. Revoke old value in source of truth.
2. Update `docs/audits/2026-04-15/secrets-inventory.md` with rotation date.
3. Remove old value from 1Password after 48h cooling period.

## Per-secret notes

### JWT_SECRET (auth-critical)
- Signs session JWTs. Rotation invalidates every existing token immediately.
- **Maintenance window required**, or implement a dual-secret verification window (accept old + new for 2h, then drop old) — note that ISAFlow does not currently implement dual-secret verification, so today rotation = everyone gets logged out.
- Post-rotation: log in as a test user; verify existing sessions returned 401 and re-authenticated cleanly.

### ENCRYPTION_KEY (auth-critical)
- Used to encrypt/decrypt data at rest (check `src/lib/crypto` or similar for specific use). Rotating without re-encrypting stored ciphertexts breaks data access.
- **DO NOT rotate in place.** Procedure: (1) generate new key, (2) decrypt-with-old + encrypt-with-new for all stored ciphertexts (migration script required), (3) cut over to new key, (4) retain old key for rollback window.
- This is a bigger project than a rotation — treat as a data migration.

### DATABASE_URL (data)
- Neon: create a new role with a new password in the Neon console, update `DATABASE_URL` in server env, deploy, verify, then drop the old role.
- Expect ~30s of transient 503s during pod restart (load balancer handles it).
- Post-rotation: `SELECT 1` succeeds from new pods; tail structured logs for connection errors.

### REDIS_URL (data)
- If Redis is managed (Upstash/Redis Cloud): rotate via vendor console, update env, deploy, verify.
- If self-hosted: add new password to Redis ACL, update env, deploy, verify, remove old password.

### SMTP credentials (third-party)
- All 5 SMTP_* vars typically rotate together (full new credential set).
- Generate new creds in mail provider console (likely Resend given `RESEND_API_KEY`, but SMTP_* look like Postmark/SES-style separate vars — check).
- Deploy. Trigger a test email (e.g., password reset from a dev account). Then revoke old creds.

### STITCH_CLIENT_SECRET + related (third-party)
- Bank-feed OAuth integration only (Stitch's payments product was replaced by Paystack).
- Contact Stitch support before rotation — their onboarding flow is sensitive to mismatched client creds.
- Dual-cred window: aim for ~1h overlap to cover in-flight OAuth callbacks.

### PAYSTACK_SECRET_KEY (third-party, payments + webhook signing)
- Single key serves three roles: REST auth (Bearer), webhook HMAC-SHA512
  signing key, and authorisation-charge signing. Rotation invalidates all
  three simultaneously.
- **Rotate during a scheduled quiet window.** Any in-flight checkout that
  posts a webhook signed by the OLD key will fail verification once the
  server holds the new key.
- Procedure: generate new sk_live_ in Paystack dashboard → Settings → API
  Keys & Webhooks. Update PAYSTACK_SECRET_KEY in deploy env. Deploy.
  Trigger a test payment in sandbox. Confirm webhook arrives + verifies.
  Revoke old key in dashboard.
- Post-rotation: re-check the Webhook URL in the Paystack dashboard — it is
  not affected by key rotation but worth confirming.

### RESEND_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / VLLM_API_KEY (third-party)
- Vendor dashboards. Low user-facing impact (background jobs, AI features).
- Generate new key, update env, deploy, run one test call, revoke old.

### ADMIN_ALERT_WEBHOOK_URL (third-party)
- Likely Slack/Discord/Telegram webhook. Rotating URL = losing alert delivery during cutover.
- Acceptable: generate new URL at destination, update env, send test alert, delete old webhook.

### VF_STORAGE_URL (third-party)
- File storage endpoint. Check whether this is a signed URL (requires token rotation) or a service endpoint (URL change = config deploy).

## Infra-class vars
For `NEXT_PUBLIC_*`, `NODE_ENV`, thresholds, fixtures, test JWTs — no rotation playbook needed. Change via standard deploy. Record the change in a commit message; no runbook required.

## Rollback
- If rotation breaks auth/data: redeploy previous env (that's why we kept the old value for 48h).
- If third-party rotation silently breaks integration: revert deploy, re-enable old creds in vendor console (still active due to grace period).
- If rollback after 48h cooling: new secret is already the only valid one; forward-only recovery (fix the integration, do not try to revert).
