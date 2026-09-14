# R-076, R-081, R-093 — three master-red/flaky tests

Branch `fix/audit-r076-r081-r093-master-red-tests`, from `origin/master` `7d708aac1`.
No production schema change and no migration in this batch.

## R-076 — supplierStatementBalances.int.test.ts shadow tables lack `deleted_at`

**Reproduction.** Confirmed red on a clean checkout of the branch tip before any
edit: `bunx vitest run --config vitest.integration.config.ts --no-file-parallelism
tests/integration/supplierStatementBalances.int.test.ts` failed with
`error: column si.deleted_at does not exist` (pg code 42703), raised from
`getAPAging` via `documentInLedgerAsAtFragment('si', ...)` — the K-053 soft-delete
predicate the shadow `supplier_invoices` TEMP table never gained a column for.

**Root cause.** The test hand-typed 8 columns per shadow table
(`suppliers`, `supplier_invoices`, `supplier_payments`, `payment_allocations`,
`credit_notes`). K-053 added a `deleted_at`/`gl_journal_entry_id`-reading
predicate to the production query months after the fixture was written, so the
fixture and the production schema silently diverged — exactly the shape the
brief's "never make a fixture friendlier than production" rule warns about,
just via omission this time.

**Fix.** Rebuilt every shadow table as `CREATE TEMP TABLE ... (LIKE <real_table>
INCLUDING ALL) ON COMMIT DROP`, so the fixture is DERIVED from the live schema
(including `deleted_at`, defaults, generated columns, CHECK constraints) and
cannot drift out from under the service again. Switched every `INSERT` to a
named-column list (positional `VALUES` no longer matches a 48-column table) and
added the NOT NULL columns the real schema requires that the old hand-rolled
shape omitted (`invoice_number`, `created_by` on three tables).

**Mutation proof.** Changed `getSupplierStatementBalances`'s credit-note branch
from `applied_amount` to `total_amount` (the applied vs. unapplied-excess
distinction the comment above it explains) — test went red
(`onAccount: 25` expected, `onAccount: 0` / `netBalance: 85` received).
Restored byte-identically; test green again.

**Affected:** `tests/integration/supplierStatementBalances.int.test.ts` only.

## R-081 — k051-cross-company-journal-line.int.test.ts business-unit message drift

**Reproduction.** 10 tests in the file; 9 passed, 1 red on the branch tip:
`refuses a line tagged to another company business unit, and writes nothing`
expected `/business unit outside this company/` but
`assertJournalAnalysisDimensions` (PR #418, `journalCostCentreValidation.ts`)
throws `'Business unit must be active and belong to this company'` — a single
message now covering BOTH "not owned by this company" and "owned but
inactive", where the old wording distinguished them.

**Confirmed the seed isolates the right condition** before touching anything:
`foreignBu` is seeded with the default `is_active = true`, so the only thing
wrong with it in the failing test is that it belongs to `otherCompany` — an
inactive-BU guard could not pass this test for the wrong reason.

**Round 1 fix (superseded — see round 2 below).** Added a typed
`BusinessUnitOwnershipError` (name + `reason`) so the test could assert the
refusal reason instead of the message. The blind review (round 1,
`rev-r076a`) found this pinned the implementation CLASS, not the outcome:
its mutation N4 — re-adding a legacy `assertDimensionOwned('business unit',
...)` check BEFORE `assertJournalAnalysisDimensions` in
`journalLineOwnership.ts`, so a DIFFERENT, earlier guard refuses the line
first — still refuses the line and writes nothing, yet the test went red
demanding the specific class. That is exactly the brittleness R-081 was
registered to remove: PR #418 already broke this test once by reordering
validation, and a class pinned to one arm breaks again the next harmless
reorder. The review also noted the class had no caller besides this test.

**Round 2 fix — assert the outcome, not the mechanism.**
`journalCostCentreValidation.ts` reverted to `origin/master` byte-for-byte
(`BusinessUnitOwnershipError` removed). The test now asserts only what the
seed actually guarantees — the cross-company condition is the ONLY thing
wrong with `foreignBu`, so ANY refusal is refusing that:
```ts
await expect(inRequestTx(() => createJournalEntry(company, {
  ...,
  lines: [{ glAccountId: own, debit: 700, credit: 0, buId: foreignBu }, ...],
}, user))).rejects.toThrow();

const { rows: lineRows } = await pool.query(
  'SELECT COUNT(*)::int AS n FROM gl_journal_lines WHERE bu_id=$1', [foreignBu]);
expect(lineRows[0].n).toBe(0);
const { rows: entryRows } = await pool.query(
  `SELECT COUNT(*)::int AS n FROM gl_journal_entries
   WHERE company_id=$1 AND description='K051X foreign business unit'`, [company]);
expect(entryRows[0].n).toBe(0);
```
No production code changes for R-081 at all now — `journalCostCentreValidation.ts`
matches `origin/master`.

**Mutation proof (round 2).**
1. Re-applied the reviewer's exact N4 mutation (an earlier `assertDimensionOwned('business unit', ...)`
   check in `journalLineOwnership.ts`, before `assertJournalAnalysisDimensions`) —
   the line is still refused via a DIFFERENT guard ("... name a business unit
   outside this company" instead of the analysis-dimensions message) and
   nothing is written. Test stayed GREEN, confirming the brittleness is gone.
   Reverted byte-identically.
2. Removed the `company_id` filter from the business-unit ownership SELECT in
   `journalCostCentreValidation.ts` (the real K-051 shape) — a plain journal
   got created (no rejection at all). Test went RED. Restored byte-identically;
   all 10 green again.

**Affected:** `tests/integration/k051-cross-company-journal-line.int.test.ts`
only (one test's assertions + import removed). No production file touched.

## R-093 — ReportPageDrillDimensions.test.tsx intermittent under load

**Reproduction.** Could not reproduce running the file alone, even with 28
CPU-bound busy-loop processes competing for the host's 32 cores (20/20 clean,
matching the K-072 round-36 reviewer's own null result). Reproduced instead by
running 16 copies of the file's own `vitest` process concurrently (real system
contention, not synthetic busy-loops) — round 1 of 16 parallel runs produced:

```
FAIL  balance sheet carries a selected business unit through report, exports, links, transactions and evidence
- ArrayContaining [ StringMatching /balance-sheet-export.*business_unit_id=business-a/, ... ]
+ [ "/api/accounting/income-statement-export?period_start=...&business_unit_id=business-a",
    "/api/accounting/income-statement-xlsx?...&business_unit_id=business-a" ]
```

The BALANCE SHEET test's `window.open` spy contained the INCOME STATEMENT
test's URLs — proof the reviewer's "theoretical" gap was real, and a different
mechanism than the apiFetch snapshot-index guard R-085 added.

**Root cause (two compounding gaps, both in the test, not production code).**

1. `vi.spyOn(window, 'open')` is called fresh in the two business-unit tests,
   but `afterEach` never restores it. `vi.spyOn` on an ALREADY-spied method
   returns the SAME spy object rather than creating a new one — so the
   "balance sheet" test's `open` variable is literally the "income statement"
   test's spy, `.mock.calls` history and all.
2. The `waitFor` immediately before the Export clicks only proves the report
   fetch was ISSUED (`apiFetch`'s call is recorded synchronously at call time),
   not that its response resolved through the two `.then()`s that set
   `report` into state. The Export buttons are `disabled={!report}`. Under
   load, the gap between "request issued" and "report state set" is wide
   enough that the click can land on a still-disabled button — a silent
   no-op — leaving ONLY the leaked prior-test calls (gap 1) for the
   assertion to read, which is what actually failed.

Neither gap alone reproduces the failure: with the spy properly isolated, a
premature click on a disabled button correctly reads an EMPTY array (an honest
failure of the same test, not a stale cross-test artifact) — 130 combined
stress runs of the fixed file (16×3 + 16×4 rounds under 16-way self-contention)
produced only the same ~4% generic `waitFor`-timeout rate `origin/master`'s own
unfixed file shows at that same, deliberately unrealistic contention level (2
timeouts / 48 runs baseline vs. 1–2 / 48–64 fixed) — i.e. residual noise from
running 16 heavy React-mounting Vitest processes against each other on one
box, present identically before this fix, not the defect R-093 registers.

**Fix.**
- `afterEach` now calls `vi.restoreAllMocks()` after the existing
  `cleanup()` / `apiFetch` reset, so every test's `vi.spyOn(window, 'open')`
  starts from the real (unmocked) `window.open` and gets its own clean
  `.mock.calls`.
- Both business-unit tests now `await waitFor(() =>
  expect(screen.getByRole('button', {name:'Export CSV'})).not.toBeDisabled())`
  before firing the Export clicks, so the click always lands once `report`
  state is actually set, not merely once the fetch was issued.

**Mutation proof.** Removed the `vi.restoreAllMocks()` line and re-ran the
original (master) file at the same 16-way-parallel stress level that first
reproduced the defect: the exact stale-cross-test-URL failure recurred
(`r093_p_1.log`, captured before any fix was applied — this run WAS
`origin/master`'s code, unedited). Restored the fix; re-ran 48 more stress
runs with `restoreAllMocks()` back in place and the same defect did not
recur (only the pre-existing generic-timeout noise described above, present
identically on `origin/master`). The independent blind review (`rev-r076a`)
reran this same probe with a 300ms-delayed mocked response instead of raw
CPU contention and got the identical result: base fails deterministically
with the registered signature, head passes; splitting the two fixes apart
confirmed `waitFor(not disabled)` is what removes the race and
`restoreAllMocks` turns a masked failure into an honest one rather than
hiding anything.

**Round 2 addition — LOW-2 (per-export business-unit assertion).** The blind
review found the income-statement business-unit test's export assertion used
one shared `stringContaining(businessUnitId)` check across BOTH exports
(`toHaveBeenCalledWith` + a plain `arrayContaining` of path names) — mutating
EITHER `income-statement.tsx` export handler to drop `business_unit_id`
still left the test green, because the other export's URL alone satisfies
both checks. The balance-sheet test right below already does this correctly.
Changed the income-statement assertion to mirror it — one `stringMatching`
pattern per export, each requiring the BU:
```ts
expect(open.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
  expect.stringMatching(/income-statement-export.*business_unit_id=business-a/),
  expect.stringMatching(/income-statement-xlsx.*business_unit_id=business-a/),
]));
```
Mutation-proofed both arms: dropping `business_unit_id` from
`handleExport` (CSV) alone → red; restored; dropping it from
`handleXlsxExport` (xlsx) alone → red; restored. Both are pre-existing
`income-statement.tsx` code, unchanged by either mutation test.

**LOW-3 — noted, not fixed here.** The review's own 16-way stress (2 rounds
of 16, load 34-38) found the SAME residual `waitFor`-timeout class on both
base and head — 2/32 vs 1/32 — confirming it is pre-existing and not
introduced by this commit. R-076/R-081/R-093's stale-cross-test-URL race is
fixed; this separate default-timeout sensitivity under extreme self-
contention is NOT — see Residual risk below for what it is and why it's out
of scope.

**Affected:** `tests/unit/components/ReportPageDrillDimensions.test.tsx` only.
No production code changed for R-093.

## Production impact SQL — none

All three are test-only defects (R-076/R-081: fixture/assertion; R-093: test
isolation). Nothing here required or produced production-impact SQL for Hein.

## Residual risk

- R-093's residual `waitFor`-timeout rate at 16-way self-contention (~2-6%
  across both this fixer's and the independent reviewer's stress runs) is
  pre-existing on `origin/master` and out of scope for this batch — it is a
  generic default-timeout sensitivity under a contention level far past what
  CI actually runs (the K-072 note's own load ~21 measurement is system-wide
  parallel *worktrees*, not 16 copies of one file competing with itself). Not
  fixed here; the lead is registering it as a separate item. This commit
  fixes the registered R-093 defect (the stale cross-test `window.open`
  leak) — it does not claim the file no longer flakes under any load.
