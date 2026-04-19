# `src/lib/validateEnv.ts`

## Purpose
Startup guard that throws if any required environment variable is missing and warns to stderr for recommended-but-optional ones.

## Key exports

- `validateEnv() → void` — call once at server startup (e.g. `next.config.js` or the app entry point). Throws `Error` listing all missing required vars; writes a warning line to `process.stderr` for missing recommended vars.

## Required variables
`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`

## Recommended variables
`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`

## Dependencies
None — pure Node.js (`process.env`).

## Critical notes
- **`ENCRYPTION_KEY` is required**: removing it from `REQUIRED_VARS` would silently allow `encryption.ts` to soft-fail and store tokens as plaintext.
- **Throws, not warns** on missing required vars — the process should not start without them; catch and handle in the startup script if a custom exit message is needed.
- **Recommended-var warning uses `process.stderr.write`** directly to avoid triggering the no-`console` lint rule.
- **Not comprehensive**: `SENTRY_DSN`, `REDIS_URL`, `NEXT_PUBLIC_*` env vars are not listed — they are handled by the consumers that need them (Redis degrades gracefully; Sentry checks `SENTRY_ENABLED`).
- Add new required vars to `REQUIRED_VARS` (typed `as const`) whenever a new secret is introduced that the app cannot start without.
