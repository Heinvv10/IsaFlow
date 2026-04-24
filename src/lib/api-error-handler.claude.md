# api-error-handler.ts

## Purpose
`withErrorHandler` — the outermost wrapper for every API handler. Installs the request-id, CORS headers, request-context ALS, Sentry isolation scope, structured request/response logging, and the top-level try/catch.

## Key exports
- `withErrorHandler(handler): NextApiHandler` — wraps a handler function `(req, res) => unknown`. Generic `req` accepts `AuthenticatedNextApiRequest`, `CompanyAuthedRequest`, or plain `NextApiRequest` without `as any`
- `successResponse<T>(data, message?): ApiSuccessResponse<T>` — legacy envelope builder
- `errorResponse(message, code?, details?): ApiErrorResponse` — legacy envelope builder; `details` only included in dev
- `const HttpErrors` — convenience builders: `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `MethodNotAllowed(method)`, `InternalServerError`, `DatabaseError`, `ValidationError(message, details)`
- `interface ApiErrorResponse`, `interface ApiSuccessResponse<T>`, `type ApiResponse<T>` — legacy envelope shapes (note: `data: null` on error, differs from `apiResponse.ts`)

## Dependencies
- `@sentry/nextjs` — gated behind `SENTRY_ENABLED === 'true'`; uses `Sentry.withIsolationScope` so tenant tags stay per-request
- `@/lib/observability/requestContext` — `runWithRequestContext`, `generateRequestId`
- `@/lib/observability/requestLogger` — `logRequestCompleted`
- `@/lib/sentry/tags` — `setTenantTags`, `sanitizeRoute`
- `@/lib/cors` — `safeCorsOrigin` (pentest M11 single-source CORS)
- `@/lib/logger` — `apiLogger`

## Critical notes
- **Wrap order convention**: `withCompany(withErrorHandler(handler as any))`. `withErrorHandler` is the inner wrapper so it catches errors from the auth layer too.
- `res` parameter is typed as `NextApiResponse<any>` so callers that declare `res: NextApiResponse` (no type arg) remain assignable. This is the only sanctioned `any` in the wrapper.
- BL-53: nests a fresh Sentry isolation scope so `setTenantTags` never writes to the global hub, even if withAuth is absent or wrap order is reversed.
- Request body logger redacts `password`, `confirmPassword`, `password_hash`, `token`, `secret`, `apiKey`, `api_key` via `sanitizeBody` before emitting. Add new sensitive keys to `SENSITIVE_KEYS`.
- 500 responses **mask internal details in production** (`An unexpected error occurred`). Dev mode includes message + stack in `details`. Pentest compliance — do not leak raw `err.message` to clients.
- Sentry.captureException is skipped if `SENTRY_ENABLED !== 'true'`.
- `res.headersSent` guard prevents double-send when a handler already responded before throwing.
- `finally` always emits `logRequestCompleted` with `userId`/`companyId` read off `req` (populated by `withAuth`).
- CORS uses `safeCorsOrigin` — never re-inline origin strings here (pentest M11: allow-list previously duplicated across two files).

## Recent changes
- 2026-04-24: Pentest M10–M23 batch hardened CORS and moved allow-list to `src/lib/cors.ts`.
- 2026-04-18: withAuth codemod — handler generic changed so `withCompany`/`withUserAuth` no longer need `as any` casts.
- 2026-04-15: BL-53 defensive isolation scope + sanitised route tag.
