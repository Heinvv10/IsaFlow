# R-135 / R-136 (fixed) and R-122 (not reproduced): payroll leave cluster

Branch `fix/r122-r135-r136-payroll-leave-20260929`, base `origin/master` 3e4728e98. All three items are covered here. `R-122/fix.md` and `R-136/fix.md` point to this file.

## R-135: leave approve took `approved_by` from the request body

### Reproduced (origin/master)

- **Fixture.** This was a clone of `isaflow-fixture-r155` at migration 716, driven through the real route: withAuth as app_user, withErrorHandler, withCsrf.
  - An owner PUT `{status:'approved', approvedBy:<another member's id>}` and got 200. The row stored the other member's id:
    `AssertionError: expected '36a29258-…' to be 'd918e67c-…'`, where the received value is the forged admin and the expected value is the session owner.
  - A manager forging a random, non-member uuid stored that uuid.
  - A reject or cancel with a forged `approvedBy` stored the forged id.
- **Dev (Brightsphere, as reporting-qa, master route code).**
  - I created an employee, a leave type and three leave requests through the API.
  - I approved request `98b0e488-…` from the detail page. The page sends only `{"status":"approved"}`, got PUT 200, and stored `approved_by = NULL`.
  - So every approval made through the UI lost its approver, and any API caller could name any approver.
  - Screenshots (in this folder): `before-detail-pending.png`, `before-detail-approved.png`, `before-brightsphere-leave-list.png`.

### Root cause

`pages/api/payroll/leave/[id].ts` passed `req.body.approvedBy` straight into `updateLeaveRequest`, which writes it to `approved_by`. That happened for every status, not only for approval.

### Fix

The route no longer reads `approvedBy` from the body. It passes `approvedBy: status === 'approved' ? user.id : undefined`, so `approved_by` is the session user, set only on approval. `approved_at` was already set only on approval, so the two columns now move together.

**Why ignore the body value rather than refuse it?** The approver is an identity the server already knows. No client sends the field: the UI sends `{status}`, and no MCP tool or other caller uses `updateLeaveRequest`. Ignoring it means a forged value can never reach storage. The alternative was a 400 branch for an input that no legitimate client produces.

**Rejected and cancelled store no approver.** This matches `approved_at` and what the UI produced before the fix. R-032 still refuses a Login-as session for approve and reject.

## R-136: no `withWriteAccess`, so a viewer could approve

### Reproduced (origin/master, fixture)

A viewer member could:

- PUT `approved`, `rejected` and `cancelled` (200 each; the row changed);
- DELETE a pending request (200; the row was deleted);
- POST `/api/payroll/leave` (201; a request was created);
- POST `/api/payroll/leave/types` (201; a type was created).

For example: `AssertionError: …"status":"approved"…: expected 200 to be 403`.

### Fix

`[id].ts`, `leave/index.ts` and `leave/types.ts` are now `withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))`, which is the shape `accrue.ts`, `rollover.ts` and `employees/*` already use. GET is unaffected. `balances.ts` is GET-only. `accrue.ts` and `rollover.ts` were already gated.

## R-122: 396's JWT-claim policies (not reproduced)

### Evidence (2026-09-29)

- **Migrations.** `397_grants_and_rls_fixes.sql` (commit 512c4d456, 2026-04-19, "RLS fix for leave 500s") DROPs `plt/plb/plr_company_iso`. It recreates them as `USING (company_id = current_setting('app.current_company_id', true)::uuid)`. withAuth sets that GUC at `src/lib/auth/withAuth.ts:104`. On any database that applies migrations in order, 396's claim form survives only between 396 and 397.
- **Dev `pg_policies` (read-only).** Dev has exactly the 397 policies, plus 348's `tenant_isolation` on `payroll_leave_types`. None of them reads `request.jwt.claims`. RLS is enabled and forced on all three tables, and app_user has SELECT, INSERT, UPDATE and DELETE on each. The fixture (r155 clone, 716) has the same policies.
- **Dev, as app_user with withAuth's GUCs, in a read-only transaction.** With reporting-qa's sub and Demo active, the three tables return 14 requests, 5 types and 40 balances, which is all of Demo's rows.
- **Dev API as reporting-qa.** With Demo active, `GET /api/payroll/leave`, `/leave/types` and `/leave/balances?year=2026` returned 14, 5 and 40 rows. The browser list showed the same 14 requests (screenshot `../R-122/r122-demo-leave-list.png`). Brightsphere returned 0 because it had no leave data at all (a superuser count was 0, with 0 employees). After I created leave through the app, it listed it (screenshot `after-brightsphere-leave-list.png`).
- **Dev census (SELECT only).** Only ISAFlow Demo has leave rows: 5 types, 14 requests and 40 balances. The 10 approved rows all carry `approved_by = a0000000-…0001`, who is a member of Demo. The 3 pending rows and 1 rejected row have none.

No migration was written. The suite pins the behaviour: as app_user with withAuth's GUCs, the own company's leave is visible, another company's is not, and an INSERT into another company is refused by RLS. The list route shows only the own company's leave, and another company's id returns 404.

The residual difference from the standard policy is that the 397 policies are `TO public` with no membership predicate. That is not a reproducible defect, because every pipeline that sets `app.current_company_id` checks membership first. The comment in `src/lib/auth/bearerPipeline.ts:137-140` still says 396's policies read the `company_id` claim, which is out of date since 397.

## Tests

`tests/integration/r135-r136-leave-approver-write-access.int.test.ts` has 24 cases, run on a disposable fixture through the real routes:

- **R-135:**
  - approving with a forged approvedBy stores the session user;
  - approving with an approvedBy from outside the company stores the session user;
  - `rejected` / `cancelled` with a forged approvedBy stores no approver.
- **R-136:**
  - an owner, admin or manager approves (200);
  - a viewer who PUTs `approved` / `rejected` / `cancelled` gets 403 and nothing is written;
  - a viewer DELETE gets 403 and the request stays;
  - a manager DELETEs a pending request (200);
  - a viewer can still GET a request (200);
  - a viewer creating a leave request gets 403 and nothing is written, while an owner, admin or manager creates one (201);
  - a viewer creating a leave type gets 403 and nothing is written, while an owner, admin or manager creates one (201).
- **R-122:**
  - sees its own company's leave and none of another company's;
  - cannot insert leave into another company;
  - the list route returns only the own company's leave, and another company's id gets 404.

On origin/master: 10 failed and 14 passed (the R-122 group passes, because it does not reproduce). With the fix: 24 of 24 pass. `tests/integration/r-032-l5-period-controls.int.test.ts` still passes 23 of 23.

## Mutation table

Each file was restored from a backup copy afterwards. Each mutation was run against the new suite.

| # | Guard removed | Red tests (assertion) |
|---|---|---|
| M1 | `[id].ts` honours a body `approvedBy` again | the 4 R-135 cases (`expected '<forged>' to be '<session user>'`; `expected '<forged>' to be null`) |
| M2 | `approvedBy: user.id` on every status | `rejected …` and `cancelled with a forged approvedBy stores no approver` (`expected '<id>' to be null`) |
| M3 | `withWriteAccess` removed from `[id].ts` | viewer PUT `approved` / `rejected` / `cancelled` and viewer DELETE (`expected 200 to be 403`) |
| M4 | `withWriteAccess` removed from `leave/index.ts` | `refuses a viewer creating a leave request (403)` (`expected 201 to be 403`) |
| M5 | `withWriteAccess` removed from `leave/types.ts` | `refuses a viewer creating a leave type (403)` (`expected 201 to be 403`) |
| M6 | fixture policies set back to 396's JWT-claim form (then 397 re-applied) | `sees its own company leave…`, `the list route returns own-company leave only…`, plus every write case (`Leave request not found after update`, a 500) |

## Browser proof (dev, Brightsphere, reporting-qa)

- **Before (master route code).** I approved `98b0e488` in the UI and got PUT 200 with body `{"status":"approved"}`. The DB then showed `approved_by` NULL.
- **After.**
  - I approved `1ac4facc` in the UI and got PUT 200 with body `{"status":"approved"}`. The DB shows `approved_by = 233f3bd5-… (reporting-qa@isaflow.dev)`.
  - A forged API PUT on `729e07e2`, with `approvedBy: a0000000-…0001`, stored `233f3bd5-… (reporting-qa@isaflow.dev)`.
  - The list shows 3 requests: 2 Approved and 1 Pending (the `98b0e488` row approved before the fix keeps its NULL approver).
  - Screenshots: `after-detail-pending.png`, `after-detail-approved.png`, `after-brightsphere-leave-list.png`.
- **Not proven on dev: a viewer's 403.** There is no viewer account I may mint, since sessions are minted only for reporting-qa, who is an owner. The viewer matrix is covered on the fixture.
- **Dev writes, all as reporting-qa through the API or UI in Brightsphere:**
  - 1 employee (`LQA-001`);
  - 1 leave type (`Annual Leave`);
  - 3 leave requests, all approved as described above.

## Census SQL for prod (read-only; for Hein to run)

```sql
-- 1. Leave row counts per company.
SELECT c.name, r.company_id, r.status, count(*) AS requests,
       count(*) FILTER (WHERE r.approved_by IS NULL) AS no_approver
  FROM payroll_leave_requests r JOIN companies c ON c.id = r.company_id
 GROUP BY 1, 2, 3 ORDER BY 1, 3;

-- 2. Approved leave with no approver (every UI approval before this fix).
SELECT r.company_id, r.id, r.employee_id, r.approved_at
  FROM payroll_leave_requests r
 WHERE r.status = 'approved' AND r.approved_by IS NULL
 ORDER BY r.company_id, r.approved_at;

-- 3. Leave whose approved_by is not a member of the row's company, or is a viewer.
SELECT r.company_id, r.id, r.status, r.approved_by, r.approved_at, cu.role AS approver_role
  FROM payroll_leave_requests r
  LEFT JOIN company_users cu ON cu.company_id = r.company_id AND cu.user_id = r.approved_by::text
 WHERE r.approved_by IS NOT NULL
   AND (cu.user_id IS NULL OR cu.role NOT IN ('owner', 'admin', 'manager'))
 ORDER BY r.company_id, r.approved_at;

-- 4. Rejected or cancelled rows that carry an approver (possible only through a body value).
SELECT company_id, id, status, approved_by FROM payroll_leave_requests
 WHERE status IN ('rejected', 'cancelled') AND approved_by IS NOT NULL;

-- 5. R-122: policies actually installed on prod's leave tables.
SELECT tablename, policyname, roles, qual, with_check FROM pg_policies
 WHERE tablename LIKE 'payroll_leave%' ORDER BY 1, 2;
```

There is no audit trigger on `payroll_leave_requests` and no `audit_log` entry for leave, so SQL cannot say who actually approved a row. The prod request logs (journalctl `request_completed` with `route` `/api/payroll/leave/<id>`, `method` PUT, and `userId`) record the real actor for each PUT that is still retained.
