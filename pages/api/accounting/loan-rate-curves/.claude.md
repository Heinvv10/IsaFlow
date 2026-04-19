# Loan Rate Curves API routes

Named interest-rate curves used by the loan schedule engine. Each curve has a type (fixed, prime-linked, JIBAR-linked, etc.) and a set of date-keyed rate points. System curves are read-only; tenant curves can be edited. Delegates to `services/loans/loanRateCurveService.ts`.

## Endpoints

| Method + path | Handler | Purpose |
|---|---|---|
| `GET /api/accounting/loan-rate-curves` | `index.ts` | List rate curves for the company (tenant + system). |
| `POST /api/accounting/loan-rate-curves` | `index.ts` | Create a tenant rate curve. Body: `RateCurveCreateInput`. Returns 201. |
| `GET /api/accounting/loan-rate-curves/[id]/points` | `[id]/points.ts` | List rate points for a curve (date + rate). |
| `POST /api/accounting/loan-rate-curves/[id]/points` | `[id]/points.ts` | Bulk upsert rate points. Body: `{ points: RatePointInput[] }`. Returns `{ count }`. Rejects writes to system curves. |

## Auth

`withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))` on all four endpoints. Only `owner | admin | manager` roles may write. GETs pass through `withWriteAccess` untouched.

## Response contract

`apiResponse.success` / `.created` / `.badRequest`. `index.ts` POST returns HTTP 201 via `apiResponse.created`. Points POST returns `{ count: number }`. Clients MUST unwrap `json.data`.

## Business rules / gotchas

- `POST .../[id]/points` rejects writes to system curves — the service checks the `is_system` flag and throws; callers receive 400.
- Points are bulk-upserted — supply the full desired set each time; individual point edits are not supported.
- Rate curve types and `RateCurveCreateInput` shape are defined in `loanRateCurveService.ts`.
