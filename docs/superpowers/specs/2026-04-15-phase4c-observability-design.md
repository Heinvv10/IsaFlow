# Phase 4C — Observability Design

**Date:** 2026-04-15
**Status:** Draft for review
**Follows:** Phase 4B security hardening (`docs/audits/2026-04-15/phase4b-closeout.md`)
**Precedes:** Phase 4D ops readiness

## Goal

Make every request observable: one correlated ID threads through all logs from that request, one structured row per request summarizes it, slow queries surface themselves into that same correlated stream, and a health endpoint pair lets load balancers and on-call humans each get what they need.

Nothing gets shipped off-box — structured JSON on stdout is the output. Log shipping / alerting wiring is a Phase 4D (or later) infra concern. This phase is purely about *producing* the right signal.

## Non-goals

- Log aggregator selection or installation (Loki / ELK / Datadog).
- Prometheus `/metrics` endpoint.
- OpenTelemetry tracing / distributed spans — that is part of the deferred multi-project error-tracker initiative (task #53).
- Sampling, log rate-limiting, or PII redaction beyond the slow-query preview case.
- Any change to existing `log.info` / `log.error` call sites.

## Architecture

Four additive workstreams, all independent, all behind-the-scenes:

### 1. Request correlation via AsyncLocalStorage

`AsyncLocalStorage<{ requestId: string }>` initialized once per request inside `withErrorHandler`. A ULID is generated on entry. Any `log.*` call anywhere in the request's async tree reads the ID out of ALS and stamps it into the log payload. No caller changes.

Outside an ALS context (background jobs, tests) `getRequestId()` returns `undefined` and the logger simply omits the field.

### 2. Standard-shape request log

One structured line emitted in `withErrorHandler`'s `finally`:

```json
{
  "event": "request_completed",
  "requestId": "01J...",
  "route": "/api/accounting/bank-transactions-action",
  "method": "POST",
  "status": 200,
  "durationMs": 47,
  "userId": "uuid|null",
  "companyId": "uuid|null",
  "outcome": "ok|client_error|server_error"
}
```

This is the canonical row that future dashboards / alerts attach to. Existing per-step `log.info/error` calls continue to fire — this is additive.

### 3. Slow-query timing shim

`src/lib/neon.ts` wraps the `sql` tagged-template execution with timing. Queries exceeding `SLOW_QUERY_MS_THRESHOLD` (default 500ms) emit:

```json
{
  "event": "slow_query",
  "level": "warn",
  "requestId": "01J...",
  "sql": "SELECT id, amount FROM bank_transactions WHERE company_id = ? AND ...",
  "durationMs": 847
}
```

SQL preview is the *template* portion only (joined strings separated by `?`), parameter values redacted. First 120 chars.

### 4. Health endpoint pair

- `pages/api/health.ts` — shallow. `SELECT 1` + uptime. No auth, no CSRF, no `withCompany`. Target <50ms. 200 when DB reachable, 503 when not. For load-balancer liveness probes.
- `pages/api/health/deep.ts` — deepcheck. DB + SMTP verify + Stitch ping, each wrapped in `Promise.race` with a 2s timeout (`HEALTH_CHECK_TIMEOUT_MS`). Returns `{ status: 'ok'|'degraded'|'down', checks: { db, smtp, stitch } }`. 503 only when DB itself is down; SMTP/Stitch failures downgrade to `degraded` with 200. For on-call humans + scheduled external checks.

## Files

**New:**
- `src/lib/observability/requestContext.ts`
- `src/lib/observability/requestLogger.ts`
- `pages/api/health.ts` (replace if present)
- `pages/api/health/deep.ts`
- `tests/unit/observability/requestContext.test.ts`
- `tests/unit/observability/slowQuery.test.ts`
- `tests/integration/api/health.test.ts`

**Modified:**
- `src/lib/logger.ts` — reads `getRequestId()`, stamps into payload. Backward compatible.
- `src/lib/api-error-handler.ts` — wraps handler in `runWithRequestContext`, captures start, calls `logRequestCompleted` in `finally`.
- `src/lib/neon.ts` — timing shim + slow-query log.

**Env:**
- `SLOW_QUERY_MS_THRESHOLD` (default 500)
- `HEALTH_CHECK_TIMEOUT_MS` (default 2000)

**New dependency:** `ulid` (~2KB).

## Data flow

```
HTTP request
  ↓
withCompany → withErrorHandler
  ↓ runWithRequestContext({ requestId: ulid() })
  ↓   start = Date.now()
  ↓   try { handler(req, res) }           ← log.* auto-stamp requestId
  ↓        └ sql queries time themselves  ← slow_query warn shares requestId
  ↓   finally { logRequestCompleted(...) } ← one structured row per request
  ↓
Response
```

Health endpoints bypass `withCompany` but still go through `withErrorHandler`, so they get requestIds and the standard-shape request log like everything else.

## Error handling & edge cases

- **ALS missing context:** `getRequestId()` → `undefined`; logger omits the field. No throw.
- **Timing shim failure:** query result must surface regardless. Timing wrapped in try/catch that swallows observability errors.
- **SQL preview redaction:** template-only, never param values. Prevents PII/secrets leaking.
- **Health deepcheck slow dep:** per-check `Promise.race` with 2s timeout. Slow SMTP → `degraded`, not hung request.
- **Health shallow endpoint:** no middleware, no auth, no CSRF. Must stay <50ms.
- **Log volume:** one line/request is fine at current traffic. Sampling is a Phase 5+ concern.

## Testing

- **requestContext** — ALS propagation across async boundaries (setTimeout, nested async, Promise chains).
- **requestLogger** — shape assertion; `durationMs` numeric; `outcome` maps correctly for 2xx/4xx/5xx.
- **logger stamping** — inside `runWithRequestContext` → payload has requestId; outside → no requestId field.
- **slow-query shim** — fast query → no warn; mocked slow query → warn emitted with redacted preview and requestId.
- **health shallow** — returns 200 `{ status: 'ok', db: 'ok' }`, <50ms.
- **health deep** — DB ok + SMTP timeout → 200 `degraded`; DB fail → 503; all ok → 200 `ok`.
- **regression** — full suite green (1855+).

## Scope cuts (YAGNI)

- No log shipping, no aggregator choice.
- No sampling, no log rate-limiting.
- No `/metrics` Prometheus endpoint.
- No OpenTelemetry spans.
- Existing `log.*` call sites untouched.

## Success criteria

1. Every response has a request-completion log line with the standard shape.
2. Grepping a single `requestId` in stdout returns every log line (including slow-query warns) from that request.
3. Queries exceeding threshold surface without caller action.
4. `GET /api/health` returns <50ms, 200 or 503.
5. `GET /api/health/deep` returns accurate per-dep status with no request exceeding 2× timeout.
6. `tsc --noEmit` exit 0; full test suite green.

## Follow-ups (out of scope for 4C)

- Phase 4D: pick a log aggregator and wire stdout → aggregator.
- Phase 4D: alert rules on `outcome=server_error` and `slow_query` volume.
- Task #53: multi-project self-hosted error tracker (SigNoz + Claude webhook).
