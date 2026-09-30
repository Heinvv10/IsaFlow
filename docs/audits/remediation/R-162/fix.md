# R-162 — practice daily-digest cron: dead on `companies.deleted_at`, and a latent cross-tenant leak behind it

Base: origin/master `7c49109f5`. Item source: R-073 (PR #571).
Decision (Hein, 2026-09-30): fix both. The cron must work, and it must never show another company's data.

## Reproduction (fixture `isaflow-fixture-r162-goal`, a clone of r159 at migration 716)

The committed test drives the real cron handler (`POST /api/cron/practice/daily-reminders`, with the
`x-cron-secret` header) as the pool role, the same way prod runs it. The mailer is captured, not sent.

**1. On master, the cron dies on its first query:**

```
AssertionError: {"success":false,"data":null,"message":"column \"deleted_at\" does not exist",
  "code":"INTERNAL_SERVER_ERROR"}: expected 500 to be 200
Tests  7 failed | 6 passed (13)
```

`companies` has no `deleted_at` column on the fixture, on `isaflow_dev`, or anywhere in
`scripts/migrations/sql` (the admin soft delete writes `status = 'deleted'`). The six tests that passed
are "skips …" refusals. They pass vacuously on master because nothing is sent. The mutation table
below proves them against the fix.

**2. With only the company predicate patched, the leak is live** (same fixture, same test):

```
× a job in A pointing at B's client never prints B's client name in A's digest
  AssertionError: expected '<!DOCTYPE html>…' not to contain 'SECRET CLIENT B'
× a task in A pointing at B's job never prints B's job title in A's digest
  AssertionError: expected '<!DOCTYPE html>…' not to contain 'SECRET JOB B'
× skips a user with suspended_at set
× skips a user whose status is not active
```

## Root cause

- `loadActiveCompanies` selected `WHERE deleted_at IS NULL`, a column that does not exist.
- `queryOverdueTasks` joined `practice_tasks.job_id → practice_jobs` and
  `practice_jobs.practice_client_id → practice_clients` with no company predicate. Neither FK is
  tenant-bound. The cron has no withAuth, and the pool role (`postgres` on prod and dev) reads past
  RLS. So a company-A task pointing at B's job printed B's job title in A's email, and A's job
  pointing at B's client (the row R-073 closed the write for) printed B's client name.
- `listCompanyUsersForSystem` filtered only on `users.is_active`. A member with `suspended_at` set,
  or a non-active `status`, was still emailed. withAuth refuses both.
- The digest cast the user id `::UUID`. `users.id` is VARCHAR, and dev has a member
  `phase2-wa-user-1`, so that user's digest aborted with 22P02. The dev dry run below found this.

## Fix

| Where | Change |
|---|---|
| `practiceNotificationService.loadActiveCompanies` | The company standing withAuth enforces (`src/lib/auth/companyMembership.ts`): `status IS DISTINCT FROM 'suspended' AND status IS DISTINCT FROM 'deleted' AND suspended_at IS NULL` |
| `practiceNotificationService.queryOverdueTasks` | `pj.company_id = t.company_id` on the job join, `pc.company_id = t.company_id` on the client join. A foreign job or client now comes back NULL; the task itself (A's own) still shows |
| `practiceNotificationService` (both queries) | `t.assigned_to::TEXT = $user`, `user_id::TEXT = $user`: cast the uuid side, not the VARCHAR id |
| `practiceUsersService.listCompanyUsersForSystem` | Accounts in good standing only: `isActiveUserAccount`'s allow-list (`is_active`, `suspended_at IS NULL`, `status` NULL or `active`). It is still scoped by `cu.company_id` |

The time-entries query was already company-scoped. The route (CRON_SECRET check) is unchanged.

## Tests

`tests/integration/r162-practice-daily-digest.int.test.ts` (13 tests, real PG, through the route handler):

- runs to completion: 200, and no per-company or per-user error for the fixture companies
- company A's digest lists A's overdue tasks with A's own client and job names
- a job in A pointing at B's client never prints B's client name in A's digest
- a task in A pointing at B's job never prints B's job title in A's digest
- B's member gets only B's digest, and nothing of A's
- every digest for a fixture company goes to a member of that company
- a member of A and B gets one digest per company, each listing only that company's tasks
- skips a deleted company / a company with status suspended / a company with suspended_at set
- skips an inactive user / a user with suspended_at set / a user whose status is not active

Every user the digest must NOT reach has an overdue task, so each refusal is decided by the
predicate under test, not by having nothing to say. `Date` is pinned to a Wednesday, so the
timesheet path runs whatever day the suite runs. The mailer (`sendEmail`) is `vi.mock`ed and the
suite asserts it is a mock before running. The SMTP env vars are also deleted.

Run:
`ISAFLOW_DISPOSABLE_AUTH_TEST=1 DATABASE_URL=…/isaflow_schema_fixture PLATFORM_ADMIN_DATABASE_URL=… GOTRUE_URL=http://127.0.0.1:1/auth/v1 DATABASE_SSL=disable vitest run --config vitest.integration.config.ts tests/integration/r162-practice-daily-digest.int.test.ts`
→ `Tests 13 passed (13)`. `tests/integration/r152-company-member-list.int.test.ts` (the other
`listCompanyUsersForSystem` suite) passed 13/13, and `tests/unit/services/practice/` passed 241/241.

## Mutation table

Each guard was removed in the working file, the suite was run, and the file was restored from a backup copy.

| Guard removed | Test that went RED | Assertion |
|---|---|---|
| company `status IS DISTINCT FROM 'suspended'` | skips a company with status suspended | `expected [ {…} ] to deeply equal []` |
| company `status IS DISTINCT FROM 'deleted'` | skips a deleted company | `expected [ {…} ] to deeply equal []` |
| company `suspended_at IS NULL` | skips a company with suspended_at set | `expected [ {…} ] to deeply equal []` |
| `pj.company_id = t.company_id` | a task in A pointing at B's job never prints B's job title … | `not to contain 'SECRET JOB B'` |
| `pc.company_id = t.company_id` | a job in A pointing at B's client never prints B's client name … | `not to contain 'SECRET CLIENT B'` |
| `t.company_id = $company` (existing) | a member of A and B gets one digest per company … | `not to contain 'R162 dual-member task in B'` |
| `cu.company_id = $company` (existing) | every digest … goes to a member of that company (+6 others) | 7 failed |
| user `is_active = true` (existing) | skips an inactive user | `expected [ {…} ] to deeply equal []` |
| user `suspended_at IS NULL` | skips a user with suspended_at set | `expected [ {…} ] to deeply equal []` |
| user `status` NULL or `active` | skips a user whose status is not active | `expected [ {…} ] to deeply equal []` |
| `t.assigned_to::TEXT` → `= $user::UUID` | runs to completion … no per-user error | `expected [ {…(3)} ] to deeply equal []` |
| `user_id::TEXT` → `= $user::UUID` | runs to completion … no per-user error | `expected [ {…(3)} ] to deeply equal []` |

## Dev verification (no email sent, no dev writes)

No page is involved, and hitting the dev endpoint would send real mail (`.env.local` carries SMTP).
So `runDailyDigest` ran from this branch against `isaflow_dev`, as the pool role, in a vitest script
that mocks `sendEmail` and asserts the mock before running. With the mailer mocked, nothing else in
the digest writes:

```
companiesProcessed 5591, recipientsNotified 17, errors [], companiesEmailed 9,
every subject "Practice digest — 0 overdue, timesheet missing"
```

The first run, before the `::TEXT` cast fix, had one error: user `phase2-wa-user-1` →
`invalid input syntax for type uuid`. Census query 2 below, run read-only on dev, gives the same
17 recipients in 9 companies. 6 of them are in companies with no practice clients.

## Who receives it (brief item 3)

- Only members (`company_users`) of the company being processed, in good standing. Each
  company's digest lists only that company's tasks.
- **No notification preference or opt-out exists.** Nothing in `scripts/migrations/sql` stores one.
  `user_preferences` is a UI key/value store, and nothing reads a digest key from it. There is no
  practice feature flag either.
- **Open product decision:** the missing-timesheet section goes to every member in good standing
  of every active company, every weekday, unless they logged a non-draft practice time entry
  yesterday. That includes companies that never used practice. On dev, all 17 would-be emails are
  timesheet-only nags. This PR does not narrow it. The orchestrator was asked. A narrower option:
  nag only users with a practice time entry in that company in the last 30 days.
- `recipientsNotified` counts a failed send as notified too (pre-existing; not changed here).

## Auth and scheduling (brief item 4)

- Auth: `x-cron-secret` must equal `CRON_SECRET` (`timingSafeEqualStr`). The endpoint 500s if the
  variable is unset. Prod's `/home/velo/isaflow/.env.local` has a `CRON_SECRET=` line (checked
  with a count, value not read).
- **Not scheduled on prod.** Read-only checks on 2026-09-30:
  - `systemctl list-timers` shows isaflow timers for uptime-probe, mirror-scan, sent-mirror-scan,
    management-packs, dunning-send, backup, basebackup, ar-matview-refresh, fraud-scan and
    restore-drill. None is for practice.
  - No entry in the hein, velo or root crontab, and none in `/etc/cron.d`. No `vercel.json`.
  - The prod journal (retained since 2026-09-26) has zero "practice daily digest" triggers.
    Every "Cron triggered" line belongs to the timers above.

  So a deploy alone sends nothing. Emails start only when someone adds a timer, for example
  modelled on `isaflow-dunning-send.{service,timer}`.
- Siblings with the same dead predicate, not changed here: `practiceRecurringTaskService`
  (`/api/cron/practice/recurring-tasks`) and `practiceMonthlyReportService`
  (`/api/cron/practice/monthly-reports`) still select `companies.deleted_at`. Both are unscheduled.

## Census SQL for production (READ-ONLY; for Hein, never run by the session)

Run as an owner or superuser, the role the cron uses; RLS would hide rows from app_user.
It was checked on the fixture and, read-only, on isaflow_dev: dev has no `deleted_at`, 5591 active
companies, 17 recipients in 9 companies, all timesheet-only, 0 cross-tenant links and 1 non-UUID
member id.

```sql
-- 1. Does companies have deleted_at? No deleted_at row = the digest has never run.
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'companies'
   AND column_name IN ('deleted_at', 'status', 'suspended_at')
 ORDER BY 1;

-- 2. Who the FIXED digest would email if it ran today. Mirrors runDailyDigest.
--    "Yesterday" is CURRENT_DATE - 1 in the server's timezone; the code uses UTC.
WITH active_co AS (
  SELECT id FROM companies
   WHERE status IS DISTINCT FROM 'suspended' AND status IS DISTINCT FROM 'deleted'
     AND suspended_at IS NULL
), members AS (
  SELECT cu.company_id, u.id AS user_id
    FROM company_users cu
    JOIN users u ON u.id = cu.user_id
   WHERE cu.company_id IN (SELECT id FROM active_co)
     AND u.is_active = true AND u.suspended_at IS NULL
     AND (u.status IS NULL OR lower(u.status) = 'active')
), flags AS (
  SELECT m.company_id, m.user_id,
         EXISTS (SELECT 1 FROM practice_tasks t
                  WHERE t.company_id = m.company_id AND t.assigned_to::text = m.user_id
                    AND t.status IN ('pending', 'in_progress') AND t.due_date < CURRENT_DATE) AS has_overdue,
         EXTRACT(ISODOW FROM CURRENT_DATE - 1) BETWEEN 1 AND 5
         AND NOT EXISTS (SELECT 1 FROM time_entries te
                          WHERE te.company_id = m.company_id AND te.user_id::text = m.user_id
                            AND te.entry_date = CURRENT_DATE - 1 AND te.status <> 'draft'
                            AND te.practice_client_id IS NOT NULL) AS timesheet_nag,
         EXISTS (SELECT 1 FROM practice_clients pc WHERE pc.company_id = m.company_id) AS company_uses_practice
    FROM members m
)
SELECT (SELECT count(*) FROM active_co)                                          AS active_companies,
       count(*) FILTER (WHERE has_overdue OR timesheet_nag)                      AS recipients,
       count(DISTINCT company_id) FILTER (WHERE has_overdue OR timesheet_nag)    AS companies_emailed,
       count(*) FILTER (WHERE has_overdue)                                       AS recipients_with_overdue_tasks,
       count(*) FILTER (WHERE timesheet_nag AND NOT has_overdue)                 AS recipients_timesheet_nag_only,
       count(*) FILTER (WHERE (has_overdue OR timesheet_nag) AND NOT company_uses_practice)
                                                                                 AS recipients_in_companies_with_no_practice_clients
  FROM flags;

-- 3. Cross-tenant links the two join predicates now fence (a non-zero count is what
--    the unfenced digest would have printed in another company's email).
SELECT 'practice_tasks.job_id -> practice_jobs' AS link, count(*) AS rows, count(DISTINCT t.company_id) AS companies
  FROM practice_tasks t JOIN practice_jobs pj ON pj.id = t.job_id
 WHERE pj.company_id <> t.company_id
UNION ALL
SELECT 'practice_jobs.practice_client_id -> practice_clients', count(*), count(DISTINCT pj.company_id)
  FROM practice_jobs pj JOIN practice_clients pc ON pc.id = pj.practice_client_id
 WHERE pc.company_id <> pj.company_id;

-- 4. Members whose user id is not a UUID (the old ::UUID cast aborted their digest).
SELECT count(*) AS non_uuid_member_ids
  FROM company_users
 WHERE user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
```

Any cross-tenant row in query 3 is data to repair, and that is a Confirmation Gate. Nothing here repairs it.
