# K-091 fix — cash flow reconciliation defines cash the way the direct statement does

**Trigger.** `cashFlowReconciliationService.ts` filtered cash with the SQL literal
`ga.account_subtype = 'bank'` in both `fetchIndirectClosingCash` and `fetchBankBalance`.
The figure it compares against — `getCashFlowDirect(...).closingCash` — resolves cash
through `CASH_SUBTYPES`, which spans the canonical `bank` and `cash` tokens and every raw
spelling mapping to them (`bank_account`, `petty_cash`, `cash_on_hand`). Any company
holding petty cash, or spelling its bank account anything but `bank`, saw a variance equal
to that balance and `isReconciled: false` on correct books.

**Before / after.** Fixture company with R5,000 opening bank, R1,000 receipt, R400 float to
petty cash and R150 petty spend. Before: `bankBalance` and `indirectClosing` 5600 against a
`directClosing` of 5850, variance R250, `isReconciled` false. After: all three 5850,
variance 0, reconciled.

**Files.** `src/modules/accounting/services/afs/cashFlowReconciliationService.ts` — import
`CASH_SUBTYPES` and replace both predicates with
`ga.account_subtype = ANY(${CASH_SUBTYPES}) AND ga.account_type = 'asset'`. The
`account_type` half keeps a credit card spelled `bank_account` out of cash.

**Tests.** `tests/integration/k091-cash-flow-reconciliation-bank-subtype.int.test.ts`,
3 tests, real Postgres: the petty-cash tie, the credit-card exclusion, and tenant scoping
against a second company holding R7,777 of its own bank cash.

**Mutation check.** Reverting the service to `origin/master` turns all 3 red; deleting only
the `account_type = 'asset'` line also turns all 3 red. Restored, 3 pass.

**Migration / rollback.** None. Revert the commit.

**Historical-data impact.** Read path — no stored row is wrong. Every reconciliation reading
ever displayed to an affected company was wrong. Size the exposure read-only:

```sql
SELECT ga.company_id,
       COUNT(*) FILTER (WHERE ga.account_subtype <> 'bank') AS invisible_cash_accounts
FROM   gl_accounts ga
WHERE  ga.account_type = 'asset'
  AND  ga.account_subtype IN ('cash','cash_on_hand','petty_cash','bank_account')
GROUP  BY ga.company_id;
```

**Limits.** The reported `bankBalance` tile will move for any company with petty cash. That
is the correction, but it will read as a change to a daily viewer.
