# K-020 fix — reconciled balance recomputed live

**Trigger.** A user posts a bank reconciliation adjustment (`createAdjustmentEntry`, the
only call site of `updateReconciledBalance`) on a reconciliation that already holds
matched bank rows.

**Before.** `reconciled_balance = gl_balance + SUM(bank_transactions.amount)` over
matched/reconciled rows, where `gl_balance` is the frozen snapshot written at
`startReconciliation`. Matching only stamps a bank row against an already-posted GL
line, so its amount was counted twice; the adjustment journal posted moments earlier
never entered the frozen column at all. Validator fixture: expected 1050, stored 2000,
`difference` -950 instead of 0.

**After.** `gl_balance` and `reconciled_balance` are both recomputed from posted
`gl_journal_lines` on the reconciliation's own `bank_account_id`, dated on or before
`statement_date`, scoped to `company_id`. The `SUM(amount)` term is gone.
`difference` is a generated column (`statement_balance - reconciled_balance`,
migration 203) so the required contract holds unchanged.

**Files.** `src/modules/accounting/services/bank/bankReconciliationService.ts`
(`updateReconciledBalance`, 262-283). No API, type or UI change: the reconciliation
page reads `glBalance`, `reconciledBalance` and `difference` and carries no copy
describing the old formula.

**Tests.** `tests/integration/k020-reconciled-balance-double-count.int.test.ts` (1) —
the validator's RED case. `tests/integration/k020-reconciled-balance-recompute.int.test.ts`
(3) — tenant isolation of a foreign line on the same `gl_account_id`, draft entries
excluded, entry dated after `statement_date` excluded and one dated exactly on it
included, matching a transaction does not move the balance, and a wrong `company_id`
updates nothing. 4 passed against the real fixture database. Full unit suite with
`DATABASE_URL` unset: 9320 passed, 234 skipped across 820 files, no regressions.

**Mutation check.** Reverting the production change turns 3 of the 4 red
(2000 vs 1050; 800 vs 400 twice). See `green.log`.

**Migration / rollback.** None. Behaviour-only change; revert the commit to roll back.

**Historical-data impact.** Stored balances are wrong wherever this ran. Read-only:
```sql
SELECT br.id, br.company_id, br.bank_account_id, br.statement_date,
       br.gl_balance, br.reconciled_balance, br.difference, br.status
FROM bank_reconciliations br
WHERE br.reconciled_balance <> br.gl_balance;
```
Rows are corrected on the next adjustment; in-progress reconciliations move back
towards a closeable `difference`. Completed ones keep the wrong stored figure until
someone reopens them — no backfill is included here.

**Limits.** Whether unpresented items should be added back to `reconciled_balance` is
an accounting decision left unchanged. No concurrency claim is made: the helper remains
one atomic UPDATE, as before.
