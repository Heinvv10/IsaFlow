# K-026 fix — below-threshold asset expense: write gate + idempotency

**Trigger.** `POST /api/accounting/assets/below-threshold` posted an unconditional
expense journal. Two ordinary sequential requests expensed the same asset twice
(2 400.00 debited for a 1 200.00 asset), and the route carried no `withWriteAccess`,
so a company `viewer` reached the ledger write.

**Before.** `withAuth(withCsrf(withErrorHandler(handler)))`; the POST branch SELECTed
the asset without a lock, never read `below_threshold`, and called
`postCapitalizationExpenseToGL`, which posts first and sets `below_threshold = true`
afterwards. Nothing read that flag back.

**After.** The route is wrapped `withWriteAccess` (owner/admin/manager), matching the
sibling `assets/[assetId]/dispose.ts` order. The POST branch selects the asset
`FOR UPDATE OF a` (company-scoped; `OF a` because `asset_categories` is joined LEFT and
is a shared reference table) and returns 400 "Asset has already been expensed" when
`below_threshold` is already true. `withAuth` runs each request in its own transaction,
so the lock is held until COMMIT and a concurrent second request blocks, then sees the
committed flag.

**Files.** `pages/api/accounting/assets/below-threshold.ts` (only production file).

**Tests.** `tests/integration/k026-below-threshold-expense-repeat.int.test.ts` —
7 tests, real Postgres, real handler: repeat POST posts once; account 6000 debited 1 200
once; viewer gets 403 and posts nothing; journal balances (Dr 1 200 = Cr 1 200);
another company's asset returns 404 and leaves that tenant with zero journals and its
flag unset; a body with no `assetId` returns 400 and posts nothing; two concurrent POSTs
yield [200, 400] and exactly one 700.00 journal.
Mutation-checked both ways — see `green.log`.

**Migration.** None. `below_threshold` already exists and is already written by the hook.

**Rollback.** Revert the single file; no data or schema change.

**Historical-data impact.** Assets expensed more than once carry duplicate
`auto_asset_expense` journals. Read-only query (NOT run against production):

```sql
SELECT je.company_id, je.description, count(*) AS postings, sum(jl.debit) AS debited
FROM gl_journal_entries je
JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.debit > 0
WHERE je.source = 'auto_asset_expense'
GROUP BY 1, 2 HAVING count(*) > 1
ORDER BY debited DESC;
```
Grouped by `description` (which carries the asset name and number) rather than
`reference`, because `reference` embeds the posting date and repeats across days would
not collapse. Existing duplicates are not corrected by this fix.

**Limits.** The guard keys on `below_threshold`, which nothing resets, so a legitimate
re-expense after a reversal is refused; if reversal becomes a supported workflow the
guard must key on a live journal instead. The validator's separate observation that the
journal credits `bank` (double-counting the spend when the purchase was already captured
as a bill or bank payment) is untouched here and needs its own K id.
