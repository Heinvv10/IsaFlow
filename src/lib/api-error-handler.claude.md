# `src/lib/api-error-handler.ts`

## Purpose
Express-style middleware wrapper (`withErrorHandler`) that adds request/response logging, CORS headers, Sentry capture, and a uniform 500 fallback to any Next.js API handler.

## Key exports

- `withErrorHandler(handler) → NextApiHandler` — **wraps every API route**; sets `X-Request-Id`, logs request + response, catches unhandled throws and returns `{ success: false, data: null, message, code }`.
- `successResponse<T>(data, message?) → ApiSuccessResponse<T>` — builds a plain response object without sending it (useful for testing or composing).
- `errorResponse(message, code?, details?) → ApiErrorResponse` — builds plain error object; `details` is suppressed in production.
- `HttpErrors` — factory map for common errors: `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `MethodNotAllowed`, `InternalServerError`, `DatabaseError`, `ValidationError`.
- `ApiErrorResponse`, `ApiSuccessResponse<T>`, `ApiResponse<T>` — re-exported response type interfaces.

## Dependencies
- `@sentry/nextjs` — captures unhandled exceptions when `SENTRY_ENABLED=true`
- `@/lib/logger` — `apiLogger` for structured request/response logging
- `@/lib/observability/requestContext` — `runWithRequestContext`, `generateRequestId`
- `@/lib/observability/requestLogger` — `logRequestCompleted` in `finally`
- `@/lib/sentry/tags` — `setTenantTags`, `sanitizeRoute`

## Critical notes
- **Mandatory wrap order**: `withCompany(withErrorHandler(handler as any))` — `withCompany` must be outermost so auth runs before the handler.
- **Sensitive key scrubbing**: `sanitizeBody` redacts `password`, `confirmPassword`, `password_hash`, `token`, `secret`, `apiKey`, `api_key` from logged request bodies. Add new sensitive keys to `SENSITIVE_KEYS`.
- **Production masking**: unhandled errors are returned as `"An unexpected error occurred"` — the real message is only logged server-side and sent to Sentry.
- **CORS allowlist** is duplicated here (separate from `apiResponse.ts`) — must stay in sync when adding origins.
- **Sentry isolation scope**: each request runs in `Sentry.withIsolationScope` when enabled, preventing cross-request tag leakage.
- `withErrorHandler` accepts `any` for `req` to accommodate `CompanyAuthedRequest` / `AuthenticatedNextApiRequest` subtypes without `as any` at each call site.
- `logRequestCompleted` reads `req.user.id` and `req.companyId` if available — these are set by `withCompany`/`withAuth` middleware upstream.
