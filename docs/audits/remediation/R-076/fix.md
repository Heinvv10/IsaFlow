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

**Fix — typed error, not a string update.** Per the brief: assert the refusal
REASON, not the message. Added `BusinessUnitOwnershipError` (name + `reason:
'outside-company' | 'inactive'`) in `journalCostCentreValidation.ts`, thrown
in place of the two bare `Error`s the combined `buMessage` used to cover.
**Message text is unchanged** (`'Business unit must be active and belong to
this company'`), because four existing unit tests
(`journalCostCentreDimensionsDb.test.ts`, `journalDimensionAssignmentPolicy.test.ts`)
assert on that exact string — verified they still pass. The
K051 test now does:
```ts
const rejection = await inRequestTx(...).catch(err => err);
expect(rejection).toBeInstanceOf(BusinessUnitOwnershipError);
expect(rejection.reason).toBe('outside-company');
```
so a FUTURE reorder of validation, or a future message rewrite, cannot silently
pass this test for the wrong reason — the class + `reason` field is what's
pinned, not prose.

**Mutation proof.** Removed the `company_id` filter from the business-unit
ownership SELECT (`WHERE company_id = ${companyId}::UUID AND id = ANY(...)` →
`WHERE id = ANY(...)`) — reproducing the exact K-051 shape (another tenant's
row satisfies an unscoped lookup). Test went red: `rejection` was a plain
`{}` (a real journal got created), not a `BusinessUnitOwnershipError`.
Restored byte-identically via a pre-edit backup; all 10 tests green again.

**Affected:** `src/modules/accounting/services/gl/journalCostCentreValidation.ts`
(new exported `BusinessUnitOwnershipError` class, ~21 lines added),
`tests/integration/k051-cross-company-journal-line.int.test.ts` (one test's
assertion + import).

**Unit-test regression check:** `journalCostCentreDimensionsDb.test.ts`,
`journalDimensionAssignmentPolicy.test.ts`, `bankDimensionAssignmentPolicy.test.ts`,
`bankAllocationDimensionsDb.test.ts` — 12/12 passed unchanged (see gate lines).

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
identically on `origin/master`).

**Affected:** `tests/unit/components/ReportPageDrillDimensions.test.tsx` only.
No production code changed for R-093.

## Production impact SQL — none

All three are test-only defects (R-076/R-081: fixture/assertion; R-093: test
isolation). Nothing here required or produced production-impact SQL for Hein.

## Residual risk

- R-093's residual ~2-4% `waitFor`-timeout rate at 16-way self-contention is
  pre-existing on `origin/master` and out of scope for this batch — it is a
  generic default-timeout sensitivity under a contention level far past what
  CI actually runs (the K-072 note's own load ~21 measurement is system-wide
  parallel *worktrees*, not 16 copies of one file competing with itself).
  Flagging for the orchestrator to register separately if it recurs in real CI.
- R-081's `BusinessUnitOwnershipError` only distinguishes "outside company" vs
  "inactive" for the business-unit dimension. CC1/CC2 still throw a bare
  `Error` with a combined message (same shape R-081 fixed for BU) — not
  touched here because neither CC1 nor CC2 has a red test today; worth the
  same typed-reason treatment if one shows up.
