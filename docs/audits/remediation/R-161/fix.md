# R-161 and R-163: practice client group fence, and the rate-overrides client check

**Branch** `fix/r161-r163-practice-fences-20260930` from `origin/master` @ `7c49109f5`
**Severity** R-161 medium (cross-tenant write; integrity, no disclosure) · R-163 low (wrong status code) · **Migration** none

This file covers both items. They share one PR because both are R-073 siblings in the same fence module.

## R-161 trigger

`createPracticeClient` and `updatePracticeClient` (`practiceClientService.ts`) store the body's
`clientGroupId` in `practice_clients.client_group_id`. Neither reads `practice_client_groups` first:

- the FK `practice_clients_client_group_id_fkey → practice_client_groups(id)` does not check the tenant, and it is `ON DELETE NO ACTION`;
- the forced-RLS `tenant_isolation` WITH CHECK tests only the client's own `company_id`.

`clients.ts` POST passes `clientGroupId` through. `clients/[id].ts` PUT passes the whole `req.body`.

## R-163 trigger

`pages/api/accounting/practice/clients/[id]/rate-overrides.ts` had its own `assertClientBelongsToCompany`.
It ran `SELECT … WHERE id = ${clientId}` with no savepoint. A malformed id raised 22P02, which aborted
the request transaction, and the route answered 500.

## Reproduction on origin/master (fixture `isaflow_schema_fixture`, 7c49109f5)

The fixture `isaflow-fixture-r161-goal` is cloned read-only from `isaflow-fixture-r159` (migrations through 716).
Rows were built as the owner role: companies A and B, B's group `B SECRET GROUP`, and one admin in
each company. The real handlers were called through `withAuth` (app_user + GUCs, CSRF, write access):

```
[repro] A POST client with B group: {"status":201,"clientGroupId":"05d9ef28-…"}
[repro] A PUT existing client -> B group: {"status":200,"clientGroupId":"05d9ef28-…"}
[repro] owner view: [{"legal_name":"A existing","client_is_a":true,"group_is_b":true,"group_name":"B SECRET GROUP"},
                     {"legal_name":"A planted","client_is_a":true,"group_is_b":true,"group_name":"B SECRET GROUP"}]
[repro] A POST malformed group: {"status":500}
```

Running the committed test on master gave 7 failures, each for the real cause:

```
clients POST › refuses company B's client group with a 400 and stores no client        expected 201 to be 400
clients POST › refuses a malformed group id with a 400, not a 500, …                   expected 500 to be 400
clients/[id] PUT › refuses moving A's client into company B's group, …                 expected 200 to be 400
clients/[id] PUT › refuses a malformed group id with a 400, not a 500                  expected 500 to be 400
rate-overrides › answers a malformed client id with a 400, not a 500                   expected 500 to be 400
rate-overrides › refuses a malformed client id on POST with a 400 and writes nothing   expected 500 to be 400
the group fence itself, outside RLS › …                                                 TypeError: assertClientGroupInCompany is not a function
Tests  7 failed | 6 passed (13)
```

## Does a read join `client_group_id` and expose B's group? (measured: no)

| Read | Runs as | Result on master with a planted row |
|---|---|---|
| `GET clients/[id]` as A | app_user | `clientGroupId: "<B's id>"`. That is the raw id A sent; no group name or other field of B's |
| `GET clients?groupId=<B's group>` as A | app_user | only A's own two planted clients |
| `GET client-groups` as A | app_user | `["A group"]`. B's group is not listed |
| `GET clients?groupId=<own group>` as B | app_user | `[]`. A's planted clients are hidden by RLS |
| Client detail page | browser | shows the raw `clientGroupId` in "Client Group", not a name |

A code search and the schema agree. `practice_client_groups` is read only by `listClientGroups`, which is
company-scoped. No query, view or function joins `practice_clients.client_group_id` to it.

The effect is on integrity, not disclosure:

- **B cannot delete its own group.** A planted reference blocks it: B, as app_user, got
  `23503 … violates foreign key constraint "practice_clients_client_group_id_fkey"`. There is no
  group-delete route today, so this is dormant.
- **Existence oracle (master).** An id that exists in no company fails the FK (23503), and the
  handler answers 500. Another company's real group id is accepted (201). So the status told A whether a
  group UUID exists anywhere. After the fix both are 400.

## Fix

`src/modules/accounting/services/practice/practiceClientFence.ts`:

- adds `assertClientGroupInCompany(companyId, groupId)` and `ClientGroupNotInCompanyError`
  (`CLIENT_GROUP_NOT_FOUND`). The contract is R-073's: call it before the first write; an absent id passes;
  the read is savepointed and 22P02 counts as "not this company's"; it checks the tenant only.
- moves the savepointed read with its 22P02 handling into a private `savepointedExists`. Both fences now
  use it, so the R-073 client fence behaves exactly as before.

Call sites:

- `createPracticeClient` calls it next to `assertCustomerInCompany`, before the duplicate read and the INSERT.
- `updatePracticeClient` calls it after the existence check and before the UPDATE.
- `clients.ts` POST and `clients/[id].ts` PUT map `ClientGroupNotInCompanyError` to `apiResponse.badRequest`,
  beside the existing `CustomerNotInCompanyError`.

R-163, in `rate-overrides.ts`:

- The local `assertClientBelongsToCompany` is gone.
- A malformed id is refused with `isUuidParam` → 400 `Invalid client ID`. The fence alone would fold
  malformed into "not found".
- `assertPracticeClientInCompany` then runs, and its refusal becomes the route's existing
  404 `Client`. An own client is unchanged.

## Census: every FK to `practice_client_groups` (from the schema)

`pg_constraint` on the fixture shows exactly one FK column referencing `practice_client_groups`.
An `information_schema` sweep for `%client_group%` and for `practice_*.%group%` found no other column.

| # | Column | Write path | Where the id comes from | Disposition |
|---|---|---|---|---|
| 1 | `practice_clients.client_group_id` | `createPracticeClient` ← `clients.ts` POST | `req.body.clientGroupId` | **FIXED** (R-161) |
| 2 | `practice_clients.client_group_id` | `updatePracticeClient` ← `clients/[id].ts` PUT | `req.body` (whole) | **FIXED** (R-161) |
| 3 | `practice_clients` INSERT | `practiceClientBulkService` (CSV import) | — | **not written**: the INSERT has no group column |
| 4 | `practice_clients` UPDATE | `customerMergeService` | — | **not written**: sets `link_customer_id` only |
| 5 | `practice_clients` INSERT/UPDATE | `scripts/qa-seed/practice.ts`, `scripts/simulate-fy2026-workflows.ts` | — | **not written** |
| — | MCP | `list_practice_clients` only | — | **no write tool** |

`practice_client_groups` rows are written only by `createClientGroup`, and its `company_id` comes from the session.

Outside scope, noted: `assigned_partner_id` / `assigned_manager_id` on the same INSERT/UPDATE are also
body-supplied. They have **no FK** and no reader that joins them; this was checked in the schema and the code.

## Tests

`tests/integration/practice-client-group-fence.int.test.ts` runs on real PG through the real handlers as
app_user. Fixture rows are built by the owner role, and each refusal is paired with the allowed case.

- clients POST: B's group → 400, 0 rows · A's own group → 201, stored · no group → 201, NULL (unchanged) · malformed → 400, 0 rows
- clients/[id] PUT: B's group → 400, the group is unchanged · malformed → 400, unchanged · A's other group → 200 · no group in the body → 200, unchanged
- rate-overrides: malformed id GET → 400 · malformed id POST → 400 and nothing written · B's client GET/POST → 404 and nothing written · A's own client POST 201 then GET 200 with 1 row
- the group fence itself, outside RLS (owner connection): B's group rejects; A's own and an absent id pass
- the group fence inside a request transaction (`als` context with BEGIN): a malformed id is refused and the next fence read on the same transaction still works

`tests/unit/services/practice/practiceClientService.test.ts` mocks the new fence export. It adds two
order checks: when the group fence refuses, `createPracticeClient` issues no SQL, and
`updatePracticeClient` issues only its existence read.

Run on the fixture:
`ISAFLOW_DISPOSABLE_AUTH_TEST=1 DATABASE_URL=…/isaflow_schema_fixture PLATFORM_ADMIN_DATABASE_URL=… GOTRUE_URL=http://127.0.0.1:1/auth/v1 DATABASE_SSL=disable JWT_SECRET=… vitest run --config vitest.integration.config.ts`
with this suite, R-073's `practice-client-ownership-fence`, `r121-practice-entry-writes` and
`r123-rate-override-names` → `Test Files 4 passed (4) · Tests 37 passed (37)`.

R-123's premise check needs app_user to have no grant on `auth.users`, so the r159 stub grant was revoked
on this fixture. Only this fixture was changed; the peer's was not.

## Mutation check

For each mutation, the file was copied to scratch, the guard was removed, the named suite was run, and the file
was restored from the copy.

| # | Guard removed | Red test(s) | Assertion |
|---|---|---|---|
| M1 | `createPracticeClient` group fence call | clients POST › refuses company B's client group…; › refuses a malformed group id… | `expected 201 to be 400`; `expected 500 to be 400` |
| M2 | `updatePracticeClient` group fence call | clients/[id] PUT › refuses moving A's client into company B's group…; › refuses a malformed group id… | `expected 200 to be 400`; `expected 500 to be 400` |
| M3 | group fence `AND company_id = …` predicate | the group fence itself, outside RLS › refuses company B's group… | `promise resolved "undefined" instead of rejecting` |
| M4 | group fence absent-id pass | clients POST › still stores a client with no group…; PUT › an update naming no group…; fence itself | `expected 400 to be 201`; `expected 400 to be 200`; `promise rejected … instead of resolving` |
| M5 | `savepointedExists` 22P02 → refusal (shared) | POST and PUT › malformed group id; R-073 client-contacts POST › malformed id | `expected 500 to be 400` (×3) |
| M6 | clients POST 400 mapping | clients POST › B's group; › malformed | `expected 500 to be 400` (×2) |
| M7 | clients/[id] PUT 400 mapping | clients/[id] PUT › B's group; › malformed | `expected 500 to be 400` (×2) |
| M8 | rate-overrides `isUuidParam` check | rate-overrides › malformed GET; › malformed POST | `expected 404 to be 400` (×2) |
| M9 | rate-overrides fence call | rate-overrides › still answers company B's client with a 404… | `expected 200 to be 404` |
| M10 | rate-overrides refusal → 404 mapping | same | `expected 500 to be 404` |
| M11 | the SAVEPOINT itself (read run bare) | the group fence inside a request transaction › refuses a malformed id… and leaves it usable | `promise rejected "error: current transaction is aborted…" instead of resolving` |

The first M11 run **survived** every route test, because each route answers 400 straight after the
refusal and never issues another query. So the direct in-transaction test was added, and it kills M11.
M3 needs the direct owner-connection test for the same reason as R-073's M5: through `withAuth`,
forced RLS already hides B's group.

## Browser evidence (dev, reporting-qa@isaflow.dev, Brightsphere)

The dev server ran from this branch on :3222. The app has **no group picker**: the client pages never
send `clientGroupId`, and the detail page shows the raw id. So the calls went through the app's own
session and CSRF token, exactly as `apiFetch` sends them:

```
[browser] client: {"id":"665c0390-…","legalName":"R-123 QA Practice Client","companyId":"d27bac33-…","clientGroupId":null}
[browser] create group: {"status":201}          -> "R-161 QA Group" 2386d799-151b-40a3-aaae-e399eb89f9f2 (Brightsphere)
[browser] PUT malformed group: {"status":400,"message":"Client group not-a-uuid was not found for this company"}
[browser] PUT group id that is not this company's: {"status":400,"message":"Client group 00000000-0000-4000-8000-000000000161 was not found for this company"}
[browser] PUT own group: {"status":200,"clientGroupId":"2386d799-…"}
[browser] GET rate-overrides malformed id: {"status":400,"message":"Invalid client ID"}
[browser] GET rate-overrides own: {"status":500}   -- column pcro.user_id does not exist (dev drift, below)
```

- `browser-client-own-group.png`: after a reload, the client's Details tab shows **Client Group
  2386d799-151b-40a3-aaae-e399eb89f9f2**, which is Brightsphere's own group.
- `browser-rate-overrides.png`: the Rate Overrides tab loads and shows the "Staff Rate Overrides"
  panel with "Add Override" and "No rate overrides yet".

**That empty state is not proof the list works.** On dev, `GET …/rate-overrides` for an own client
returns 500 `column pcro.user_id does not exist`, both on this branch and on master. The fence passes
first; the failure is in `listClientRateOverrides`. R-123's fix.md already recorded this dev drift:
isaflow_dev lacks R-121's migrations 625b/626/699. `ClientRateOverrides.tsx` renders any non-OK
response as "No rate overrides yet" (`if (overridesRes.ok)` with no else), so the UI hides the 500.
That UI defect is reported, not fixed here. The fixture tests cover the own-client list and create paths.

Dev writes: one group `R-161 QA Group` in Brightsphere, and `client_group_id` set on
"R-123 QA Practice Client". Both went through the API as reporting-qa.

## Census SQL for production (READ-ONLY; for Hein, never run by the session)

Run it as an owner or superuser, because forced RLS hides cross-tenant rows from app_user.
It returned 0 rows on the fixture, and 1 row once a planted client was inserted inside a rolled-back
transaction. On `isaflow_dev` (read-only session, `default_transaction_read_only=on`) it returned 0 rows.

```sql
SELECT count(*) AS rows, count(DISTINCT pc.company_id) AS companies
  FROM practice_clients pc JOIN practice_client_groups g ON g.id = pc.client_group_id
 WHERE g.company_id <> pc.company_id;

-- Detail (ids only).
SELECT pc.id AS client_id, pc.company_id AS client_company, pc.client_group_id, g.company_id AS group_company, pc.updated_at
  FROM practice_clients pc JOIN practice_client_groups g ON g.id = pc.client_group_id
 WHERE g.company_id <> pc.company_id
 ORDER BY pc.updated_at;
```

Any rows found are data to repair, which is a Confirmation Gate. Nothing here repairs them.
