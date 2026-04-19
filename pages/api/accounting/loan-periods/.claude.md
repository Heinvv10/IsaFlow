# Loan Periods API routes

Loan period locking for the PRD-03 loan module. Closing a period posts current-portion reclassification journals for all active loans and inserts a `loan_period_locks` row to prevent further GL postings for that period. Delegates to `services/loans/loanPeriodCloseService.ts`.

## Endpoints

| Method + path | Handler | Purpose |
|---|---|---|
| `GET /api/accounting/loan-periods/[yyyymm]/close` | `[yyyymm]/close.ts` | Check whether the period is already locked. Response: `{ yyyymm, locked: bool }`. |
| `POST /api/accounting/loan-periods/[yyyymm]/close` | `[yyyymm]/close.ts` | Close the period — post reclassification journals and lock. Returns 201 with the close result. |

## Auth

`withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))` — full write-access chain. Only `owner | admin | manager` roles may call POST.

## Response contract

GET → `apiResponse.success`. POST → `apiResponse.created`. Errors use `apiResponse.badRequest` / `.notFound` from the service layer.

## Business rules / gotchas

- `yyyymm` must be exactly 6 digits (e.g. `202604`) — validated with `/^\d{6}$/`; returns 400 otherwise.
- A second POST to an already-locked period returns 500 with "already locked" from the service — callers in recovery flows should treat this as a success-equivalent (idempotent at the business level but not at the HTTP level).
- Sibling routes for the loans module: `loan-rate-curves/` and `loans/`.
