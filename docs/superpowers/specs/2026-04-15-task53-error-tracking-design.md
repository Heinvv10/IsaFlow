# Task #53 — Multi-Project Error Tracking Design

**Date:** 2026-04-15
**Status:** Draft for review
**Parent:** Phase 4C Observability (`docs/superpowers/specs/2026-04-15-phase4c-observability-design.md`), item #3
**Source reference:** `docs/audits/2026-04-15/phase4b-closeout.md:131,155`

## Goal

Stand up one self-hosted, open-source error tracker on the Velocity server that captures unhandled exceptions, promise rejections, and explicitly-reported errors from ISAFlow today and from FibreFlow + ApexGEO next, with source-mapped stack traces, tenant-aware tagging, PII scrubbing, and Telegram alerting on the first occurrence of a new issue.

One instance, many projects, one SDK (`@sentry/nextjs`) pointed at a local DSN per app.

## Non-goals

- APM / distributed tracing (use HyperDX later if we want that).
- Session replay (Highlight is sunsetting; revisit when OSS replay matures).
- Log aggregation — stdout JSON logs from Phase 4C stay as-is.
- Browser RUM / Core Web Vitals.
- Replacing `log.error` call sites — Sentry captures run *in addition* to existing logger output.

## Tool choice: Bugsink

Evaluated Bugsink, GlitchTip, Sentry self-hosted, HyperDX, Highlight, SkyWalking/Jaeger. Bugsink wins on operational weight (single container, ~512 MB RAM, SQLite-to-start), UI quality, and Sentry-SDK drop-in compatibility. GlitchTip is the MIT-licensed runner-up if Polyform source-available becomes a concern. Full comparison in the research report above this spec.

## Architecture

### 1. Bugsink server on Velocity

- Container: `bugsink/bugsink:latest`
- Port: `8200` → nginx `errors.isaflow.co.za` → HTTPS via existing Let's Encrypt setup
- Storage: named docker volume `bugsink-data` (SQLite to start; upgrade to Postgres if we exceed ~1M events/mo)
- Env vars: `SECRET_KEY`, `BASE_URL=https://errors.isaflow.co.za`, `CREATE_SUPERUSER=admin:<one-time>`, `BEHIND_HTTPS_PROXY=true`
- Backups: nightly cron `tar czf` of the volume → existing Neon backup bucket (out-of-scope for this task; note for Phase 4D).

One nginx vhost, one systemd unit wrapping the docker run, one nightly backup cron.

### 2. Projects inside Bugsink

Three projects created via the Bugsink UI on first boot:

| Project | DSN env var | App repo |
|---------|------------|----------|
| `isaflow` | `SENTRY_DSN_ISAFLOW` | `/home/hein/Workspace/IsaFlow` |
| `fibreflow` | `SENTRY_DSN_FIBREFLOW` | `/home/hein/Workspace/FF_Next.js` |
| `apexgeo` | `SENTRY_DSN_APEXGEO` | `/home/hein/Workspace/ApexGEO` |

One team, one admin user (Hein), per-project DSNs. Additional apps added later = one new project + one new DSN.

### 3. ISAFlow SDK integration

Install: `bun add @sentry/nextjs` then run `bunx @sentry/wizard@latest -i nextjs` once, then edit the generated files to match the spec below.

Files produced:
- `sentry.server.config.ts` — server-side init, tags `runtime=node`, `release=$GIT_SHA`
- `sentry.edge.config.ts` — edge runtime (minimal; we have few edge routes)
- `sentry.client.config.ts` — browser init, `tracesSampleRate=0`, no replay
- `instrumentation.ts` — already reserved for Phase 4C; extend it to forward Sentry setup
- `next.config.js` — wrap with `withSentryConfig` for source-map upload on build

Tag enrichment (all runtimes):
- `company_id` — set via `Sentry.setTag` inside `withCompany` once the company is resolved
- `user_id` — set from `requireUser()` result, same place
- `request_id` — set from the Phase 4C ALS request ID so a Sentry event links back to the structured request log
- `route` — Next.js route path
- `release` — `process.env.GIT_SHA` populated by `scripts/deploy.sh`

### 4. PII scrubbing rules

`beforeSend` hook strips or redacts:
- Headers: drop `cookie`, `authorization`, `x-csrf-token`
- Body: redact any key matching `/pass|token|secret|otp|bank|iban|account.*number/i` (value replaced with `[REDACTED]`)
- URL query: same redaction list
- `request.data.email` — keep domain, hash local-part with sha256 first 8 chars
- Stack frame local variables — Sentry default is to not send; confirm `includeLocalVariables=false`

Rules live in `src/lib/sentry/scrub.ts` and are unit-tested (`tests/unit/sentry/scrub.test.ts`) against real fixtures (auth login body, bank rule create body, Stitch callback body).

### 5. Source-map upload

`scripts/deploy.sh` already runs `bun run build`. Extend it:
1. Before `bun run build`: export `GIT_SHA=$(git rev-parse --short HEAD)` and `SENTRY_RELEASE=$GIT_SHA`.
2. `withSentryConfig` uploads source maps automatically when `SENTRY_AUTH_TOKEN` + `SENTRY_URL` + `SENTRY_ORG` + `SENTRY_PROJECT` are present — read these from `.env.production` on the Velocity box.
3. After deploy: `sentry-cli releases finalize $GIT_SHA` and `sentry-cli releases deploys $GIT_SHA new -e production`.

Fail-open: if the upload step errors, log a warning and continue — a failed source-map upload must not block a deploy.

### 6. Telegram alert routing

Bugsink supports webhook integrations. Wire one webhook per project that POSTs to the existing Telegram bot used for deploy alerts:
- Trigger: first occurrence of a new issue (Bugsink "new issue" hook) — not every event
- Payload: project, title, environment, first-seen timestamp, direct link to the issue
- Throttle: rely on Bugsink's own deduplication (one alert per issue, not per event)

Reuse the `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` secrets already on the Velocity box.

## Risks

- **Disk growth on SQLite** — Bugsink rotates/evicts old events by default; confirm retention is set to 30 days. Mitigation: weekly `du -sh` check added to existing monitoring cron until we have real data.
- **PII leakage before scrub rule ships** — risk window is between Sentry init and the `beforeSend` hook being wired. Mitigation: land the scrub module + tests *before* calling `Sentry.init` anywhere in prod, and gate init behind `SENTRY_ENABLED=true` env var so we control cutover.
- **Alert storm on launch** — any long-standing latent exception will fire on first capture. Mitigation: turn Telegram webhook off for the first 24 h, triage the initial flood in the Bugsink UI, then enable alerts.
- **Deploy script breakage** — source-map upload step could kill deploys. Mitigation: the upload block is wrapped in `|| true` fail-open; unit-test the shell snippet with a stubbed `sentry-cli`.
- **License drift** — Bugsink uses Polyform Shield. Safe for internal use, blocks reselling. If we later want to embed error tracking in an ISAFlow customer-facing feature, re-evaluate vs. GlitchTip.

## Acceptance criteria

- `errors.isaflow.co.za` serves the Bugsink UI over HTTPS and survives a server reboot.
- Three projects visible in the UI, each with a working DSN.
- Deliberately throwing an error in an ISAFlow API route produces a Sentry event with: source-mapped stack frame pointing to a TypeScript line, `company_id` tag, `user_id` tag, `request_id` tag matching the structured log line, `release` = git SHA.
- Posting a body containing `password`, `bank_account_number`, and `csrf_token` to a captured error shows `[REDACTED]` for those fields in the Bugsink UI (verified from the browser, not just the scrub unit test).
- First-occurrence webhook lands a Telegram message in the deploy channel.
- `scripts/deploy.sh` finalizes a Sentry release per deploy; a failed upload does not block the deploy.
- FibreFlow and ApexGEO DSNs provisioned but SDK integration deferred to follow-up tasks (#54, #55).

## Rollout sequence

1. Bugsink container + nginx + systemd on Velocity (server-side only, no app changes).
2. Create 3 projects, capture DSNs, store in `.env.production` on the box.
3. Land `src/lib/sentry/scrub.ts` + unit tests in ISAFlow, merged but not yet called.
4. Wire `@sentry/nextjs` in ISAFlow with `SENTRY_ENABLED=false` in env — ship it dark.
5. Flip `SENTRY_ENABLED=true` on Velocity prod, trigger a test error, verify the acceptance criteria.
6. Enable Telegram webhook after 24 h triage window.
7. Open follow-up tasks #54 (FibreFlow) and #55 (ApexGEO).

## Out-of-scope follow-ups

- Task #54 — wire Bugsink into FibreFlow
- Task #55 — wire Bugsink into ApexGEO
- Phase 4D — backup/restore drill for Bugsink volume
- Future — evaluate HyperDX if we decide we also want OTel tracing
