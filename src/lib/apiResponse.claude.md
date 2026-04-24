# apiResponse.ts

## Purpose
`ApiResponseHelper` class + `apiResponse` convenience export — the canonical way to send every API response (success, paginated, error variants) with consistent envelope shape and meta.

## Key exports
- Re-exports types/enum from `./apiResponse.types`: `ApiSuccessResponse`, `ApiErrorResponse`, `ApiPaginatedResponse`, `ApiResponse`, `ErrorCode`, `STATUS_CODE_MAP`
- `class ApiResponseHelper` with static methods:
  - `success<T>(res, data, message?, statusCode?=200, meta?)`, `created<T>(res, data, message?, meta?)`, `noContent(res)`
  - `paginated<T>(res, data, {page, pageSize, total}, message?, meta?)` — auto-computes `totalPages`
  - `error(res, code: ErrorCode, message, details?, meta?)` — status derived from `STATUS_CODE_MAP`
  - `badRequest(res, message, details?)`, `badRequestFromError(res, error, publicMessage)` — the second logs the raw error and only surfaces `publicMessage` in prod (H16)
  - `validationError(res, errors, message?)`, `notFound(res, resource, identifier?)`, `unauthorized(res, message?)`, `forbidden(res, message?)`
  - `paymentRequired(res, {balance, required, operationCode?}, message?)` — PAYG insufficient Flows (402)
  - `methodNotAllowed(res, method, allowedMethods[])` — sets `Allow` header
  - `internalError(res, error, detailedMessage?)`, `databaseError(res, error, message?)` — log full error, mask details in prod
  - `tooManyRequests(res, message?)` — 429
  - `setCorsHeaders(res, origin, methods?, headers?)`, `handleOptions(req, res)` — CORS plumbing via `safeCorsOrigin`
- `const apiResponse` — bound method shortcuts for every helper; also default export

## Dependencies
- `./apiResponse.types` — type+enum definitions (split to meet 300-line cap)
- `@/lib/cors` — `safeCorsOrigin` (pentest M11 single-source allow-list)
- `@/lib/logger`

## Critical notes
- **Client-side unwrapping**: always read `json.data.field`, never `json.field`. `data` is always present on success envelopes.
- **Pentest H16**: `badRequestFromError`, `internalError`, `databaseError` never leak raw `err.message` in production — only `publicMessage`/`message` is returned. Dev builds include `originalMessage` + `stack` in `details`. Always use these helpers for caught exceptions, never `badRequest(res, err.message)`.
- `details` field is only populated when `NODE_ENV === 'development'`.
- Every response auto-stamps `meta.timestamp` (ISO 8601). Callers pass additional meta via the last arg.
- `paymentRequired` response body contains `error.details.reason === 'insufficient_flows'` — the PAYG frontend pattern-matches on that string to trigger the top-up modal.
- CORS: `setCorsHeaders` no-ops when the origin is not in the allow-list; do not echo unvetted origins. Always use `safeCorsOrigin`, never hardcode.
- `paginated` adds `pagination` at the top level of the envelope, not inside `data`.
- The `apiResponse` convenience export binds each method to the class — destructure-safe.
- Legacy `api-error-handler.ts` has a different envelope (`data: null` on error); don't mix the two. New code uses **this** module.

## Recent changes
- 2026-04-24: Pentest M10–M23 CORS dedupe; Critical+High batch added `badRequestFromError`; PAYG Phase 1 introduced `paymentRequired` and `ErrorCode.PAYMENT_REQUIRED`.
