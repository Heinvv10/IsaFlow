# K-039 fix — practice client rate override writes and billing reads use one column pair

**Trigger.** `POST /api/accounting/practice/clients/[id]/rate-overrides` inserted only the
columns migration 395 added (`staff_user_id`, `rate_per_hour`) while `user_id`/`rate` from
migration 372 are still `NOT NULL`. Every create raised 23502, so no client rate override
could be stored at all. Independently, `resolveRate` filtered and returned the legacy pair,
so a row carrying only the new pair was invisible to billing.

**Before.** Create → `null value in column "user_id" ... violates not-null constraint`.
A row with `rate_per_hour = 999, rate = 0` resolved to `0`.

**After.** `createClientRateOverride` writes both pairs (`user_id = staff_user_id`,
`rate = rate_per_hour`), `updateClientRateOverride` keeps `rate` in step with
`rate_per_hour`, and `resolveRate` reads `COALESCE(rate_per_hour, rate)` filtered on
`COALESCE(staff_user_id, user_id)`. The COALESCE read also repairs rows written either way,
including by the unwired legacy `createClientRateOverride` in `practiceStaffRateService.ts`.
Every query stays scoped by `company_id`.

**Files.**
- `src/modules/accounting/services/practice/practiceClientRateOverrideService.ts` (INSERT + UPDATE)
- `src/modules/accounting/services/practice/practiceStaffRateService.ts` (`resolveRate`)
- `tests/integration/k-039-practice-rate-override-column-mismatch.int.test.ts`

**Tests.** 1 integration file, 6 tests, 6 passed against real Postgres: the validator's two RED
cases plus dual-pair write/update sync, staff-rate fallback with no override, another tenant's
override ignored for the same staff member, and an expired override window falling back on the
day after `effective_to`. Full unit suite (no `DATABASE_URL`): 9391 passed, 234 skipped.
Mutation-proof: reverting the read side gives 1 failed/5 passed; reverting the write side gives
4 failed/2 passed with 23502. `tsc --noEmit` and `eslint` clean.

**Migration / rollback.** None. The legacy `NOT NULL` constraints are left in place
deliberately — populating both pairs is reversible, dropping `NOT NULL` is not. Rollback is
`git revert`.

**Historical-data impact.** No override was ever created through the API, so no time entry was
billed at a *wrong* override rate; all fell through to `practice_staff_rates`. The exposure is
missing overrides, not incorrect ones. Read-only check for rows whose pairs disagree:
```sql
SELECT company_id, count(*) AS rows,
       count(*) FILTER (WHERE staff_user_id IS DISTINCT FROM user_id) AS user_mismatch,
       count(*) FILTER (WHERE rate_per_hour IS DISTINCT FROM rate)    AS rate_mismatch
FROM practice_client_rate_overrides GROUP BY company_id;
```

**Limits.** The duplicate `createClientRateOverride`/`listClientRateOverrides` in
`practiceStaffRateService.ts` remain (exported, unrouted); consolidating them is out of scope.
The legacy columns are not dropped, so a future migration must retire them. Not run against
production.
