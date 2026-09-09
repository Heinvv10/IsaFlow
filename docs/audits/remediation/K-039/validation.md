# K-039 — Practice rate-override writes and billing reads use different columns

**Claim (A C2 + B F11, critical):** The service writes `staff_user_id`/`rate_per_hour` while
`resolveRate` reads the still-NOT NULL legacy `user_id`/`rate`, so overrides fail or are ignored.

**Corrected trigger:** Both halves hold, and the first is absolute rather than conditional:
the INSERT does not fail *sometimes*, it fails *always* with a 23502 not-null violation. No
client rate override can be created through the API at all.

## Disposition: confirmed

## Evidence (`git show ebeac9ca:<path>`; neither service file changed since 5661d6f0)
- Fixture (production) schema `\d practice_client_rate_overrides`:
  `user_id uuid NOT NULL`, `rate numeric(12,2) NOT NULL`, plus the added nullable
  `staff_user_id uuid` and `rate_per_hour numeric(10,2)`.
- `scripts/migrations/sql/395_practice_client_rate_overrides.sql` adds the new columns and
  back-fills them once, but never drops the legacy NOT NULLs and never adds a trigger or
  default to keep the pairs in sync afterwards.
- Write side: `practice/practiceClientRateOverrideService.ts:92-99` inserts
  `(company_id, client_id, staff_user_id, rate_per_hour, effective_from, effective_to, notes)`
  — neither `user_id` nor `rate`.
- Read side: `practice/practiceStaffRateService.ts:111-114`
  `SELECT rate ... WHERE user_id = $2`. `rate_per_hour`/`staff_user_id` are never read.
- Two services define `createClientRateOverride`. The legacy one
  (`practiceStaffRateService.ts:145-159`, correct columns) is exported but **not wired to any
  route**; `pages/api/accounting/practice/staff-rates.ts` imports only
  `listStaffRates`/`createStaffRate`.

## Reachability
`POST /api/accounting/practice/clients/[id]/rate-overrides`
(`pages/api/accounting/practice/clients/[id]/rate-overrides.ts:71`, wrapped
`withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))`) is the sole creation path and
calls the broken service. Billing consumers of `resolveRate`:
`practiceTimeEntryService.ts:111,189`, `practiceTimeEntryWorkflow.ts:127`,
`src/lib/mcp/tools/writePracticeTime.ts:165`, `pages/api/accounting/practice/rate-resolve.ts`.

## RED test
`tests/integration/k-039-practice-rate-override-column-mismatch.int.test.ts` — real Postgres,
2 tests, 2 failed.
1. `createClientRateOverride` → `null value in column "user_id" ... violates not-null
   constraint` at `practiceClientRateOverrideService.ts:97`.
2. A row carrying `rate_per_hour = 999` with legacy `rate = 0` resolves to `0`, proving the
   read side ignores the new column. Output in `red.log`.

## Proposed minimal fix
Migration (next unused prefix): `ALTER TABLE practice_client_rate_overrides ALTER COLUMN
user_id DROP NOT NULL, ALTER COLUMN rate DROP NOT NULL;` then back-fill the new pair from the
legacy pair for any remaining NULLs. In `practiceStaffRateService.ts:111-114` change the
override lookup to `SELECT COALESCE(rate_per_hour, rate) AS rate ... WHERE
COALESCE(staff_user_id, user_id) = $2`. Preferred over widening the INSERT because it also
repairs rows written either way and leaves one canonical read. Do not drop the legacy columns
in the same change.

## Historical-data impact
No override has ever been written through the API — every attempt raised 23502 — so no time
entry was billed at a *wrong* override rate; all fell through to `practice_staff_rates`, the
intended fallback. The exposure is missing overrides, not incorrect ones: work that should
have carried a client-specific rate was billed at the staff default. Read-only check:
```sql
SELECT company_id, count(*) AS rows,
       count(*) FILTER (WHERE staff_user_id IS DISTINCT FROM user_id) AS user_mismatch,
       count(*) FILTER (WHERE rate_per_hour IS DISTINCT FROM rate)    AS rate_mismatch
FROM practice_client_rate_overrides GROUP BY company_id;
```
A non-zero `rate_mismatch` names a row whose intended rate was never applied.

## Risks
Dropping NOT NULL is hard to reverse once NULLs exist. The COALESCE read covers the only
current consumer; grep `practice_client_rate_overrides` before merging in case a parallel
branch added another reader.
