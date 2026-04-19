# `src/lib/apiResponse.ts`

## Purpose
The canonical HTTP response helper for all Next.js API routes — wraps `NextApiResponse` with typed, consistently-shaped JSON envelopes.

## Key exports

- `apiResponse` — convenience object (bound methods) — **use this everywhere in route handlers**
  - `apiResponse.success(res, data, message?, statusCode?, meta?)` — 200 with `{ success: true, data, meta }`
  - `apiResponse.created(res, data, message?)` — 201
  - `apiResponse.noContent(res)` — 204 (no body)
  - `apiResponse.paginated(res, data[], { page, pageSize, total }, message?)` — adds `pagination.totalPages`
  - `apiResponse.badRequest(res, message, details?)` — 400
  - `apiResponse.validationError(res, errors, message?)` — 422 with field-level `details`
  - `apiResponse.notFound(res, resource, identifier?)` — 404 with human message
  - `apiResponse.unauthorized(res, message?)` — 401
  - `apiResponse.forbidden(res, message?)` — 403
  - `apiResponse.methodNotAllowed(res, method, allowedMethods[])` — 405 + `Allow` header
  - `apiResponse.internalError(res, error, detailedMessage?)` — 500; in prod hides stack
  - `apiResponse.tooManyRequests(res, message?)` — 429
  - `apiResponse.databaseError(res, error, message?)` — 500; in prod hides original message
  - `apiResponse.setCorsHeaders(res, origin?, methods?, headers?)` — sets `Access-Control-*`
  - `apiResponse.handleOptions(req, res)` — answers CORS preflight

- `ApiResponseHelper` — static class backing `apiResponse`; import for custom extensions
- `ErrorCode` — re-exported enum (source: `apiResponse.types.ts`)
- `STATUS_CODE_MAP` — re-exported mapping `ErrorCode → HTTP status`
- Response type aliases: `ApiSuccessResponse<T>`, `ApiErrorResponse`, `ApiPaginatedResponse<T>`, `ApiResponse<T>`

## Dependencies
- `@/lib/logger` — logs errors internally via `log.error`
- `./apiResponse.types` — `ErrorCode`, `STATUS_CODE_MAP`, and response type definitions (split out to stay under 300-line limit)

## Critical notes
- **All route handlers must use this** — never call `res.json()` directly; the shaped envelope is what clients expect.
- **Client-side unwrapping**: always read `json.data.field` not `json.field`; the `data` wrapper is always present on success.
- **CORS allowlist is hardcoded**: `app.isaflow.co.za`, `admin.isaflow.co.za`, `isaflow.co.za` (+ `localhost:3101/3004` in dev). Adding a new origin requires editing both `apiResponse.ts` and `api-error-handler.ts`.
- **`internalError` and `databaseError` redact** stack traces in production — never pass sensitive context as `detailedMessage` expecting it to reach the client in prod.
- `ErrorCode.VALIDATION_ERROR` → 422; `ErrorCode.BAD_REQUEST` → 400; don't mix them up.
- `paginated` adds a `pagination` key at the top level of the response, not inside `data`.
