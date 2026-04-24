# validateEnv.ts

## Purpose
Boot-time environment-variable guard. Hard-fails the process if any REQUIRED var is missing; warns to stderr for RECOMMENDED vars.

## Key exports
- `validateEnv(): void` — throws `Missing required environment variables: ...` when any REQUIRED var is unset; writes a `[env] Missing recommended ...` line to stderr for missing RECOMMENDED vars

## Dependencies
None — pure `process.env`.

## Critical notes
- **REQUIRED vars** (app will NOT start without these):
  - `DATABASE_URL` — primary Postgres connection
  - `JWT_SECRET` — user session tokens
  - `ENCRYPTION_KEY` — AES-256-GCM key for data at rest (tokens, stashes). App MUST fail at boot without this — do not lazy-check, otherwise `encryptToken` soft-fails and stores plaintext.
  - `PORTAL_JWT_SECRET` (pentest L3) — AFS portal and legacy AR portal (post-H1) session token signing; separate from `JWT_SECRET`.
  - `PLATFORM_ADMIN_DATABASE_URL` (pentest L5) — admin pool connects as a BYPASSRLS role; misconfiguration must fail at boot, not lazy-throw on the first admin request.
  - `IMPERSONATION_JWT_SECRET` (pentest L1) — dedicated secret for short-lived admin→tenant impersonation tokens; MUST be separate from `JWT_SECRET` so an exfiltrated user-session key cannot forge impersonation tokens.
- **RECOMMENDED vars** (warn only): `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` — missing these means email is broken but the app still boots.
- Uses `process.stderr.write` for the warning path to avoid tripping the `no-console` lint rule.
- Must be invoked at the very top of the Next.js server bootstrap (typically `next.config.js` or a `_app.ts` server-side branch) — not on hot-reload paths.
- **Not comprehensive**: `SENTRY_DSN`, `REDIS_URL`, `NEXT_PUBLIC_*` env vars are not listed. They are handled by the consumers that need them (Redis degrades gracefully; Sentry checks `SENTRY_ENABLED`).
- Adding a new REQUIRED var is a breaking change for every existing deploy; coordinate with the ops runbook and update `.env.example` in the same PR. Keep the array typed `as const`.

## Recent changes
- 2026-04-24: PR-4 separated `IMPERSONATION_JWT_SECRET` from `JWT_SECRET` (pentest L1); L-tier cleanup added `PLATFORM_ADMIN_DATABASE_URL` (L5) and `PORTAL_JWT_SECRET` (L3).
