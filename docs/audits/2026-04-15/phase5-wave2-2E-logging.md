# Phase 5 — Wave 2 Stream 2E: Logging/Sentry Coverage

**Date:** 2026-04-15
**Auditor:** Claude Sonnet 4.6 (automated read-only sweep)
**Scope:** `src/` and `pages/` (excluding `*.test.*` / `*.spec.*`)

## Summary

| Finding type | Count | Severity |
|---|---|---|
| Empty catch blocks | 0 | — |
| Silent swallows (no log, no throw, no user notification) | 0 | — |
| P1-adjacent: UI catch blocks using `notify.error` only (no server log) | 11 | P3 (acceptable — browser-only hooks) |
| P1-adjacent: Retry-loop swallow that re-throws after final attempt | 1 | P3 (by design — `neon.ts`) |
| console.* leaks | 0 | — |
| Sentry wiring | **OK** | — |

**Overall status: CLEAN.** No P0/P1/P2 findings. All catch blocks log, notify, push to error arrays, or re-throw.

---

## Empty catch blocks

No empty catch blocks found.

```
rg -n --multiline "catch\s*\(\s*\w*\s*\)\s*\{\s*\}" src pages
(no output)
```

---

## Silent swallows

No truly silent catch blocks found in `src/modules/accounting/services/` or `pages/api/accounting/`.

### Detailed review of patterns that required inspection:

**1. `src/lib/neon.ts:67` — Retry-loop catch (P3 / acceptable)**
```
catch (error) {
  lastError = error;
  if (i < maxRetries - 1) { continue; }
}
// after loop:
throw lastError || new Error('Request failed after retries');
```
Does not log mid-retry (intentional — backoff loop). Always re-throws after final attempt. No silent drop.

**2. `src/lib/api-error-handler.ts:114` — Top-level error boundary catch (P3 / acceptable)**
Uses `apiLogger.error(...)` and `Sentry.captureException(error)` before returning 500. Fully instrumented.

**3. `src/components/accounting/bank-transactions/useBankTxActions.ts:98–238` — UI action hooks (P3 / acceptable)**
Eleven catch blocks call `notify.error(...)` to surface errors to the user via toast. These are browser-side React hooks — no server-side logging is possible or expected. The inner bank-rule prompt check at line 95 correctly calls `log.warn(...)`.

**4. PDF parser catch blocks (`bankPdfParserCapitec.ts:202`, `bankPdfParserNedbank.ts:114`, `bankPdfParserStandardBank.ts:176`, `bankPdfParserFnb.ts:81`) — Error accumulation (P3 / acceptable)**
Catch blocks append to a `result.errors[]` array returned to the caller. The outer `bankPdfParser.ts` dispatcher calls `log.error`/`log.warn` before returning structured error payloads.

**5. Migration services (`migrationExecuteService.ts:83`, `134`, `158`, `182`) — Error accumulation (P3 / acceptable)**
Push to `errors[]` array within a batch loop — caller reports results. No silent drop.

**6. `src/modules/accounting/services/gl/glCrossModuleHooks.ts:72` — Intentional null-return (P3 / acceptable)**
```
} catch (err) {
  log.error('Failed to post asset depreciation to GL', { assetId, error: err }, 'accounting');
  return null;
}
```
Logs with `log.error` and returns `null` per documented hook contract. Not a silent swallow.

**7. `src/modules/accounting/services/gl/yearEndService.ts:168` — Intentional warn-and-continue (P3 / acceptable)**
```
} catch (err) { log.warn('Could not load retained_earnings_account setting, using default 3200', { error: String(err) }, 'yearEnd'); }
```
Logs with `log.warn` and falls back to a safe default. Intentional degraded-mode behaviour.

---

## console.* leaks

```
rg -n "console\.(log|error|warn|info|debug)" src/ pages/ --glob '!*.test.*' --glob '!*.spec.*'
(no output)
```

Zero `console.*` calls found. BL-14 ratchet remains intact.

---

## Sentry verification

### `@sentry/nextjs` imported

- `sentry.server.config.ts` — `import * as Sentry from '@sentry/nextjs'`
- `sentry.client.config.ts` — `import * as Sentry from '@sentry/nextjs'`
- `sentry.edge.config.ts` — `import * as Sentry from '@sentry/nextjs'`
- `src/lib/api-error-handler.ts` — `import * as Sentry from '@sentry/nextjs'`
- `src/lib/sentry/tags.ts` — `import * as Sentry from '@sentry/nextjs'`
- `next.config.js` — `const { withSentryConfig } = require('@sentry/nextjs')`

**Result: YES — fully imported across all runtimes.**

### `sentry.*.config.ts` present

| File | Present | Non-trivial |
|---|---|---|
| `sentry.server.config.ts` | YES | YES — `Sentry.init(...)` with `beforeSend` scrub, `GIT_SHA` release, `SENTRY_ENABLED` gate |
| `sentry.client.config.ts` | YES | YES — `Sentry.init(...)` with browser guard, `NEXT_PUBLIC_SENTRY_ENABLED` gate |
| `sentry.edge.config.ts` | YES | YES — `Sentry.init(...)` with `SENTRY_ENABLED` gate |

### Tenant tag helper present

`src/lib/sentry/tags.ts` exports `setTenantTags(ctx)` which calls:
- `Sentry.setTag('company_id', ctx.companyId)` — tenant isolation tag
- `Sentry.setTag('request_id', ctx.requestId)` — request tracing
- `Sentry.setTag('route', ctx.route)` — route cardinality-bounded via `sanitizeRoute()`
- `Sentry.setUser({ id: ctx.userId })` — user context

Called in `src/lib/api-error-handler.ts` (`withErrorHandler`) on every API request when `SENTRY_ENABLED === 'true'`.

**Result: YES — fully implemented and wired.**

### Source maps gated

In `next.config.js`:
```js
productionBrowserSourceMaps: process.env.SENTRY_ENABLED === 'true',
```

In `withSentryConfig`:
```js
sourcemaps: {
  disable: !process.env.SENTRY_AUTH_TOKEN,
},
hideSourceMaps: true,
```

Source-map upload requires `SENTRY_AUTH_TOKEN` (disabled when absent). Browser source maps only enabled when `SENTRY_ENABLED=true`. **Result: YES — properly gated.**

### PII scrubbing

`src/lib/sentry/scrub.ts` referenced by all three config files via `beforeSend: (event, _hint) => scrubEvent(event)`. FNV-1a scrubbing active.

### Notes

- Sentry is currently **dark by default** (`SENTRY_ENABLED=false` in `.env.example`). This is intentional — opt-in per environment.
- `Sentry.captureException(error)` only fires when `SENTRY_ENABLED === 'true' && error instanceof Error` — the `instanceof Error` guard prevents non-Error throws from being swallowed silently; they still get `apiLogger.error` treatment.
- `tracesSampleRate: 0` in all configs — performance tracing disabled. Appropriate for a cost-sensitive deployment.
- Self-hosted Bugsink endpoint: `SENTRY_URL=https://errors.isaflow.co.za`. Not Sentry cloud. BL-53 end-to-end wiring confirmed intact.

---

## Recommendations

None at P0/P1/P2. Optional future improvements (P3):

1. **`useBankTxActions.ts`** — consider adding `log.warn(...)` alongside `notify.error(...)` in the 11 UI catch blocks so that browser-side errors surface in structured logs if a client-side logger is ever introduced.
2. **Retry catch in `neon.ts`** — a single `log.warn('DB query retry attempt', ...)` inside the retry loop would improve observability for flaky connection issues without breaking the backoff semantics.
