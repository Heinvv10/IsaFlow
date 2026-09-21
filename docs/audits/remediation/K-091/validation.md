# K-091 — cash flow reconciliation hardcodes the bank subtype

**Claim.** Direct cash flow and the pre-export checks use bank *plus* cash, so a petty-cash
balance produces a false variance.

**Corrected trigger.** The mismatch is inside `cashFlowReconciliationService.ts`. Both of its
queries — `fetchIndirectClosingCash` (line 38 on `origin/master`) and `fetchBankBalance`
(line 58) — filter `ga.account_subtype = 'bank'`, a SQL *literal*. The figure they are compared
against, `getCashFlowDirect(...).closingCash`, resolves cash through
`CASH_SUBTYPES` (`src/modules/accounting/services/gl/accountSubtypes.ts`), which spans the
canonical `bank` **and** `cash` tokens and every raw spelling that maps to them —
`bank_account`, `petty_cash`, `cash_on_hand`. Two definitions of cash, one comparison.
The pre-export checks are not involved: `afsPreExportChecks.ts:362` reads only
`low_res_warning` from `afs_uploaded_images`.

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:src/modules/accounting/services/afs/cashFlowReconciliationService.ts`
  lines 38 and 58 — `WHERE ga.account_subtype = 'bank'`.
- `git show origin/master:src/modules/accounting/services/afs/cashFlowDirectService.ts:109` —
  `WHERE ga_cash.account_subtype = ANY(${CASH_SUBTYPES})`, and `getCashBalance` at
  `bank/cashBalanceService.ts:143` does the same for opening cash.
- Executed: `tests/integration/k091-cash-flow-reconciliation-bank-subtype.int.test.ts`
  against the disposable schema fixture. 1 test, 1 failed. Service log line from the run:
  `directClosing: 5850, indirectClosing: 5600, bankBalance: 5600, variance: 250` — the R250
  is exactly the petty-cash balance. `red.log` in this directory.

**Reachability.** `GET /api/accounting/afs/[documentId]/statements/cash-flow-reconciliation`
(line 19) calls it directly; `AfsOverviewTab.tsx` renders the result. No admin gate.

**Proposed minimal fix.** In `cashFlowReconciliationService.ts`, import `CASH_SUBTYPES` from
`@/modules/accounting/services/gl/accountSubtypes` and replace both
`ga.account_subtype = 'bank'` predicates with
`ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}) AND ga.account_type = 'asset'`.
The `account_type` half matters: a credit-card liability spelled `bank_account` would
otherwise be summed as cash — `afs-cash-flow-direct.int.test.ts` already pins that case for
the direct statement.

**Historical-data impact.** No rows are wrong; this is a read path. What is wrong is every
reconciliation *reading* ever shown, on any company holding petty cash or spelling its bank
account anything but `bank` — `isReconciled: false` and a `log.warn` on correct books. Rank
the exposure read-only with:

```sql
SELECT ga.company_id,
       COUNT(*) FILTER (WHERE ga.account_subtype <> 'bank') AS invisible_cash_accounts
FROM   gl_accounts ga
WHERE  ga.account_type = 'asset'
  AND  ga.account_subtype IN ('cash','cash_on_hand','petty_cash','bank_account')
GROUP  BY ga.company_id;
```

**Risks.** Widening the filter changes the reported `bankBalance` for any company with petty
cash, so a variance that was previously reported will disappear. That is the fix, but anyone
reading the tile day to day will see the number move.
