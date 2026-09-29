# R-123: the rate-override service reads auth.users as app_user

**Base:** origin/master `3e4728e98`. **Branch:** `fix/r123-rate-override-names-20260929`. **No migration.**

## Reproduction (2026-09-29, before any code change)

**Dev** (`isaflow_dev`, reporting-qa@isaflow.dev on Brightsphere `d27bac33…`, dev server from this worktree on :3215 running master code). Evidence: `dev-api.log`.

- `to_regclass('auth.users')` is NULL on isaflow_dev, so `has_table_privilege('app_user','auth.users','SELECT')` raises `relation "auth.users" does not exist`.
- I created a practice client, "R-123 QA Practice Client" (`665c0390-…`), through `POST /api/accounting/practice/clients`. Then:
  - `GET …/clients/<id>/rate-overrides` returned **500** `relation "auth.users" does not exist`.
  - `GET …/clients/<id>/staff` returned **500** with the same error.
- The screen showed "No rate overrides yet" and a staff dropdown with no names (`before-staff-dropdown.png`). The component drops a non-ok response silently (see side findings), which is why the 500 never showed on screen.

**Fixture** (the `isaflow-fixture-r155` clone, migrations through 716). `auth.users` there is a leftover stub that grants SELECT to app_user. After `REVOKE SELECT ON auth.users FROM app_user` (the prod-shaped case: GoTrue owns the table and nothing grants app_user), R-121's own route test failed with `permission denied for table users` (500). The new test fails on master for the same reason (`red.log`):

```
AssertionError: {"success":false,…,"message":"permission denied for table users",…}: expected 500 to be 200
AssertionError: {"success":false,…,"message":"permission denied for table users",…}: expected 500 to be 201
AssertionError: {"success":false,…,"message":"permission denied for table users",…}: expected 500 to be 200
```

## Root cause

`practiceClientRateOverrideService.ts` LEFT JOINed `auth.users` in four places: `listClientRateOverrides`, the re-read after create, the re-read after update, and `listCompanyStaff`. It read the display name from `raw_user_meta_data->>'full_name'`. No migration grants app_user SELECT on `auth.users`, and withAuth runs as app_user. Wherever the grant is missing (prod: unknown; dev: the table does not exist), each of these reads raises. R-121's and K-039's tests created the stub with a grant, so none of them failed.

## Fix

The fix grants nothing on `auth.users`, because a grant would expose every tenant's users. Names now come from `public.users` through the existing company-bound SECURITY DEFINER functions:

| Read | Now uses | Bound to |
|---|---|---|
| override list, create/update re-read | `LEFT JOIN LATERAL approval_company_member_profile(pcro.company_id, staff::text)` (mig 715) | the caller's active company; the target must be a member of it, otherwise the name and email are NULL |
| `listCompanyStaff` (staff dropdown) | `company_member_directory(companyId)` (mig 716) | the caller's active company, filtered as `cu_select`: owner/admin see every member, manager/viewer see only themselves (the same as the old `company_users` RLS) |

`staffName` / `fullName` is `first_name + ' ' + last_name`, or NULL when both are empty. The UI already falls back to the email and then the id. Callers without a principal (the service called directly, with no JWT) get NULL names from 715. From 716, `listCompanyStaff` refuses them with 42501; only the withAuth `staff` route calls it.

The R-121 and K-039 suites no longer stub `auth.users` or take the advisory lock that guarded the stub. The service never touches the table now.

## Tests

`tests/integration/r123-rate-override-names.int.test.ts` runs through the real routes via withAuth (app_user, RLS, a GoTrue JWT). Its `beforeAll` asserts that app_user has **no** SELECT on `auth.users` (or that the table is absent). The caller owns two companies.

1. `the staff dropdown lists this company's members with names, never another company's`
2. `creating an override returns the staff name, and the list and update carry it`
3. `an override naming another company's member never shows that member's name or email`

GREEN (`green.log`):
- Fixture with `auth.users` present and not granted: r123 3/3, r121 7/7, k-039 11/13.
- Fixture with `auth.users` dropped (the dev shape): the same result.
- The 2 k-039 failures (`resolves a pre-migration-626 row…`, `lists a legacy-only row…`) are **pre-existing and unrelated**. They fail on master with the grant in place too. The cause is `null value in column "staff_user_id"`: this dev-shaped fixture has `staff_user_id NOT NULL`, while the migration path (372 then 395) leaves it nullable.

## Mutation check (`mutations.log`)

Each mutation was applied to a copy of the file or function and then restored: the service from a backup copy, and the functions by re-applying 715/716 from their files.

| # | Guard removed | Test that goes RED | Assertion |
|---|---|---|---|
| M1 | Override reads join `auth.users` again (the R-123 cause) | tests 2 and 3 | `permission denied for table users: expected 500 to be 201` / `…to be 200` |
| M2 | `listCompanyStaff` reads `auth.users` again | test 1 | `permission denied for table users: expected 500 to be 200` |
| M3 | 715: the target-membership `JOIN company_users … company_id = p_company_id` | test 3 | `expected {…} to match object { staffName: null, … }` (the outsider's name leaked) |
| M4 | 716: `WHERE cu.company_id = p_company_id` | test 1 | `expected […] to have a length of 2 but got 4` (the other company's members listed) |

The first M4 run stayed green, because the caller owned only one company. The test now makes the caller an owner of both companies, and M4 goes red (both runs are in the log).

## Browser (dev, reporting-qa, Brightsphere)

Path: `/accounting/practice/clients/665c0390-…` → Rate Overrides → Add Override.

- `before-staff-dropdown.png` (master): `/staff` returned 500. The Staff Member select had only "Select staff member…".
- `after-staff-dropdown.png` (this branch): `/staff` returned 200. The select offered "Hein van Vuuren (hein@h10.co.za)" and "Reporting QA (reporting-qa@isaflow.dev)", and "Reporting QA" is shown selected.
- On dev, `GET …/rate-overrides` still returns 500 on this branch, but with `column pcro.user_id does not exist`. That is **R-121's dev drift, not R-123**: isaflow_dev has no 625b, 626 or 699 in `schema_migrations`, has no `user_id`/`rate` columns on the overrides table, and still has 395's `pcro_company_isolation`. For the same reason, an override row with a name cannot be shown on dev until those migrations are applied there. That is a §8 gate, reported to the orchestrator and not done here. The fixture tests cover the list, create and update paths.

## Dev writes

- One practice client, "R-123 QA Practice Client", created in Brightsphere through the app API as reporting-qa.
- No migrations applied. No other writes.

## Census / prod check (READ-ONLY, for Hein; never run by this session)

No rows are written by the broken path, so there is nothing to repair. This read-only check shows whether prod was failing:

```sql
SELECT to_regclass('auth.users') AS auth_users,
       CASE WHEN to_regclass('auth.users') IS NOT NULL
            THEN has_table_privilege('app_user', 'auth.users', 'SELECT') END AS app_user_can_read;
-- app_user_can_read = false → the override tab and staff dropdown 500'd on prod until this fix.
-- true → someone granted it by hand: every tenant's users are readable by app_user;
--        after this fix ships, REVOKE it (a decision for Hein, not done here).
SELECT count(*) AS overrides, count(DISTINCT company_id) AS companies FROM practice_client_rate_overrides;
```

## Side findings (not fixed here)

- `ClientRateOverrides.tsx` `loadData` ignores a non-ok response: a 500 on either call shows "No rate overrides yet" or an empty dropdown with no error. That is why R-123 was invisible in the UI (the `apiFetch` resolves-on-4xx/5xx class).
- isaflow_dev lacks R-121's migrations 625b, 626 and 699 (see Browser).
- K-039's two legacy-row tests fail on dev-shaped fixtures (see Tests).
