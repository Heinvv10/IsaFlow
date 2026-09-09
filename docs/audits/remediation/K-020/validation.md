# K-020 — Reconciled balance double-counts matches and ignores adjustments

**Claim.** The helper adds matched transaction amounts to a stale stored GL balance and never incorporates the adjustment journal it was called to reflect.

**Corrected trigger.** `updateReconciledBalance` has exactly one call site, `createAdjustmentEntry` (line 171). The wrong figure appears the moment a user posts a reconciliation adjustment on a reconciliation that already holds matched rows.

**Disposition: confirmed.**

## Evidence
`git show ebeac9ca:src/modules/accounting/services/bank/bankReconciliationService.ts`:
- 78-99: `gl_balance` and `reconciled_balance` are a snapshot of posted bank-account journal lines as at `statement_date`, frozen into the row.
- 262-277: `reconciled_balance = gl_balance + SUM(amount)` over matched/reconciled bank transactions. `gl_balance` is the frozen column, never re-read, so the adjustment journal posted two lines earlier is invisible.
- Matching (`bankTxStatusMutations.ts:69-94`) only stamps a bank row against an already-posted line. That movement is already inside `gl_balance`, so adding the bank amount counts it twice.
- File unchanged between 5661d6f0 and ebeac9ca.
- RED `tests/integration/k020-reconciled-balance-double-count.int.test.ts` (1 failed): GL bank 1000, statement 1050, one matched R1000 transaction, then a R50 adjustment. Expected `reconciled_balance` 1050 / `difference` 0; actual 2000 and -950. Log: `red.log`.
- Test note: the bank row is seeded in the state `matchTransaction` leaves, because that function requires the withAuth request transaction. The defect under test is the arithmetic, not the transition.

## Reachability
`createAdjustmentEntry` is the adjustment action in the bank reconciliation UI. Any company reconciling a bank account reaches it.

## Proposed minimal fix
Replace the frozen-column arithmetic in `updateReconciledBalance` with a live recompute of the bank GL balance as at the reconciliation's `statement_date` (the SELECT at lines 78-85, correlated to the header's `bank_account_id`), and drop the `+ SUM(bank_transactions.amount)` term. Refresh `gl_balance` from the same subquery so the two cannot drift. Whether unpresented items are then added back is an accounting decision; both defects are independent of it.

## Historical-data impact
```sql
SELECT br.id, br.company_id, br.statement_date, br.gl_balance, br.reconciled_balance, br.difference, br.status
FROM bank_reconciliations br WHERE br.reconciled_balance <> br.gl_balance;
```
`difference` gates `completeReconciliation` (line 125), so the practical effect is reconciliations that cannot be closed, plus a wrong stored balance on ones already closed.

## Risks
Recomputing live moves the figure on existing in-progress reconciliations (mostly back towards a closeable difference). UI copy describing `reconciled_balance` as "GL plus matched" must change with it.
