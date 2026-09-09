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

---

## Round-2 review of 3d8ad9ba — MEDIUM-2 and MEDIUM-4 (both fixed)

**MEDIUM-2 (fixed).** Round 1's asset guard was right for `getCashBalance`'s aggregate but gave the
two per-account consumers a worse answer. What counts as a bank account for them is decided
elsewhere — `bankGlAccountBelongsToCompany` and `fetchCoverageAccounts` filtered on
`account_subtype = 'bank'` alone — so a liability overdraft was still accepted and still listed,
while its GL balance now read 0 through the `?? 0` fallback instead of its real value.
`bank_statement_coverage` then reported the whole statement balance as unexplained, and
`perform_bank_reconciliation`'s dry run reported `gl_balance: 0`.

Both predicates now carry `account_type = 'asset'`, so a non-asset account is never offered to
those paths at all and the three agree on one definition. The `?? 0` comment in
`bankStatementCoverageService` claimed something that stopped being true in round 1; it now says
the fallback is a floor against future drift rather than an honest zero.

**MEDIUM-4 (fixed).** `pages/api/accounting/cash-flow-export.ts:46` was the twelfth CASH_SUBTYPES
reader and the only one still unguarded. Worse than merely unguarded: its opening-cash expression
is `CASE WHEN ga.normal_balance = 'debit' THEN debit - credit ELSE credit - debit END`, so a
credit-normal card contributed its balance as a POSITIVE addition to opening cash. Pre-existing at
the merge base, but it is the last member of the set round 1 claimed to converge, and the CSV
disagreed with the on-screen cash flow it exports. Guard added; the round-1 comment's claim about
"every other reader" is narrowed to the readers it actually names.

**Tests.** New `tests/integration/k091b-bank-account-definition.int.test.ts`, 3 tests on real
Postgres against a liability overdraft typed `liability` with subtype `bank`: refused by
`bankGlAccountBelongsToCompany`, absent from `fetchCoverageAccounts`, and excluded from the
exported opening balance (R5,000, not the R5,900 the unguarded CASE produced). Mutations M13, M14
and M15 delete one guard each and turn exactly the matching test red.

**Historical-data impact.** No stored row changes. Any GL account typed other than `asset` with
subtype `bank` stops being selectable for statement import, disappears from the coverage report,
and stops contributing to the exported opening balance. The round-1 impact query in this file
finds every such account; the same rows are the ones affected here.
