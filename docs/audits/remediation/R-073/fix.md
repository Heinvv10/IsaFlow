# R-073: a practice client contact could be hung off another company's practice client

**Branch** `fix/r073-client-contacts-fence-20260929` from `origin/master` @ `3e4728e98`
**Severity** medium (cross-tenant write; integrity, no disclosure through any live read) · **Migration** none

## Trigger

`pages/api/accounting/practice/client-contacts.ts` POST takes `clientId` from the body and
checks only that it is present. `createClientContact` (`practiceClientService.ts`) then
INSERTs it into `practice_client_contacts.client_id` under the caller's `company_id`.
Nothing reads `practice_clients` on the way:

- the FK `practice_client_contacts_client_id_fkey → practice_clients(id)` is tenant-agnostic
  and `ON DELETE CASCADE`;
- the forced-RLS `tenant_isolation` WITH CHECK tests only the contact's own `company_id`.

This is the R-067 shape with a different parent table: R-067 census row S24, handed over as R-073.

## Reproduction on origin/master (fixture `isaflow_schema_fixture`, 3e4728e98)

The fixture was built as the owner role, with companies A and B, B's practice client
`B SECRET CLIENT (Pty) Ltd`, and an admin of A. The real handlers were called as A
(`withAuth` → `app_user` + GUCs, CSRF, write access):

```
[repro] A POST contact on B client -> 201 {"success":true,"data":{..."clientId":"c62b3890-…"(B's client)…}}
[repro] rows (owner view): [{"contact_is_a":true,"client_is_b":true,"name":"Planted contact"}]
[repro] A PUT job -> B client -> 200
[repro] digest query for A user (owner conn): [{"title":"A overdue task","job_title":"A job","client_name":"B SECRET CLIENT (Pty) Ltd"}]
```

The RED run of the committed test on master showed 5 failures, each on the real cause:

```
client-contacts POST > refuses company B's practice client …        expected 201 to be 400
client-contacts POST > refuses a malformed id with a 400, not a 500  expected 500 to be 400
jobs/[id] PUT > refuses re-pointing A's job at company B's client …  expected 200 to be 400
entry-templates POST > refuses company B's practice client …         expected 201 to be 400
entry-templates/[id] PUT > refuses re-pointing A's template …        expected 200 to be 400
Tests  5 failed | 7 passed (12)
```

## Does a join on `client_id` expose B's data? (measured)

| Read | Runs as | Result on master with a planted row |
|---|---|---|
| `GET client-contacts?clientId=<B's>` as A | app_user (RLS) | returns only A's own planted contact. `listClientContacts` filters `company_id = caller` and joins nothing |
| `GET client-contacts?clientId=<B's>` as B | app_user (RLS) | `[]`: A's contact is invisible to B |
| `PUT` / `GET jobs/[id]` as A, job re-pointed at B's client | app_user (RLS) | `practiceClientName: null`. Forced RLS on `practice_clients` hides B's row from the `LEFT JOIN` |
| daily-digest `queryOverdueTasks` (`pages/api/cron/practice/daily-reminders.ts`) | pool role, **no withAuth, no RLS** | **`client_name: "B SECRET CLIENT (Pty) Ltd"`**. The join `practice_jobs.practice_client_id → practice_clients` has no company predicate, so A's assignee would be emailed B's client name |

The contacts table has no disclosure path. Its only readers are company-scoped and it joins
nothing. Its integrity effect is real: B's client row owns A's contact through
`ON DELETE CASCADE`. `scripts/qa-seed/reset.ts:56` hard-deletes a company's practice clients,
and that would silently delete the other company's contacts.

The digest disclosure goes through a planted **job**, not a contact. It is **dormant today**,
because `runDailyDigest` fails on its first query everywhere:
`loadActiveCompanies` selects `companies.deleted_at`, and that column does not exist on the
fixture or on `isaflow_dev` (`information_schema` checked, read-only). Fixing that cron
would have woken the leak. This fix closes the write that plants the row. The cron defect
itself is unrelated and is not fixed here; it is reported to the orchestrator.

## Fix

`src/modules/accounting/services/practice/practiceClientFence.ts` adds
`assertPracticeClientInCompany(companyId, clientId)` and `PracticeClientNotInCompanyError`
(`PRACTICE_CLIENT_NOT_FOUND`). It has the same contract as R-067's `assertCustomerInCompany`:

1. It runs **before the first write**, because `withAuth` COMMITs a 4xx returned after one.
2. **An absent id passes.** The contacts route still answers a missing `clientId` with its
   own 400 (`clientId is required`), as before. Entry templates may still have no client.
3. **The read is savepointed.** A malformed id (22P02) is refused as a 400 instead of
   aborting the request transaction and returning a 500. Any other error propagates.
4. **It checks the tenant only, not `status`.** An update can keep pointing at the
   company's own archived client.

It lives in the practice module and not in `contactDirectoryService.ts`, because that file is
the customer/supplier directory and R-068 is editing it in parallel.

Call sites: `createClientContact`, `updateJob`, `createEntryTemplate` and `updateEntryTemplate`.
The client-contacts and both entry-template routes map the error to `apiResponse.badRequest`.
`jobs/[id]` PUT already turns any service error into a 400 (`Update failed`).

## Census: every write of a practice client id

This census is enumerated from the **schema**, not from a grep. Every column with an FK to
`practice_clients` on the fixture is listed below. A name sweep of `information_schema` for
`%practice_client%` and for `practice_*.%client%` found no other column.

| # | Column | Write path | Where the id comes from | Disposition |
|---|---|---|---|---|
| 1 | `practice_client_contacts.client_id` | `createClientContact` ← `client-contacts.ts` POST | `body.clientId` | **FIXED** (R-073) |
| 2 | `practice_jobs.practice_client_id` | `updateJob` ← `jobs/[id].ts` PUT | `req.body.practiceClientId` | **FIXED**. It was unfenced, and it is the row the digest leak needs |
| 3 | `practice_jobs.practice_client_id` | `createJob` ← `jobs.ts` POST | `req.body.practiceClientId` | **already guarded**: company-scoped + `status='active'` read before the INSERT |
| 4 | `practice_entry_templates.practice_client_id` | `createEntryTemplate` ← `entry-templates.ts` POST | body | **FIXED** |
| 5 | `practice_entry_templates.practice_client_id` | `updateEntryTemplate` ← `entry-templates/[id].ts` PUT | body | **FIXED** |
| 6 | `time_entries.practice_client_id` | `createPracticeEntry` ← `time-entries.ts` POST, MCP `log_time_entry`, `bulkCreateFromTemplate` | body / MCP arg / template row | **already guarded**: `validateClientCategoryWorkItem` reads the client company-scoped. A planted template id would be refused here too |
| 7 | `time_entries.practice_client_id` | `updatePracticeEntry` ← `time-entries/[id].ts` PUT | body | **already guarded**: same validator whenever the client changes |
| 8 | `time_entries.practice_client_id` | `duplicatePracticeEntry` (`practiceTimeEntryWorkflow.ts`) ← `time-entries/duplicate.ts` | source entry read `WHERE company_id` | **exempt**: the id comes from a company-scoped read, and it is re-validated anyway |
| 9 | `practice_client_rate_overrides.client_id` | `practiceClientRateOverrideService` ← `clients/[id]/rate-overrides.ts` | route `id` | **already guarded**: the route's local `assertClientBelongsToCompany` runs before every method. It is not savepointed, so a malformed id there is a 500, not a 400 (noted, unchanged) |
| 10 | `practice_client_rate_overrides.client_id` | `practiceStaffRateService.createClientRateOverride` (`@deprecated`) | caller | **exempt**: no route or caller |
| 11 | `time_entries.practice_client_id` | `timeTrackingService` (legacy project timesheets) | — | **not written**: reads the column only |
| — | `seed-practice-data.ts`, `qa-seed/reset.ts` | scripts | — | **exempt**: scripts, company-scoped |

`practice_clients.client_group_id` (→ `practice_client_groups`) is written from the body with no
tenant read in `create/updatePracticeClient`. That is the same shape with a different parent,
outside this item's scope, and it is reported to the orchestrator.

## Tests

`tests/integration/practice-client-ownership-fence.int.test.ts` runs on real PG through the
real handlers as app_user. Fixture rows are built by the owner role. Each refusal is paired
with the allowed case.

- client-contacts POST: B's client → 400 and 0 rows · A's own → 201 and 1 row · malformed → 400 · absent → 400 and nothing written (unchanged)
- jobs/[id] PUT: B's client → 400 and the job keeps its client · A's other client → 200 · no client in body → 200, client unchanged
- entry-templates POST: B's → 400 and 0 rows · A's own → 201 · no client → 201 with NULL (unchanged)
- entry-templates/[id] PUT: B's → 400 and the template keeps its client · A's other client → 200
- the fence outside RLS, on the owner connection: B's client rejects; A's own and an absent id pass

Run against the disposable fixture (`isaflow-fixture-r073-goal`):
`ISAFLOW_DISPOSABLE_AUTH_TEST=1 DATABASE_URL=…/isaflow_schema_fixture PLATFORM_ADMIN_DATABASE_URL=… GOTRUE_URL=http://127.0.0.1:1/auth/v1 DATABASE_SSL=disable JWT_SECRET=… vitest run --config vitest.integration.config.ts tests/integration/practice-client-ownership-fence.int.test.ts`
→ `Tests 13 passed (13)`.

## Mutation check

For each mutation, the file was copied to scratch, the guard was removed, the suite was run,
and the file was restored from the copy.

| # | Guard removed | Red test(s) | Assertion |
|---|---|---|---|
| M1 | `createClientContact` fence call | client-contacts POST › refuses company B's practice client…; › refuses a malformed id… | `expected 201 to be 400`; `expected 500 to be 400` |
| M2 | `updateJob` fence call | jobs/[id] PUT › refuses re-pointing A's job at company B's client… | `expected 200 to be 400` |
| M3 | `createEntryTemplate` fence call | entry-templates POST › refuses company B's practice client… | `expected 201 to be 400` |
| M4 | `updateEntryTemplate` fence call | entry-templates/[id] PUT › refuses re-pointing A's template… | `expected 200 to be 400` |
| M5 | fence `AND company_id = …` predicate | the fence itself, outside RLS › refuses company B's client… | `promise resolved "undefined" instead of rejecting` |
| M6 | fence 22P02 → refusal | client-contacts POST › refuses a malformed id… | `expected 500 to be 400` |
| M7 | fence absent-id pass | jobs/[id] PUT › an update naming no client…; entry-templates POST › still stores a template with no client…; the fence itself… | 400 `Update failed` / 400 `Practice client null was not found…`; `promise rejected … instead of resolving` |
| M8 | client-contacts route 400 mapping | client-contacts POST › refuses company B's…; › malformed id… | `expected 500 to be 400` (×2) |
| M9 | entry-templates POST 400 mapping | entry-templates POST › refuses company B's… | `expected 500 to be 400` |
| M10 | entry-templates PUT 400 mapping | entry-templates/[id] PUT › refuses re-pointing… | `expected 500 to be 400` |

M5 survived the route tests at first, because forced RLS already hides B's client from
app_user, so the predicate is redundant under `withAuth`. The test "the fence itself,
outside RLS" was added so that a non-`withAuth` caller is covered.

## Browser evidence (dev, reporting-qa@isaflow.dev, Brightsphere)

The dev server ran from this branch on :3213. The client page
`/accounting/practice/clients/665c0390-…` ("R-123 QA Practice Client", Brightsphere's own
active client) has **no add-contact form**: its "Add a contact" button only switches tabs.
So the contact was posted through the app's own session and CSRF token, exactly as
`apiFetch` does: `POST /api/accounting/practice/client-contacts` → **201**. After a reload,
the Contacts tab showed `(1)` and the row **R-073 QA Contact · r073-qa@isaflow.dev ·
Bookkeeper · Primary**. Screenshot: `browser-own-client-contact.png`. This is the only dev
write, one contact row in Brightsphere.

## Census SQL for production (READ-ONLY; for Hein, never run by the session)

Run it as an owner or superuser, because forced RLS hides cross-tenant rows from app_user.
It was checked on the fixture: 0 rows in every table, and 1 row once a planted contact was
inserted inside a rolled-back transaction.

```sql
SELECT 'practice_client_contacts' AS tbl, count(*) AS rows, count(DISTINCT x.company_id) AS companies
  FROM practice_client_contacts x JOIN practice_clients pc ON pc.id = x.client_id
 WHERE pc.company_id <> x.company_id
UNION ALL
SELECT 'practice_jobs', count(*), count(DISTINCT x.company_id)
  FROM practice_jobs x JOIN practice_clients pc ON pc.id = x.practice_client_id
 WHERE pc.company_id <> x.company_id
UNION ALL
SELECT 'practice_entry_templates', count(*), count(DISTINCT x.company_id)
  FROM practice_entry_templates x JOIN practice_clients pc ON pc.id = x.practice_client_id
 WHERE pc.company_id <> x.company_id
UNION ALL
SELECT 'time_entries', count(*), count(DISTINCT x.company_id)
  FROM time_entries x JOIN practice_clients pc ON pc.id = x.practice_client_id
 WHERE pc.company_id <> x.company_id
UNION ALL
SELECT 'practice_client_rate_overrides', count(*), count(DISTINCT x.company_id)
  FROM practice_client_rate_overrides x JOIN practice_clients pc ON pc.id = x.client_id
 WHERE pc.company_id <> x.company_id;

-- Detail for R-073's own table (ids only; no contact PII selected).
SELECT x.id AS contact_id, x.company_id AS contact_company, x.client_id, pc.company_id AS client_company, x.created_at
  FROM practice_client_contacts x JOIN practice_clients pc ON pc.id = x.client_id
 WHERE pc.company_id <> x.company_id
 ORDER BY x.created_at;
```

Any rows found are data to repair, and that is a Confirmation Gate. Nothing here repairs them.
