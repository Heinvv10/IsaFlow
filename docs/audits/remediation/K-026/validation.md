# K-026 - Below-threshold assets expensed repeatedly and without write access

**Claim (BB F19):** The route has no `withWriteAccess`, no lock and no already-expensed guard,
so repeated requests post the expense again.

**Corrected trigger:** Both halves hold, and they are independent. No concurrency is needed -
two ordinary sequential POSTs post two journals, because nothing on the asset is read back as
an idempotency key.

**Disposition: confirmed.**

## Evidence
- `git show ebeac9ca:pages/api/accounting/assets/below-threshold.ts:75`
  `export default withAuth(withCsrf(withErrorHandler(handler)))` - no `withWriteAccess`.
  `grep -L withWriteAccess pages/api/accounting/assets/*.ts` returns all five files; this is the
  only one with a POST branch.
- Same file lines 49-69: SELECT the asset, check `checkCapitalizationThreshold`, call
  `postCapitalizationExpenseToGL`. No `FOR UPDATE`, no read of `a.below_threshold`, no status
  transition, no idempotency key.
- `src/modules/accounting/services/gl/glCrossModuleHooks.ts:248-291`
  `postCapitalizationExpenseToGL` unconditionally creates and posts a journal
  (debit `default_expense`, credit `bank`) and only then sets `below_threshold = true`.
  Nothing anywhere reads that flag as a guard.
- `src/lib/auth/withWriteAccess.ts` - the gate exists and returns 403 for `viewer` on POST.
- File unchanged between 5661d6f0 and ebeac9ca.

## Reachability
`POST /api/accounting/assets/below-threshold` with `{assetId}`. Any authenticated member of the
company, including a `viewer`, reaches the ledger write.

## RED test
`tests/integration/k026-below-threshold-expense-repeat.int.test.ts` - real Postgres, real HTTP
handler through `withAuth`. 3 tests, 3 failing (`red.log`):
- two sequential admin POSTs produce 2 `auto_asset_expense` journals (expected 1);
- account 6000 debited 2400.00 for a 1200.00 asset;
- a `viewer` POST returns 200 and posts a journal (expected 403, no journal).

## Proposed minimal fix (3-6 lines)
1. `pages/api/accounting/assets/below-threshold.ts:75` - wrap with `withWriteAccess`:
   `withAuth(withCsrf(withErrorHandler(withWriteAccess(handler))))`.
2. In the POST branch, lock and guard before posting: `SELECT ... FOR UPDATE` on the asset and
   `if (asset.below_threshold === true) return apiResponse.badRequest(res, 'Asset already expensed')`.
   `below_threshold` is already the flag `postCapitalizationExpenseToGL` sets, so it becomes the
   idempotency key at no schema cost.

## Adjacent concern (not in the claim)
The journal credits the `bank` system account. If the asset purchase was already captured as a
bill or bank payment, this expense double-counts the spend and credits bank a second time. Worth
its own K id; do not change the accounts as part of this fix.

## Historical-data impact
Any asset expensed more than once carries duplicate `auto_asset_expense` journals. Read-only
impact query:

```sql
SELECT je.company_id, je.reference, count(*) AS postings, sum(jl.debit) AS debited
FROM gl_journal_entries je
JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.debit > 0
WHERE je.source = 'auto_asset_expense'
GROUP BY 1,2 HAVING count(*) > 1
ORDER BY debited DESC;
```
The `reference` is `EXP-<assetNumber>-<YYYY-MM-DD>`, so repeats on the same day collapse to one
reference and repeats across days do not - group by asset number instead if the date differs.
NOT run against production.

## Risks
Adding `withWriteAccess` changes a 200 to a 403 for viewers who currently use this action. Adding
the `below_threshold` guard will refuse a legitimate re-expense after a reversal, because nothing
resets the flag. If reversal is a supported workflow, the guard must key on a live journal, not
the boolean.
