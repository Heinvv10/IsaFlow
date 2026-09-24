# R-121: practice time capture and rate overrides against the real schema

## What was found
It started from one column, `time_entries.amount`. `createPracticeEntry` and `updatePracticeEntry` write it, and no migration creates it. Chasing it turned up four layers. Each one alone breaks practice time capture on the database that has it.

| Layer | Where it is | Effect |
|---|---|---|
| `time_entries.amount` missing | dev and the r112 fixture (built from a dev schema dump) | create/edit a practice entry: 42703 |
| `practice_client_rate_overrides.user_id` / `.rate` missing (the table predates 372, so 372's CREATE IF NOT EXISTS skipped) | dev and the fixture | `resolveRate`, and so every practice entry, fails 42703; migration 626 cannot apply there |
| No grants on `practice_client_rate_overrides` for app_user, platform_admin or migration_admin | dev and the fixture | every app read, `resolveRate` included, fails with "permission denied" |
| Policy `pcro_company_isolation` (395) reads a `company_id` JWT claim | **every database that ran 395, prod included.** Only the MCP bearer pipeline synthesises that claim; `withAuth` passes GoTrue's claims, which have no `company_id` | in the web app, rate overrides list as empty and cannot be saved |

**Is prod affected?** The column and grant layers are probably DEV drift, not prod. The K-039 test (2026-09) documents `user_id`/`rate` present as NOT NULL, and today's deploy counted 626 as already applied on prod, which it cannot be without those columns. The policy layer comes from a migration, so it IS on prod, unless it was changed by hand. The prod query to settle this is below.

## Fix
Two migrations, additive and idempotent, safe whatever prod's shape is.
- **625b** adds the columns. It is ordered BEFORE 626 because 626's trigger and back-fill reference `user_id`/`rate`: on a dev-shaped database 626 raised 42703, and the runner stops at the first failure. Proven on a throwaway database: bare shape → 625b → 626 → 699 applies, while 626 alone fails. On prod, where 626 is already recorded, 625b is new and runs as a no-op.
- **699** sets the grants and the policy. The prefix 698 was taken on isaflow_dev by a peer's uncommitted `698_gl_account_merges_document_rows.sql`. It enables and forces RLS before granting, as the sibling practice tables are. It drops only 395's `pcro_company_isolation`; a `tenant_isolation` policy that already exists is kept, not replaced. Re-running it changes nothing.

What they do:
- `time_entries.amount` is added if missing. It is a nullable duplicate of `line_total`, which the writers set.
- `practice_client_rate_overrides.user_id` and `.rate` are added if missing, nullable, and back-filled from `staff_user_id` / `rate_per_hour`. 626's trigger keeps the two pairs in step afterwards.
- The table gets the sibling tables' grants (app_user and platform_admin: DML; migration_admin: ALL).
- `pcro_company_isolation` is replaced by `tenant_isolation`, for app_user: USING membership (`auth.user_companies()`), WITH CHECK membership AND `app.current_company_id()`.

No application code changed.

## Evidence
All runs are on the r112 fixture.
- **RED** (`red.log`): on the dev-shaped schema, create/edit failed with 42703 and the override service and route failed with "permission denied".
- **GREEN:** `tests/integration/r121-practice-entry-writes.int.test.ts`, 6 of 6:
  - a practice entry is created and edited, and its line equals hours × rate;
  - an override is recorded and a new entry bills at it, with both column pairs mirrored;
  - the rate-overrides ROUTE works through `withAuth` (app_user, RLS, a GoTrue token without a `company_id` claim). It POSTs, then GETs the row back;
  - as app_user, another company's override is invisible, and a cross-tenant INSERT is refused by the WITH CHECK;
  - a member of two companies cannot write into the one that is not active.
- **Mutations** (`mutations.log`, each with its SQL and verbatim result): a policy that isolates nothing (3 red), WITH CHECK removed (2), WITH CHECK without the active-company clause (1), 395's policy restored (1), RLS disabled (3), grants revoked (6). The restored 699 is 6 of 6 green. Dropping `time_entries.amount` fails 2 (general reviewer).
- **Fixture provisioning:** the fixture had no `auth.users`, since GoTrue owns it. A stub was created as postgres, with SELECT for app_user and platform_admin; k-039 stubs it the same way. **Caveat:** the override service LEFT JOINs `auth.users` as app_user, and no migration grants that. On a database where app_user cannot read `auth.users`, the route still fails; isaflow_dev has no `auth.users` at all. The prod query below checks it. Granting app_user blanket SELECT on `auth.users` would expose every user's email across tenants, so it is deliberately not done here.

## Review round 1 (general)
| Finding | Fix |
|---|---|
| HIGH: tenant isolation untested (USING true / WITH CHECK true stayed green). | Two app_user tests; MP1 and MP2 go red. |
| HIGH: the runner stops at 626 on dev, so 698 was unreachable. | The columns moved to 625b, ahead of 626; ordering proven on a throwaway database. |
| MEDIUM: prefix 698 already recorded on dev. | Renumbered to 699. |
| MEDIUM: `auth.users` grant hidden by the test stub. | Documented as a caveat, with a prod check; not granted (cross-tenant email exposure). |
| LOW: "production dump" vs "dev dump" wording. | Consistent: the r112 fixture is a dev schema dump. |
| LOW: "no-op" for the policy. | Reworded. |
| LOW: stale `bearerPipeline` comment. | Updated. |
| LOW: mutations recorded without their SQL. | The log carries the SQL. |

## Review round 2 (adversarial, on b9240f81a)
| Finding | Fix |
|---|---|
| 1–2 (fixed in 4988e3bee) | See that commit. |
| 3: an existing `tenant_isolation` was silently replaced. | Created only if missing; an existing one is kept. |
| 4: WITH CHECK was the active company only. | Membership AND the active company. New test; MP4 goes red. |
| 5: the grant could land on a table without RLS. | RLS enabled and forced first, as on the siblings. MR goes red. |
| 6: `amount` precision differed from `line_total`. | NUMERIC(18,2). |
| Docs: prod query incomplete. | Now checks privileges, RLS flags, policy roles and WITH CHECK, and whether 626 is recorded. |

## For Hein (read-only on prod)
```sql
SELECT table_name, column_name, is_nullable FROM information_schema.columns
WHERE (table_name='time_entries' AND column_name='amount')
   OR (table_name='practice_client_rate_overrides' AND column_name IN ('user_id','rate','staff_user_id','rate_per_hour'));
SELECT grantee, string_agg(privilege_type, ',') FROM information_schema.role_table_grants
WHERE table_name='practice_client_rate_overrides' GROUP BY 1;
SELECT r.rolname, has_table_privilege(r.rolname, 'practice_client_rate_overrides', 'SELECT,INSERT,UPDATE,DELETE') AS dml
FROM pg_roles r WHERE r.rolname IN ('app_user','platform_admin','migration_admin');
SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='practice_client_rate_overrides';
SELECT tablename, policyname, roles, qual, with_check FROM pg_policies
WHERE tablename IN ('practice_client_rate_overrides','payroll_leave_types','payroll_leave_balances','payroll_leave_requests');
SELECT name FROM schema_migrations WHERE name LIKE '626%' OR name LIKE '395%';
SELECT has_table_privilege('app_user', 'auth.users', 'SELECT');
```

## Not covered
- **R-122:** migration 396's `payroll_leave_*` policies read the same `company_id` claim. The web app likely sees no leave data under RLS. Not fixed here; prod state is unknown.
