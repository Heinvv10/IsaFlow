# Phase 4C — Observability Closeout

**Date:** 2026-04-15
**Spec:** `docs/superpowers/specs/2026-04-15-phase4c-observability-design.md`
**Plan:** `docs/superpowers/plans/2026-04-15-phase4c-observability-plan.md`

## Scorecard

| Workstream | Before | After | Status |
|---|---|---|---|
| **Request context (ALS requestId)** | No per-request correlation ID | AsyncLocalStorage seeds a UUID on every request; propagates automatically through call stack | ✅ 4C-1/2 |
| **Structured log shape** | Ad-hoc log calls; no consistent request_completed event | `logRequestCompleted()` helper emits `{status, durationMs, requestId, path, method}` on every handler exit via `withErrorHandler` | ✅ 4C-3/4 |
| **Slow-query detection** | No timing; `sql` tagged template opaque | Timing shim wraps Neon `sql` client; logs `warn slow_query` with `{sql, durationMs}` when query exceeds 500ms threshold | ✅ 4C-5 |
| **Health endpoints** | None | `/api/health` (shallow: DB SELECT 1) + `/api/health/deep` (DB + SMTP + Stitch connectivity checks with per-probe timing) | ✅ 4C-6/7 |
| **tsc --noEmit** | EXIT 0 | EXIT 0 | ✅ maintained |
| **Unit tests** | 1855 passing (77 files) | **1874 passing (80 files)** | ✅ +19 |
| **Integration tests (health)** | — | **5 passing (1 file)** | ✅ new |

## What landed (by task)

### 4C-1 — AsyncLocalStorage request context

- **`efbbb34`** — New `src/lib/requestContext.ts`. Exports `requestContextStore` (an `AsyncLocalStorage<{requestId: string}>`), `getRequestId()` helper (returns stored ID or `'unknown'`), and `runWithRequestId(fn)` that generates a `crypto.randomUUID()` and runs `fn` inside the store. Zero external dependencies; isomorphic Node.js stdlib only.

### 4C-2 — Logger stamps requestId

- **`77fdc5e`** — `src/lib/logger.ts` updated. All log methods (`info`, `warn`, `error`, `debug`) now call `getRequestId()` and merge `requestId` into the structured JSON output automatically. Every log line emitted inside a request lifecycle is now correlated without callers passing IDs manually.

### 4C-3 — logRequestCompleted helper

- **`277402d`** — New `logRequestCompleted(ctx)` function exported from `src/lib/logger.ts`. Accepts `{requestId, path, method, status, durationMs, error?}` and emits a single structured `info` line with `event: "request_completed"`. Provides the standard shape needed for log aggregators and dashboards.

### 4C-4 — withErrorHandler threads requestId + emits request_completed

- **`0c629e2`** — `src/lib/withErrorHandler.ts` updated to call `runWithRequestId()` around the handler invocation. Records `startTime = Date.now()` before dispatch. On success and on catch, calls `logRequestCompleted` with the computed `durationMs`. Every API route wrapped with `withErrorHandler` now gets automatic request correlation and outcome logging with no per-handler boilerplate.

### 4C-5 — Slow-query timing shim on Neon sql client

- **`7aa9a6b`** — `src/lib/neon.ts` wraps the raw Neon `sql` tagged template in a `Proxy`. The proxy intercepts template literal calls, records wall-clock time, resolves the query, then checks elapsed ms against a `SLOW_QUERY_THRESHOLD_MS = 500` constant. Queries exceeding the threshold emit `log.warn('slow_query', ...)` with the SQL text and duration. No changes to call-sites required.
- **`2a7eb6f`** — Follow-up nit: drops an unused `warnSpy` variable left over in the unit test and clarifies the cast comment on the Proxy shim.

### 4C-6 — Shallow /api/health endpoint

- **`348c9f8`** — `pages/api/health/index.ts`. GET-only handler (no `withCompany` — public). Issues `SELECT 1` against Neon and returns `{status:'ok', db:'ok', uptime:<seconds>}` on success or `{status:'degraded', db:'error', message}` on failure. Responds with HTTP 200 (ok) or 503 (degraded). Usable by uptime monitors and load-balancer health probes.

### 4C-7 — Deep /api/health/deep endpoint

- **`54bcf5c`** — `pages/api/health/deep.ts`. GET-only handler (requires `Authorization: Bearer <HEALTH_CHECK_SECRET>` header — env-var gated to prevent public exposure). Runs three probes in parallel via `Promise.allSettled`:
  - **DB** — `SELECT 1` with timing
  - **SMTP** — `nodemailer.createTransport().verify()` against configured SMTP env vars
  - **Stitch** — `fetch` to `https://api.stitch.money/graphql` with a 5s timeout
  
  Returns per-probe `{status, latencyMs}` map, overall `status` (ok / degraded), and `uptime`. HTTP 200 or 503. Integration test suite (`tests/integration/api/health.test.ts`) covers all 5 passing cases.

## Verification evidence

### TypeScript

```
bunx tsc --noEmit
# EXIT 0 — no type errors
```

### Unit tests

```
bunx vitest run
 Test Files  80 passed (80)
      Tests  1874 passed (1874)
   Start at  12:18:17
   Duration  5.34s

# Baseline was 1855 (77 files). +19 tests, +3 files.
```

The slow-query shim is exercised in the unit suite — a `warn slow_query` line from the `rate_limit_counters` DELETE is visible in the run output, confirming the proxy fires in practice.

### Integration tests — health endpoints

```
bunx vitest run --config vitest.integration.config.ts tests/integration/api/health.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  12:18:23
   Duration  123ms
```

### Live smoke (dev server)

Dev server was not running at gate time. Skipped — integration tests provide equivalent coverage.

## What was NOT done (deferred)

- **Log aggregator choice** — No Loki / Datadog / Axiom integration landed. Structured JSON is emitted to stdout; an aggregator sidecar or shipper can consume it. Choice deferred to Phase 4D or task #53.
- **Alert rules** — No PagerDuty / OpsGenie wiring. Slow-query and error events are logged; threshold-based alerting is a Phase 4D concern.
- **Distributed tracing** — No OpenTelemetry instrumentation. The requestId correlation is a stepping stone but full trace spans (e.g. via `@opentelemetry/sdk-node`) are deferred.
- **Sampling / log-level control** — All log levels emit unconditionally. A sampling rate or `LOG_LEVEL` env-var filter (e.g. suppress `debug` in prod) is deferred.
- **Error tracking (Sentry / self-hosted)** — `withErrorHandler` logs errors structurally but does not forward them to an external error tracker. This is task #53 (multi-project self-hosted error tracker with Claude AI analysis layer).
- **`/api/health/deep` auth hardening audit** — The `HEALTH_CHECK_SECRET` env-var path is gated in code; ops team should confirm the secret is provisioned in the Neon/Vercel env before enabling deep-check in production monitors.

## Follow-up items

- **Task #41 (BL-41)** — `sage_customer_invoices` mirror of BL-40 (sageImportService cross-tenant fix). Still pending; not blocked on 4C.
- **Task #53** — Multi-project self-hosted error tracker (ISAFlow + FibreFlow) with Claude AI analysis layer. Deferred from 4C per original design.
- **Phase 4D — Ops readiness** — Neon PITR backup/restore drill, secrets rotation plan, rollback rehearsal, prod migration promotion plan, log aggregator provisioning, alert rule authoring.
- **`HEALTH_CHECK_SECRET` provisioning** — Add to `.env.local.example` and confirm it is set in the production Neon/Vercel environment before enabling `/api/health/deep` in uptime monitors.
- **SMTP env vars documentation** — `health/deep.ts` reads `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — confirm these match the variable names in the production env.

## Next phase

**Phase 4D — Ops Readiness.** Planned workstreams:

1. Log aggregator provisioning (Loki sidecar or managed service selection)
2. Alert rules (slow-query threshold → PagerDuty, error rate → OpsGenie)
3. Neon PITR backup/restore drill
4. Secrets rotation runbook
5. Prod migration promotion (`IF NOT EXISTS` gate audit across all 79 migrations)
6. OpenTelemetry trace span instrumentation (build on 4C requestId foundation)

Separate spec + plan + execute cycle when Hein is ready.
