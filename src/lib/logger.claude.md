# `src/lib/logger.ts`

## Purpose
Project-wide structured logger — replaces all `console.*` calls; writes JSON lines to stdout/stderr on the server (journald-visible) and to an in-memory ring buffer in the browser.

## Key exports

- `log` — singleton `Logger` instance; primary import for all application code
  - `log.debug(message, data?, component?)`
  - `log.info(message, data?, component?)`
  - `log.warn(message, data?, component?)`
  - `log.error(message, data?, component?)`
  - `log.getLogs()` / `log.getRecentLogs(count?)` / `log.exportLogs()` — dev-only introspection
  - `log.clearLogs()`

- `createLogger(component) → { debug, info, warn, error }` — returns a component-scoped logger where every call auto-fills `component`; preferred pattern for services and modules.

- `apiLogger` — Pino-style adapter with signature `(data, message?)` (data-first); used by `api-error-handler.ts` and API routes that log structured request metadata.

- `Logger` — exported class for constructing custom instances with non-default options.
- `LogEntry`, `LogData`, `LoggerOptions` — type exports.

## Dependencies
- `@/lib/observability/requestContext` — `getRequestId()` to attach the current request ID to every server-side log line.

## Critical notes
- **Zero Tolerance**: `console.log` / `console.error` etc. are forbidden project-wide — always use `log.*` or `createLogger`.
- **Server output format**: each line is `JSON.stringify({ level, message, timestamp, component, requestId?, data? })`. `error`/`warn` → stderr; `info`/`debug` → stdout.
- **Browser**: logs are stored in `window.__appLogs` (capped at 1 000 entries). They are NOT sent anywhere in production — add a remote transport if telemetry is needed.
- **Default log level**: `info` in all environments. Debug calls are silently dropped unless the Logger is constructed with `level: 'debug'`.
- **`apiLogger` vs `log`**: `apiLogger` uses `(data, message?)` order (data-first, Pino convention); `log.*` uses `(message, data?, component?)`. Don't mix the signatures.
- **Ring buffer**: the in-memory ring (1 000 entries, both browser and Node) is a last-resort debugging aid; it is not a substitute for structured log drains in production.
