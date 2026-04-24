# apiResponse.types.ts

## Purpose
Shared type definitions and error-code enum for the API response envelope, split out of `apiResponse.ts` to respect the 300-line file cap.

## Key exports
- `interface ApiSuccessResponse<T>` — `{ success: true; data: T; message?; meta? }`
- `interface ApiErrorResponse` — `{ success: false; error: { code; message; details? }; meta? }`
- `interface ApiPaginatedResponse<T>` extends `ApiSuccessResponse<T[]>` with `pagination: { page, pageSize, total, totalPages }`
- `type ApiResponse<T>` — union of success/error
- `enum ErrorCode` — `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `CONFLICT`, `VALIDATION_ERROR`, `RATE_LIMIT`, `PAYLOAD_TOO_LARGE`, `PAYMENT_REQUIRED`, `INTERNAL_ERROR`, `DATABASE_ERROR`, `SERVICE_UNAVAILABLE`, `GATEWAY_TIMEOUT`, `BUSINESS_RULE_VIOLATION`, `INSUFFICIENT_PERMISSIONS`, `RESOURCE_LOCKED`, `DEPENDENCY_ERROR`
- `const STATUS_CODE_MAP: Record<ErrorCode, number>` — canonical ErrorCode → HTTP status mapping

## Dependencies
None (pure types).

## Critical notes
- Do not import the helper class from this file — only types. `ApiResponseHelper` lives in `apiResponse.ts`.
- `PAYMENT_REQUIRED` (402) is reserved for PAYG Flow wallet insufficient-balance responses.
- `RESOURCE_LOCKED` maps to 423, `DEPENDENCY_ERROR` to 424 — both uncommon; use when calling a downstream service that failed.
- `VALIDATION_ERROR` maps to 422, not 400.

## Recent changes
- 2026-04-24: Split from apiResponse.ts during PAYG Phase 1; adds `PAYMENT_REQUIRED` code.
