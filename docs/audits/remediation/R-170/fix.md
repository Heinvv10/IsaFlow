# R-170: empty-string practice client ids 500 instead of "none"/"clear"

**Branch** `fix/r170-practice-client-empty-ids-20260930` from `origin/master` @ `66e776d81`
**Severity** low (availability — a 500 the caller sent by accident, not a tenant breach) · **Migration** none

## Trigger

`assertClientGroupInCompany` and `assertCustomerInCompany` (R-161 / R-067) both treat a **falsy**
id as "absent" and skip the tenant check:

```ts
export async function assertClientGroupInCompany(companyId, groupId) {
  if (!groupId) return;   // '' is falsy — passes as if absent
  ...
}
```

`createPracticeClient` and `updatePracticeClient` (`practiceClientService.ts`) then wrote the raw
body value into the `::UUID` cast:

```sql
${input.clientGroupId ?? null}::UUID     -- '' ?? null === '' (not nullish) — cast runs on ''
```

`''` is not nullish, so `?? null` never replaced it, the fence let it through, and the bare
(non-savepointed) cast raised 22P02, aborting the request transaction — 500.

`clients/[id]` (GET/PUT/DELETE) had no `isUuidParam` guard on the route `id` at all: a malformed
id hit the same kind of unsavepointed `::UUID` cast in the very first read (`getPracticeClient` /
the `existing` lookup in `updatePracticeClient`/`deletePracticeClient`) — also 500.

## Reproduction on origin/master (fixture `isaflow_schema_fixture`, 66e776d81)

Cloned read-only from `isaflow-fixture-r159` (`feedback_disposable_fixture_from_peer_container.md`);
fixture's `schema_migrations` max was already `717_paystack_request_portal_link.sql`, at or above
this branch's newest migration (716), so nothing to apply. Real handlers via `withAuth` (app_user +
GUCs), CSRF, write access. `tests/integration/r170-practice-client-empty-ids.int.test.ts` on master:

```
clients POST > stores NULL for an empty clientGroupId, not a 500        expected 500 to be 201
clients POST > stores NULL for an empty linkCustomerId, not a 500       expected 500 to be 201
clients/[id] PUT > clears … with an empty clientGroupId, not a 500      expected 500 to be 200
clients/[id] PUT > clears … with an empty linkCustomerId, not a 500     expected 500 to be 200
clients/[id] > GET answers 400, not 500, for a malformed id             expected 500 to be 400
clients/[id] > PUT answers 400, not 500, for a malformed id             expected 500 to be 400
clients/[id] > DELETE answers 400, not 500, for a malformed id          expected 500 to be 400
Test Files  1 failed | Tests  7 failed | 6 passed (13)
```

Each 500's body confirmed the real cause, e.g. `invalid input syntax for type uuid: ""`.

## Decision (Hein, 2026-09-30)

`''` for `clientGroupId` or `linkCustomerId` means "none": on create it stores NULL; on update it
CLEARS the field. A malformed (non-empty, non-UUID) id is a 400. A foreign id (another company's)
is a 400 (already true since R-161/R-067 — unchanged here). `updatePracticeClient` with a malformed
**route** id is a 400 via `isUuidParam`.

## Fix

`src/modules/accounting/services/practice/practiceClientService.ts`:

- `createPracticeClient` normalises both ids with `input.x ? input.x : null` before the fence calls
  and before the `INSERT`'s `::UUID` casts. `''` and omission now both store NULL, same as before
  the bug (an absent id already stored NULL).
- `updatePracticeClient` computes, per field, whether the key is present in the body
  (`'clientGroupId' in input`) alongside the same normalise-to-null. The two affected columns
  switch from `COALESCE(${x ?? null}::UUID, column)` (which can only ever keep the existing value
  or set a new one — it cannot express "clear", since `COALESCE(NULL, column)` returns `column`) to
  `CASE WHEN ${provided}::boolean THEN ${normalised}::UUID ELSE column END` — the same pattern
  `updatePracticeEntry`'s `notes` column already uses for the identical "absent vs explicit null"
  problem (R-120). Absent → unchanged; `''`/null → NULL; a real id → set (after the fence, which
  still refuses a foreign or malformed one).

`pages/api/accounting/practice/clients/[id].ts`:

- One `isUuidParam(id)` guard at the top of the handler, before the method branch — GET, PUT and
  DELETE all read `practice_clients` first with `id = ${id}::UUID`, none of it savepointed. A
  malformed id now answers 400 `Invalid client ID` instead of 500. A well-formed id belonging to no
  company is unaffected (GET still 404; PUT/DELETE still whatever they did before — out of scope,
  see below).

No fence itself needed to change: both already treat `null` as absent and correctly refuse a
malformed non-empty string via the existing savepointed read (22P02 → refusal). The bug was only
that `''` never reached the fence's `!id` check in a way that also protected the write below it.

**Out of scope, noted:** `updatePracticeClient`/`deletePracticeClient` throw a generic
`Error('not found')` for a well-formed id belonging to no company (or none at all), which
`withErrorHandler` currently answers as a plain 500, not 404. That is a pre-existing, separate
defect (not part of R-170's claim, which was specifically about `''` and malformed ids) and is left
unchanged here.

## Tests

`tests/integration/r170-practice-client-empty-ids.int.test.ts`, run on real PG through the real
handlers as app_user:

- clients POST: `''` clientGroupId → 201, stores NULL · `''` linkCustomerId → 201, stores NULL ·
  malformed clientGroupId → 400, 0 rows · foreign clientGroupId → 400, 0 rows (already-fixed R-161
  path, re-asserted here as a control)
- clients/[id] PUT: `''` clientGroupId clears a previously-set group → 200, NULL · `''`
  linkCustomerId clears a previously-set customer → 200, NULL · field absent from the body leaves
  the group unchanged → 200, unchanged · a real own-company id sets both fields → 200, set ·
  malformed clientGroupId → 400 (control)
- clients/[id] malformed **route** id: GET/PUT/DELETE → 400, not 500 · GET on a well-formed id in
  no company → 404 (control, unchanged)

Run: `ISAFLOW_DISPOSABLE_AUTH_TEST=1 DATABASE_URL=postgres://postgres:fixture@127.0.0.1:55483/isaflow_schema_fixture
PLATFORM_ADMIN_DATABASE_URL=<same> GOTRUE_URL=http://127.0.0.1:1/auth/v1 DATABASE_SSL=disable
JWT_SECRET=<from .env.local> bunx vitest run --config vitest.integration.config.ts
tests/integration/r170-practice-client-empty-ids.int.test.ts tests/integration/practice-client-group-fence.int.test.ts
tests/integration/practice-client-ownership-fence.int.test.ts` →
`Test Files 3 passed (3) · Tests 40 passed (40)` (13 new + the 27 pre-existing R-161/R-073 tests,
run together to confirm no regression on the shared fence/route code).

`tests/unit/services/practice/practiceClientService.test.ts` mocks `sql` and the fence functions
generically (no change needed); `bunx vitest run tests/unit/services/practice/` →
`Test Files 19 passed (19) · Tests 244 passed (244)`.

## Mutation check

Each mutation: the file was copied to scratch, the guard removed, the named test run, the file
restored from the copy; verified restored with `diff` before continuing.

| # | Guard removed | Red test(s) | Assertion |
|---|---|---|---|
| M1 | create: `input.x ? input.x : null` normalisation (both fields, reverted to raw `input.clientGroupId`/`input.linkCustomerId`) | clients POST › stores NULL for an empty clientGroupId…; › … empty linkCustomerId… | `invalid input syntax for type uuid: ""`, `expected 500 to be 201` (×2) |
| M2 | update: `CASE WHEN` → `COALESCE(${x}::UUID, column)` (both fields) | clients/[id] PUT › clears … clientGroupId…; › clears … linkCustomerId… | `expected '<existing group id>' to be null`; `expected '<existing customer id>' to be null` — the clear silently no-oped (still 200) instead of writing NULL, since `COALESCE(NULL, column)` returns `column` |
| M3 | update: `groupIdProvided` forced to `true` (drops the absent/provided distinction) | clients/[id] PUT › leaves the group unchanged when the field is absent from the body | `expected <existing group> to be null` — an absent body key wiped the group instead of leaving it |
| M4 | route: the `isUuidParam(id)` guard in `[id].ts` | clients/[id] › GET/PUT/DELETE answers 400, not 500, for a malformed id | `expected 500 to be 400` (×3) |

All four mutations were run individually; the file was restored and re-verified (`diff` against the
pre-mutation copy, then the full 40-test run green) before the next mutation.

## Dev browser proof (reporting-qa@isaflow.dev, Brightsphere)

Dev server ran from this branch on `:3283`. Session minted via GoTrue `admin/generate_link` +
`email_otp` (never a password), written as cookies into a fresh headless Playwright context
(its own browser process, not the shared devtools/MCP profile). Cleared the group on
"R-123 QA Practice Client" (`665c0390-f01a-492c-a66b-be2ce383f976`, which had "R-161 QA Group") via
the API call the signed-in page itself would make (`fetch` + the page's own CSRF cookie):

```
[browser] PUT clientGroupId="" -> {"status":200,"body":{"data":{
  "id":"665c0390-…","clientGroupId":null,"linkCustomerId":null, … }}}
```

After a reload, the client's Details tab shows **Client Group —** (was "2386d799-…", the raw group
id — the app has no group picker, per R-161's fix.md, and no group-name display either).
Screenshot: `docs/audits/remediation/R-170/browser-client-group-cleared.png`.

Dev write: one field cleared (`client_group_id` → NULL) on Brightsphere's existing QA fixture
client, through the API as reporting-qa. No new row created, no migration needed.

## Historical data impact

None expected, and none to census. R-170 is a request-validation defect: the write path already
required an actual company-scoped write to reach the buggy cast (there is no route or script that
persists `''` today — the routes pass through whatever the caller sent, and every caller that
reaches this code today is the practice client UI, which either omits the field or sends a real
selected id; nothing in the app sends `''`). Unlike R-161 (a real cross-tenant write the fence
lets through), this bug only ever produced an in-flight 500 — no row was ever written with `''` in
`client_group_id`/`link_customer_id`, because the cast fails before the `INSERT`/`UPDATE` commits.
`client_group_id`/`link_customer_id` are typed `uuid`, so a stored `''` is not even representable in
the column; only NULL or a valid uuid can exist there. The read-only census for a **cross-tenant**
`client_group_id` is R-161's (`docs/audits/remediation/R-161/fix.md`, "Census SQL for production");
that one applies here unchanged since this fix doesn't touch which ids are accepted, only how `''`
and a malformed id are answered.
