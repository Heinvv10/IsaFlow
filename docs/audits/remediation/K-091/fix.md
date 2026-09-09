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

---

## Blind review of ade12166 — HIGH-1 (fixed)

**Finding.** The two reconciliation predicates got `account_type = 'asset'`, but the figure they
are compared against does not. `getCashFlowDirect().closingCash` is `openingCash + netChange`, and
`openingCash` comes from `bank/cashBalanceService#getCashBalance`, which filtered
`account_subtype = ANY(CASH_SUBTYPES)` with no account_type guard at all. So the two definitions
of cash still disagreed, now on the opening balance, and a credit card carried in from before the
period reproduced the exact symptom K-091 removes: a variance equal to the card balance and
`isReconciled` false on correct books.

**Disposition.** Fixed by adding `AND ga.account_type = 'asset'` to `getCashBalance`, not by
removing it from the reconciliation. That is the side three of the four cash readers were already
on (`cashFlowDirectService`'s movement half and both reconciliation predicates); adding it makes
all four agree, and it is the reading the K-091 fixture and the audit finding assume. The IAS 7
alternative — treating an overdraft repayable on demand as a cash equivalent — is a deliberate
accounting-policy change that would have to move all four together and is not made here.

**Blast radius.** `getCashBalance` is the registered owner of `cash.ledger.v1` and has three other
callers: `cashFlowDirectService.fetchOpeningCash`, `bankStatementCoverageService`, and the MCP
`perform_bank_reconciliation` tool. All three want asset cash, so none of them wanted the card.

**Test.** `tests/integration/k091-...int.test.ts` gains a R750 credit card balance posted
2025-12-01, before the period, plus a fourth test asserting `getCashBalance` at the exclusive
opening bound returns only the bank R5,000 and never the card account. Mutation M9: deleting the
new guard turns 2 of the 4 tests red (the petty-cash tie and the new opening-cash test).

**Historical-data impact.** No stored row changes. Reported cash falls by the balance of any
account typed `liability` (or anything but `asset`) whose subtype canonicalises into
`CASH_SUBTYPES`. Read-only query, not run against production:
```sql
SELECT ga.company_id, ga.account_code, ga.account_name, ga.account_type,
       SUM(jl.debit - jl.credit) AS balance
FROM gl_accounts ga
JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id AND jl.company_id = ga.company_id
JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
WHERE ga.account_subtype IN ('cash','cash_on_hand','petty_cash','bank_account','bank')
  AND ga.account_type <> 'asset'
GROUP BY ga.company_id, ga.account_code, ga.account_name, ga.account_type;
```
Any row this returns was previously being counted as cash and no longer will be.
