# K-039 fix — practice client rate override writes and billing reads use one column pair

**Trigger.** `POST /api/accounting/practice/clients/[id]/rate-overrides` inserted only the
columns migration 395 added (`staff_user_id`, `rate_per_hour`) while `user_id`/`rate` from
migration 372 are still `NOT NULL`. Every create raised 23502, so no client rate override
could be stored at all. Independently, `resolveRate` filtered and returned the legacy pair,
so a row carrying only the new pair was invisible to billing.

**Before.** Create → `null value in column "user_id" ... violates not-null constraint`.
A row with `rate_per_hour = 999, rate = 0` resolved to `0`.

**After.** Migration 626 adds a BEFORE INSERT/UPDATE trigger that mirrors
`staff_user_id`↔`user_id` and `rate_per_hour`↔`rate`, so no writer can leave the pairs
divergent — including the unrouted legacy writer and any writer added later. On UPDATE the
side the statement actually changed is carried across; on INSERT there is no OLD row to say
which side was meant, so the newer column is authoritative and two supplied halves that
disagree are reconciled rather than stored. The service
still fills both pairs itself, which is what keeps the route working on a database where 626
has not been applied. `updateClientRateOverride` sets `rate` only when a new rate is
supplied, so a notes-only PUT no longer rewrites a money column. `resolveRate` reads
`COALESCE(rate_per_hour, rate)` and matches `staff_user_id = $1 OR user_id = $1`, which keeps
historical rows reachable by either identifier and stays index-usable. `mapRow` and the list
SELECT fall back to the legacy pair, so a half-populated row renders at its real rate instead
of R0.00 with a null staff member. Every query stays scoped by `company_id`.

**Files.**
- `scripts/migrations/sql/626_practice_rate_override_column_mirror.sql` (mirror trigger + one-time repair)
- `src/modules/accounting/services/practice/practiceClientRateOverrideService.ts` (INSERT, UPDATE, `mapRow`, list SELECT, staff join)
- `src/modules/accounting/services/practice/practiceStaffRateService.ts` (`resolveRate`; the two unrouted duplicates marked `@deprecated`)
- `src/modules/accounting/services/practice/.claude.md` + regenerated `AGENTS.md`
- `tests/integration/k-039-practice-rate-override-column-mismatch.int.test.ts`

**Tests.** 1 integration file, 11 tests, 11 passed against real Postgres: the validator's two
RED cases, dual-pair write/update sync, staff-rate fallback, another tenant's override ignored
for the same staff member, an expired override window, a legacy-only row resolving through the
`user_id` branch, a drifted row resolving from either identifier, a legacy-only row listing at
its real rate, a notes-only update leaving the money columns alone, the trigger mirroring a
single-pair write, an INSERT supplying both halves with different values, and an UPDATE
changing both halves at once. Full unit suite (no `DATABASE_URL`): 9391 passed, 234 skipped. `tsc
--noEmit`, `eslint`, `agent-docs:check` and the migration-RLS gate all clean. Mutation results
are in `green.log`; the service-side dual INSERT is the one change the tests cannot isolate,
because the trigger already covers it.

**Migration / rollback.** `626_practice_rate_override_column_mirror.sql`. The legacy `NOT NULL`
constraints are left in place deliberately: mirroring the pairs is reversible, dropping `NOT
NULL` is not. A `CHECK` constraint was rejected in favour of the trigger because a CHECK would
reject the legacy writer's row rather than repair it, and would fail validation against any
existing drifted row. Rollback: `DROP TRIGGER trg_pcro_mirror_columns ON
practice_client_rate_overrides;` plus `git revert`. The one-time `UPDATE` in the migration is a
column-local mirror within each row and never crosses `company_id`.

**Historical-data impact.** No override was ever created through the API, so no time entry was
billed at a *wrong* override rate; all fell through to `practice_staff_rates`. The exposure is
missing overrides, not incorrect ones. Read-only check for rows whose pairs disagree:
```sql
SELECT company_id, count(*) AS rows,
       count(*) FILTER (WHERE staff_user_id IS DISTINCT FROM user_id) AS user_mismatch,
       count(*) FILTER (WHERE rate_per_hour IS DISTINCT FROM rate)    AS rate_mismatch
FROM practice_client_rate_overrides GROUP BY company_id;
```

**Known trigger edge.** `UPDATE … SET rate_per_hour = NULL` propagates the NULL into the
still-`NOT NULL` `rate` and raises 23502, where before 626 it succeeded. No route can reach it:
`updateClientRateOverride` guards with `COALESCE($1, rate_per_hour)`. Noted in the migration header.

**Limits.** The duplicate `createClientRateOverride`/`listClientRateOverrides` in
`practiceStaffRateService.ts` remain, now marked `@deprecated`; deleting them is out of scope.
The legacy columns are not dropped, so a future migration must retire them. Where
`staff_user_id` and `user_id` disagree on a historical row, the override now answers to both
identifiers and returns `rate_per_hour`. The cross-tenant test proves the `WHERE company_id`
predicate, not the RLS policy: it connects as a superuser with no `request.jwt.claims` GUC, as
the rest of the integration suite does. Once migration 626 has shipped everywhere, the service's own dual-pair INSERT becomes
unfalsifiable code re-encoding the schema's rule in TypeScript; remove it together with the
legacy columns and the trigger, and keep the readers simple. The test disables the mirror
trigger to build pre-626 rows, which is global to the database and so runs inside an explicit
transaction on its own client, and it guards the `auth.users` stub with an advisory lock; both
are shared-fixture accommodations rather than product behaviour. Not run against production.
