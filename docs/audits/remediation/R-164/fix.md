# R-164 — ClientRateOverrides.tsx shows a failed load as "No rate overrides yet"

- **Severity:** low
- **Area:** accounting/practice
- **Source:** R-123 fix (PR #569), 2026-09-29
- **Affected path:** `src/components/practice/ClientRateOverrides.tsx`

## Claim

`loadData` ignored a non-ok response from either the overrides or the staff endpoint (checked
`res.ok` and simply skipped `setState` on failure — never threw, never set `error`). A 500 from
`GET .../rate-overrides` or `GET .../staff` therefore rendered the same as a client that
genuinely has zero overrides: "No rate overrides yet" with an empty Staff Member dropdown. This
is why R-123 (the `auth.users` join failure) was invisible in the UI — the error was there, the
page just didn't say so. `handleDelete` had the identical flaw: it never checked the DELETE
response, so a failed delete silently reloaded the (unchanged) list with no error shown.

## Reproduction on dev (Brightsphere, reporting-qa@isaflow.dev)

Dev's `practice_client_rate_overrides` schema is missing R-121's later migrations (625b/626/699
— **not applied here per the batch-2 addendum**), so `GET
/api/accounting/practice/clients/665c0390-f01a-492c-a66b-be2ce383f976/rate-overrides` genuinely
500s on dev today:

```
500 {"success":false,"data":null,"message":"column pcro.user_id does not exist", ...}
```

captured via Playwright response listener against the running dev server (port 3224), while the
sibling `.../staff` call answered `200`.

- **Before (master, `docs/audits/remediation/R-164/before-no-rate-overrides-yet.png`):** the
  Rate Overrides tab for "R-123 QA Practice Client" shows "No rate overrides yet — Default rate
  profile rates will apply for all staff." No error, no indication anything failed.
- **After (this fix, `docs/audits/remediation/R-164/after-error-shown.png`):** the same tab, same
  500, now shows the server's own message ("column pcro.user_id does not exist") in the red error
  banner, and the misleading "No rate overrides yet" placeholder is gone.

## Root cause

```ts
if (overridesRes.ok) { ...setOverrides... }
if (staffRes.ok) { ...setStaff... }
} catch {
  setError('Failed to load rate overrides');   // never reached on a 500 — apiFetch resolves, doesn't throw
}
```

`apiFetch` (`src/lib/apiFetch.ts`) resolves on every status except 401 — see memory
`feedback_apifetch_resolves_on_4xx`. A caller that only branches on `res.ok` inside an `if`, with
no `else`, silently falls through with the state unchanged (`overrides`/`staff` stay `[]`) and
`loading` still flips to `false`, so the component renders the zero-rows empty state.
`handleDelete` had the same gap one level down: `await apiFetch(...)` with no `res.ok`/`assertOk`
check at all.

## Fix

- `loadData`: pass both responses through `assertOk` (the repo's established helper,
  `src/lib/apiFetch.ts`) before parsing JSON; the catch now reports the server's message via
  `apiErrorMessage`.
- `handleDelete`: capture the response and `assertOk` it before reloading; same catch/error
  pattern.
- Render: when `overrides.length === 0` **and** an error is set, render nothing in that slot
  (not the empty-state copy) — the error banner above already explains why the list is empty.
  When data was already loaded and a later delete fails, the existing rows keep rendering (the
  error banner appears above them; nothing is hidden that is still valid).
- `handleAdd` already checked `res.ok` and threw with the server's message — it did not have this
  flaw, so it is unchanged.
- Grepped every other file under `src/components/practice/*.tsx` that calls `apiFetch` directly
  (`BulkRangeModal.tsx`) or via `practiceApi.ts` (`WorkItemManager`, `KanbanBoard`,
  `TimeEntryForm`, `DayTotalsBar`, `PeriodPicker`): all already check `res.ok` or already route
  through `apiJson`/`assertOk`. `ClientRateOverrides.tsx` was the only file with this flaw.

## Tests

`tests/unit/components/clientRateOverridesLoadErrors.test.tsx` (component test, real component
render, mocked `apiFetch` only):

1. `shows an error, not "No rate overrides yet", when the overrides call 500s`
2. `shows an error when the staff call 500s, even though overrides load fine`
3. `renders overrides and staff normally on 200`
4. `shows an error when deleting an override 500s, instead of silently reloading`

RED on master (pre-fix): tests 1, 2 and 4 failed — 1 and 2 rendered "No rate overrides yet" /
never found the server message (test 1's crash trace confirmed the guard's absence causes an
`overrides.map` TypeError, since a failed load never produced an array); 4 never found "delete
failed" and the row that should still be there. Test 3 (the 200 case) passed on master too — it
was never broken, and stayed green through the fix.

## Mutation table

| Guard removed | Test that goes red | Assertion that fails |
|---|---|---|
| `assertOk(overridesRes, ...)` in `loadData` | `shows an error, not "No rate overrides yet", when the overrides call 500s` | render crashes on `overrides.map` (state never became an array) — same test, same file, now failing for the missing-guard reason |
| `assertOk(staffRes, ...)` in `loadData` | `shows an error when the staff call 500s, even though overrides load fine` | `await screen.findByText('staff lookup failed')` — never rendered |
| `assertOk(res, ...)` in `handleDelete` | `shows an error when deleting an override 500s, instead of silently reloading` | `await screen.findByText('delete failed')` — never rendered |
| `overrides.length === 0 && error ? null : ...` render guard | `shows an error, not "No rate overrides yet", when the overrides call 500s` | `expect(screen.queryByText('No rate overrides yet')).not.toBeInTheDocument()` — found the element instead |

Each mutation was applied to a scratch copy, the named test re-run and shown red on the listed
assertion, then the file was restored from the backup copy (`cp`, not `git checkout`) before the
next mutation.

## Browser evidence

- `docs/audits/remediation/R-164/before-no-rate-overrides-yet.png` — master, dev, real 500 from
  the overrides endpoint, shown as "No rate overrides yet".
- `docs/audits/remediation/R-164/after-error-shown.png` — same 500, same client, this fix: the
  server's error message is shown instead.
- Session: reporting-qa@isaflow.dev on Brightsphere (`d27bac33-cdc0-4e58-bf6b-709c1597d41c`),
  client "R-123 QA Practice Client" (`665c0390-f01a-492c-a66b-be2ce383f976`), dev server on
  `localhost:3224` from this worktree. No writes made to dev; both screenshots are GETs.

## Census SQL (read-only, for Hein — not run here)

`historicalDataImpact` for this item is `None` (it's a display defect, not a data defect). There
is nothing to census on prod for R-164 itself. As a read-only diagnostic for whether *other*
tenants would currently hit the same 500 this reproduction used on dev (R-123's `auth.users` join
gap, tracked separately), Hein can run on prod:

```sql
-- Read-only. Does app_user have the grant practiceClientRateOverrideService's LEFT JOIN auth.users needs?
-- If false, every company's rate-overrides screen 500s and would (pre-this-fix) have rendered as empty.
SELECT has_table_privilege('app_user', 'auth.users', 'SELECT');
```
