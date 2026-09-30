# R-168 — practice monthly-report and recurring-task crons: dead on `companies.deleted_at`, and cross-tenant behind it

Base: origin/master `66e776d81`. Item source: R-162 follow-up (PR #575).
Decision (Hein, 2026-09-30): fix both crons in one PR, the R-162 way. Both stay unscheduled.

## Reproduction (fixture `isaflow-fixture-r168-goal`, a clone of r159)

Both suites drive the real cron handlers (`POST /api/cron/practice/monthly-reports` and
`POST /api/cron/practice/recurring-tasks`, with the `x-cron-secret` header) as the pool role, the way
prod would run them. The mailer is captured, not sent.

**1. On master, both crons die on their first query:**

```
monthly-reports:  AssertionError: {"success":false,"data":null,"message":"column \"deleted_at\" does not exist",
                    "code":"INTERNAL_SERVER_ERROR"}: expected 500 to be 200
recurring-tasks:  error: column "deleted_at" does not exist
                    at loadActiveCompanies (practiceRecurringTaskService.ts:26:17)  → expected 500 to be 200
Test Files  2 failed (2)   Tests  34 skipped (34)
```

`companies` has no `deleted_at` on the fixture, on `isaflow_dev`, or anywhere in `scripts/migrations/sql`.

**2. With ONLY the company predicate patched (working copy, restored afterwards), both are cross-tenant:**
17 of 34 tests fail.

Monthly report (company A's email):
- `A's report never prints B's client name` → `not to contain 'SECRET CLIENT B'`. A's time entry on
  B's client printed B's client name (profitability section).
- `company A's report goes only to A's opted-in members…` → `expected [ …(7) ] to deeply equal [ …(2) ]`.
  A's report went to an address that is no user at all, to B's member, and to A's inactive,
  `suspended_at` and non-active-status users.

Recurring sweep (tasks created in A):
- `a source on B's job gets an instance with no job` → the new A task pointed at B's job.
- `an assignee from another company is dropped` (+ inactive, `suspended_at`, non-active status) → the new
  task was assigned to B's member or to a user out of standing.
- `skips a source created by another company's member` / `…whose creator has suspended_at set` → the
  task was created with that user as `created_by`.

`A's report never prints B's staff name` passed already: the staff name map comes from
`listCompanyUsersForSystem`, which was company-scoped. The mutation table proves it.

## Confirmation gates

- **Are report recipients designed for external people? No evidence they are.** The page
  (`pages/accounting/practice/report-recipients/index.tsx`) says "Manage who receives monthly practice
  management report emails". It uses the placeholder `name@company.co.za`, and nothing labels it as a
  client or external address. The report itself is internal management data: staff utilisation, client
  profitability and WIP. The table (mig 387) is a free-text email per company. `isaflow_dev` has
  **0 rows** in `practice_report_recipients`, so dev cannot say either way. I implemented the member rule.
  Prod census query 2 below counts the rows it would skip. **Hein should run it before deploy.** If
  prod has external accountants on the list, their report stops.
- **Would the sweep's first run be bulk? Not on dev.** `isaflow_dev` has 0 `practice_tasks` rows at all,
  so 0 eligible sources. Prod is unknown; census query 4 measures it.

## Root cause

- Both `loadActiveCompanies` selected `WHERE deleted_at IS NULL`, a column that does not exist.
- Both crons run with no withAuth, as the pool role (`postgres` on prod/dev), which reads past RLS.
  - `getClientProfitability` and `getWipAging` joined `time_entries.practice_client_id → practice_clients`
    with no company predicate, and that FK is not tenant-bound. A company-A time entry pointing at B's
    client printed B's client name in A's report.
  - `runMonthlyReports` mailed every active, opted-in `practice_report_recipients` row. Any address typed
    into that list got the firm's staff, client and WIP figures, including another company's member and
    a suspended user.
  - `sweepRecurringTasks` called `generateNextRecurringInstance`, which copies the source's `job_id` and
    `assigned_to` as they are, and the sweep passed the source's `created_by` as the creator. So a foreign
    job, an outside assignee or an outside creator was re-created every period.

## Fix

| Where | Change |
|---|---|
| `practiceMonthlyReportService.loadActiveCompanies`, `practiceRecurringTaskService.loadActiveCompanies` | The company standing withAuth enforces (`companyMembership.ts`): `status IS DISTINCT FROM 'suspended' AND status IS DISTINCT FROM 'deleted' AND suspended_at IS NULL` |
| `practiceReportsService.getClientProfitability`, `.getWipAging` | `JOIN practice_clients pc ON pc.id = te.practice_client_id AND pc.company_id = te.company_id`. An entry on a foreign client drops out of the per-client rows, as RLS does on the request path. No line added. |
| `runMonthlyReports` | Recipients are the active, `monthly_summary` rows whose email (trimmed, lower-cased) is the email of a `listCompanyUsersForSystem(company)` member, i.e. a `company_users` member of THAT company in good standing (`isActiveUserAccount` rules). The rest are skipped, counted in `recipientsSkipped`, and a `log.warn` is written. The same member list feeds the staff-name map, as before. It is only queried when a company has an opted-in row. |
| `sweepRecurringTasks` | Per company with eligible sources, it loads the members in good standing once (`listCompanyUsersForSystem`). A source whose `created_by` is NULL or not one of them is skipped (`tasksSkipped`, `log.warn`). Otherwise the next instance is inserted with the job only when it is the company's own (`LEFT JOIN practice_jobs pj ON … AND pj.company_id = t.company_id` → `own_job_id`) and the assignee only when a member in good standing. Anything else becomes NULL with a `log.warn`. |
| `practiceRecurringTaskService.insertNextInstance` (new, replaces `generateNextRecurringInstance` + `stampParentLink` in the cron) | `INSERT … SELECT` from the source row, with `parent_task_id = source` in the same statement (the old two-step left a window where a failed stamp meant a duplicate next run). |
| `practiceTaskService.computeNextDueDate` | Exported (no other change) so the sweep computes the same next due date. |

Why the sweep no longer calls `generateNextRecurringInstance`: it copies the source's links, it has no
seam for fenced values, `practiceTaskService.ts` is at 299 lines, and it is shared with the request
route `POST /api/accounting/practice/tasks/recurring`. That route is untouched.

Tasks have no client column. The only task link is `job_id`. A task on A's own job whose job points at
B's client is A's row: the sweep copies the job link, not the job's client. The job→client link is
job data (R-073 closed that write).

Left alone, noted for the register:
- `POST /practice/tasks/recurring` → `generateNextRecurringInstance` still copies the source's job and
  assignee. It runs under withAuth/RLS, so a member of both A and B could still copy an A task that
  already points at B's job.
- `getTask` / `listTasks` `LEFT JOIN practice_jobs` has no company predicate (the request path, under RLS).
- `getServiceMix` joins `practice_job_categories` unfenced. The cron does not call it.
- `practiceReportsService.ts` is 349 lines, over the 300 limit before this change. This PR adds none.

## Tests

`tests/integration/r168-practice-monthly-report.int.test.ts` (17 tests) and
`tests/integration/r168-practice-recurring-sweep.int.test.ts` (17 tests). Real PG, pool role, through
the route handlers. Shared seed: `tests/integration/r168-practice-crons.helpers.ts`. Both suites are
`assertDisposable()`-gated. `sendEmail` is `vi.mock`ed at module scope, the suite asserts it is a mock,
and the SMTP vars are deleted.

Monthly report (`reportMonth: '2026-08'`):
- runs to completion: 200, and no error for the fixture companies but the failing mailbox
- company A's report goes only to A's opted-in members in good standing (email matched case-insensitively, trimmed)
- A's report never prints B's client name (A's entries on B's client: profitability, WIP aging)
- A's report never prints B's staff name (B's member logged time in A)
- B's report goes to B's member only, and shows nothing of A's
- skips an inactive recipient row / a recipient not opted into monthly_summary / an address that is no
  user at all / another company's member / an inactive user / a user with suspended_at set / a user
  whose status is not active
- counts the non-member recipients as skipped
- skips a deleted company / a company with status suspended / a company with suspended_at set
- a failed send is reported in errors and not counted in recipientsEmailed

Recurring sweep:
- runs to completion: 200, and no error for the fixture companies
- a clean source gets its next instance: same job and assignee, pending, due one period on
- B's own recurring task is generated in B
- a source on B's job gets an instance with no job, keeping its own assignee
- an assignee from another company / inactive / with suspended_at set / whose status is not active is dropped
- skips a source created by another company's member / whose creator has suspended_at set / with no creator
- counts the skipped sources
- skips a deleted company / a company with status suspended / a company with suspended_at set
- no generated task links another company's job or an assignee outside the company's members in good standing
- stays idempotent: a second run generates nothing

Every excluded party otherwise qualifies. The inactive and not-opted-in rows belong to members in good
standing. Each out-of-standing user is a member of A. Each skipped company has an eligible member
recipient or source. So each refusal is decided by the predicate under test.
The WIP entry is dated July, because the email renders only 31+ day WIP rows. That makes the
profitability fence and the WIP fence each leak independently.

Run (fixture on 127.0.0.1:55481):
`ISAFLOW_DISPOSABLE_AUTH_TEST=1 DATABASE_URL=…@127.0.0.1:55481/isaflow_schema_fixture PLATFORM_ADMIN_DATABASE_URL=… GOTRUE_URL=http://127.0.0.1:1/auth/v1 DATABASE_SSL=disable vitest run --config vitest.integration.config.ts tests/integration/r168-practice-monthly-report.int.test.ts tests/integration/r168-practice-recurring-sweep.int.test.ts`
→ `Tests 34 passed (34)`.

The sibling suites over the functions this touches all passed on the fixture: r162 (digest, which uses
`listCompanyUsersForSystem`), r152 (member list), r059 (`getWipAging` as-of) and r147 (utilisation
names), `Test Files 4 passed, Tests 49 passed (49)`. `tests/unit/services/practice/` passed 247/247.
The sweep unit tests now mock `listCompanyUsersForSystem` and assert the INSERT's bound values instead
of `generateNextRecurringInstance` + the UPDATE stamp. Three cases were added: creator not a member,
foreign job + outside assignee dropped with a warning, and a non-member monthly recipient skipped and
counted.

The fixture was cloned from `isaflow-fixture-r159`, which carries a peer's unmerged
`717_paystack_request_portal_link.sql`. That migration is unrelated to practice.

## Mutation table

Each guard was removed in the working file, both suites were run, and the file was restored from a backup
copy (`git diff --stat` was unchanged after every run).

| Guard removed | Tests that went RED | Assertion |
|---|---|---|
| monthly: company `status IS DISTINCT FROM 'suspended'` | skips a company with status suspended | `expected [ Array(1) ] to deeply equal []` |
| monthly: company `status IS DISTINCT FROM 'deleted'` | skips a deleted company | `expected [ Array(1) ] to deeply equal []` |
| monthly: company `suspended_at IS NULL` | skips a company with suspended_at set | `expected [ Array(1) ] to deeply equal []` |
| sweep: company `status IS DISTINCT FROM 'suspended'` | skips a company with status suspended; no generated task links … | `expected [ { …(8) } ] to deeply equal []`; `expected 8 to be 7` |
| sweep: company `status IS DISTINCT FROM 'deleted'` | skips a deleted company; no generated task links … | same |
| sweep: company `suspended_at IS NULL` | skips a company with suspended_at set; no generated task links … | same |
| `getClientProfitability`: `pc.company_id = te.company_id` | A's report never prints B's client name … | `not to contain 'SECRET CLIENT B'` |
| `getWipAging`: `pc.company_id = te.company_id` | A's report never prints B's client name … | `not to contain 'SECRET CLIENT B'` |
| monthly: recipient ∈ member emails | goes only to A's opted-in members …; skips no user / other company's member / inactive / suspended_at / status; counts skipped | 7 failed; `expected [ …(7) ] to deeply equal [ …(2) ]` |
| monthly: email `trim().toLowerCase()` → identity | goes only to A's opted-in members (… case-insensitively, trimmed) | `expected [ Array(1) ] to deeply equal [ …(2) ]` |
| monthly: `monthly_summary` opt-in (existing) | goes only to …; skips a recipient not opted into monthly_summary | `expected [ …(3) ] to deeply equal [ …(2) ]` |
| `listReportRecipients`: `is_active = true` (existing) | goes only to …; skips an inactive recipient row | `expected [ …(3) ] to deeply equal [ …(2) ]` |
| monthly: count only `emailResult.success` (existing) | a failed send is reported in errors and not counted … | `expected [] to deeply equal [ { …(3) } ]` |
| `listCompanyUsersForSystem`: `cu.company_id` (existing) | never prints B's staff name; skips another company's member; an assignee from another company is dropped; skips a source created by another company's member; +4 | 8 failed; `not to contain 'SECRET STAFF B'` |
| `listCompanyUsersForSystem`: `u.is_active` (existing) | skips an inactive user; an inactive assignee is dropped; +3 | 5 failed |
| `listCompanyUsersForSystem`: `u.suspended_at IS NULL` | skips a user with suspended_at set; an assignee with suspended_at set is dropped; skips a source whose creator has suspended_at set; +4 | 7 failed |
| `listCompanyUsersForSystem`: `status` NULL or `active` | skips a user whose status is not active; an assignee whose status is not active is dropped; +3 | 5 failed |
| sweep: `pj.company_id = t.company_id` (own job) | a source on B's job gets an instance with no job …; no generated task links … | `expected [ [ …(2) ] ] to deeply equal [ [ null, …(1) ] ]` |
| sweep: assignee ∈ members | an assignee from another company / inactive / suspended_at / status is dropped; no generated task links … | 5 failed; `expected [ Array(1) ] to deeply equal [ null ]` |
| sweep: creator ∈ members | skips a source created by another company's member / whose creator has suspended_at set; counts the skipped sources; no generated task links … | 4 failed; `expected 9 to be 7` |
| sweep: `NOT EXISTS` child (existing) | stays idempotent: a second run generates nothing | `expected 7 to be +0` |
| sweep: `parent_task_id = s.id` → NULL | a clean source gets its next instance …; +8 incl. stays idempotent | 9 failed |

`!task.created_by ||` is subsumed by the membership check, since `members.has(null)` is false. It stays
for the log message, and `skips a source with no creator` covers the outcome.

## Dev verification (no email sent, no dev writes)

`docs/audits/remediation/R-168/dev-dry-run.test.ts` (config `dev-dry-run.config.ts` beside it) ran both
crons from this branch against `isaflow_dev` as the pool role. `sendEmail` is `vi.mock`ed and asserted
to be a mock. The pool URL carries `options=-c default_transaction_read_only=on`, and the script asserts
`current_database() = 'isaflow_dev'` and `default_transaction_read_only = on` before running, so the
sweep could not have written even if it had found a source. Log: `dev-dry-run.log`.

```
monthly: companiesProcessed 5791, recipientsEmailed 0, recipientsSkipped 0, errors []   mailerCalls 0
sweep:   companiesProcessed 5791, tasksConsidered 0, tasksGenerated 0, tasksSkipped 0, errors []
```

Dev has 0 `practice_report_recipients` rows and 0 `practice_tasks` rows, so both run clean and do
nothing. The census below returned the same zeros on dev (read-only). On the fixture, the census was
checked in a rolled-back transaction with 3 recipients (1 member with padded upper-case email, 1
suspended, 1 outsider) and 3 sources (clean with an out-of-standing assignee, creator suspended, foreign
job). It reported 1 emailed / 2 skipped and 3 eligible / 2 generate / 1 skip / 1 job dropped /
1 assignee dropped, which matches the code.

Run: `DATABASE_URL="<isaflow_dev url>&options=-c%20default_transaction_read_only%3Don" vitest run --root . --config docs/audits/remediation/R-168/dev-dry-run.config.ts`

## Scheduling

Both crons stay **unscheduled**. Read-only check on 2026-09-30: `systemctl list-timers --all` lists no
practice timer (only uptime-probe, mirror-scan, sent-mirror-scan, backup, ar-matview-refresh,
fraud-scan, management-packs, dunning-send, basebackup and restore-drill). There is no practice entry
in the crontab and none in `/etc/cron.d`. This PR adds no timer.

## Census SQL for production (READ-ONLY; for Hein, never run by the session)

Run it as an owner or superuser, the role the crons use (RLS would hide rows from app_user), inside
`BEGIN READ ONLY; … ROLLBACK;`.

```sql
-- 1. Does companies have deleted_at? No deleted_at row = neither cron has ever run.
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'companies'
   AND column_name IN ('deleted_at', 'status', 'suspended_at')
 ORDER BY 1;

-- 2. Who the FIXED monthly report would email. Mirrors runMonthlyReports.
WITH active_co AS (
  SELECT id FROM companies
   WHERE status IS DISTINCT FROM 'suspended' AND status IS DISTINCT FROM 'deleted'
     AND suspended_at IS NULL
), opted AS (
  SELECT r.company_id, r.email
    FROM practice_report_recipients r
   WHERE r.company_id IN (SELECT id FROM active_co)
     AND r.is_active AND 'monthly_summary' = ANY (r.report_types)
), flagged AS (
  SELECT o.company_id,
         EXISTS (SELECT 1 FROM company_users cu JOIN users u ON u.id = cu.user_id
                  WHERE cu.company_id = o.company_id
                    AND lower(trim(u.email)) = lower(trim(o.email))
                    AND u.is_active = true AND u.suspended_at IS NULL
                    AND (u.status IS NULL OR lower(u.status) = 'active')) AS is_member
    FROM opted o
)
SELECT (SELECT count(*) FROM active_co)                          AS active_companies,
       (SELECT count(*) FROM practice_report_recipients)         AS recipient_rows_total,
       count(*)                                                  AS opted_in_active_rows,
       count(*) FILTER (WHERE is_member)                         AS recipients_emailed,
       count(DISTINCT company_id) FILTER (WHERE is_member)       AS companies_emailed,
       count(*) FILTER (WHERE NOT is_member)                     AS recipients_skipped
  FROM flagged;

-- 3. Cross-tenant links the fences now drop (non-zero = data an unfenced cron would have leaked or copied).
SELECT 'practice_tasks.job_id -> another company''s job' AS link, count(*) AS rows, count(DISTINCT t.company_id) AS companies
  FROM practice_tasks t JOIN practice_jobs pj ON pj.id = t.job_id
 WHERE pj.company_id <> t.company_id
UNION ALL
SELECT 'time_entries.practice_client_id -> another company''s client', count(*), count(DISTINCT te.company_id)
  FROM time_entries te JOIN practice_clients pc ON pc.id = te.practice_client_id
 WHERE pc.company_id <> te.company_id
UNION ALL
SELECT 'practice_tasks.assigned_to -> not a member in good standing', count(*), count(DISTINCT t.company_id)
  FROM practice_tasks t
 WHERE t.assigned_to IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM company_users cu JOIN users u ON u.id = cu.user_id
                    WHERE cu.company_id = t.company_id AND cu.user_id = t.assigned_to::text
                      AND u.is_active = true AND u.suspended_at IS NULL
                      AND (u.status IS NULL OR lower(u.status) = 'active'));

-- 4. What the FIXED sweep's first run would do. Mirrors sweepRecurringTasks.
WITH active_co AS (
  SELECT id FROM companies
   WHERE status IS DISTINCT FROM 'suspended' AND status IS DISTINCT FROM 'deleted'
     AND suspended_at IS NULL
), src AS (
  SELECT t.*
    FROM practice_tasks t
   WHERE t.company_id IN (SELECT id FROM active_co)
     AND t.recurring_rule IS NOT NULL AND t.status IN ('done', 'cancelled')
     AND t.due_date IS NOT NULL AND t.due_date <= CURRENT_DATE
     AND NOT EXISTS (SELECT 1 FROM practice_tasks c WHERE c.company_id = t.company_id AND c.parent_task_id = t.id)
), good AS (
  SELECT cu.company_id, cu.user_id
    FROM company_users cu JOIN users u ON u.id = cu.user_id
   WHERE u.is_active = true AND u.suspended_at IS NULL AND (u.status IS NULL OR lower(u.status) = 'active')
), flagged AS (
  SELECT s.company_id,
         EXISTS (SELECT 1 FROM good g WHERE g.company_id = s.company_id AND g.user_id = s.created_by::text) AS creator_ok,
         s.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM practice_jobs pj WHERE pj.id = s.job_id AND pj.company_id = s.company_id) AS job_dropped,
         s.assigned_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM good g WHERE g.company_id = s.company_id AND g.user_id = s.assigned_to::text) AS assignee_dropped
    FROM src s
)
SELECT count(*)                                         AS eligible_sources,
       count(*) FILTER (WHERE creator_ok)               AS would_generate,
       count(*) FILTER (WHERE NOT creator_ok)           AS would_skip,
       count(*) FILTER (WHERE creator_ok AND job_dropped)      AS generated_without_foreign_job,
       count(*) FILTER (WHERE creator_ok AND assignee_dropped) AS generated_without_assignee,
       count(DISTINCT company_id) FILTER (WHERE creator_ok)    AS companies,
       coalesce(max(n), 0)                              AS max_per_company
  FROM flagged
  LEFT JOIN LATERAL (SELECT count(*) AS n FROM flagged f2 WHERE f2.company_id = flagged.company_id AND f2.creator_ok) m ON true;
```

Before either cron is ever scheduled, check two things. A large `would_generate` in query 4 is a backlog
explosion on the first run. Any `recipients_skipped` in query 2 is a person who stops getting the report.
Any cross-tenant row in query 3 is data to repair, and that is a Confirmation Gate. Nothing here repairs it.

No deploy. No migration.
