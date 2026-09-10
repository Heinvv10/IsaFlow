# K-029 round 5 — the depreciation page

All three findings are in `pages/accounting/depreciation/index.tsx`, the one
screen an operator reads after a run. It was untouched by rounds 1 to 4.

**MEDIUM-H — life-expired assets rendered as "GL Failed". A regression from
`90de5ede`.** That commit put life-expired rows into `results` with
`entryId: null`, and the page's two-state ternary painted every entry-less row
red. Nothing failed: the asset has no charge this period. A clean run looked
like it had failures, and the obvious response was to investigate one that never
happened. `runOutcome` now has a third state keyed on `lifeExpiredNote` — "No
charge", in the tertiary text colour — and the note itself renders under the
row, so the undepreciated balance finally reaches a human. That was the point of
round 4, and this page was where it stopped.

**MEDIUM-I — every amount rendered "RNaN". Pre-existing.** The page declared its
own `DepResult { amount: number }` and asserted it over the parsed JSON. The API
has never returned `amount`; the service row carries `policyDep` and `taxDep`,
at `origin/master` and at every commit on this branch. `Intl.NumberFormat.format(undefined)`
is the string `NaN`, so "Last Run Results" showed `RNaN` on every line and `tsc`
could not see it, because the local interface hid the mismatch. The page now
imports `DepreciationRunResult` and `DepreciationRunResultRow` from the service
as `import type`, erased at compile time so nothing server-side reaches the
client bundle, and renders `policyDep`.

**LOW-J — the header still advertised straight line.** It now describes each
asset's own method.

**Also fixed, found while editing the same file.** The register's "Monthly Dep."
column computed `(price − salvage) / life / 12` inline, the identical hard-coded
straight line this programme removed from the CSV export and the asset detail
page. For a reducing-balance asset it printed 1 666.67 beside a GL carrying
1 200.00. It now calls `calculatePolicyDepreciation` through `monthlyCharge`.

## Tests

`tests/unit/components/depreciationRunResults.test.tsx` (new, 5) renders the
real page against a stubbed `apiFetch`, with `AppLayout` mocked because
`next/font` cannot resolve outside a Next runtime and would make every assertion
vacuous. It asserts: a life-expired row reads "No charge" while exactly one
genuinely failed row still reads "GL Failed"; the note text appears; no "NaN"
anywhere and the two hand-computed amounts render; the straight-line copy is
gone; and the register quotes 1 200,00 rather than 1 666,67 for a
reducing-balance asset. Five mutations — restoring the two-state ternary,
hiding the note, reverting to `amount`, restoring the old copy, and restoring
the inline straight-line column — each turn a test red.

## Limits

The register's category filter and its book-value columns are unchanged. Browser
proof of the rendered page is taken at deploy time on Demo; this is a jsdom
render, which is why the assertions are on text a user reads rather than on
class names.
