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

**SUPERSEDED by round-3 HIGH-1 below.** Round 2 added `account_type = 'asset'` to both predicates,
which closed the leak by opening its mirror: the account vanished from the report instead of
showing an unexplained difference. Round 4 reverses that half and flags the row instead. The `?? 0` comment in
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


---

## Round-3 blind review of 6feb7687f — 9 findings, all disposed (round 4)

**HIGH-1 (fixed, by reversing round 2's half of MEDIUM-2).** Narrowing `fetchCoverageAccounts` and
`bankGlAccountBelongsToCompany` to `account_type = 'asset'` made a subtype-`bank` account typed
`liability` — the shape of the module's 27 mis-classified production paycards — disappear from the
coverage report with every statement line imported against it, and made statement import refuse an
id the picker, bulk preview, bulk commit and feed pairing all still accept. Both guards are removed
again. Two questions share the word "bank" and now have one answer each: which accounts HOLD bank
transactions is `account_subtype = 'bank'` (coverage, importer, picker, bulk paths, cash-movement),
and which balances COUNT AS CASH is `CASH_SUBTYPES AND account_type = 'asset'` (`cashBalanceService`
and every cash-flow reader). A listed non-asset account carries `misclassified: true` through to
`bank_statement_coverage`, the report's only consumer, and its whole statement balance is stated as
unexplained. Both directions are pinned: mutations M1/M3/M12 (re-narrow, drop the flag) and M2 (drop
the cash guard) each turn the matching test red.

**MEDIUM-1 (fixed by the same change).** The nine bare `account_subtype = 'bank'` call sites are now
correct rather than inconsistent: every one of them asks the "holds transactions" question. No call
site is rewritten. Known limit: they all match the literal `'bank'`, so an account spelled
`bank_account` is invisible to all nine equally — a separate defect, not this one.

**MEDIUM-2 (fixed).** `afsKpiService.fetchCash` / `fetchClosingCash` now use
`CASH_SUBTYPES AND account_type = 'asset'`, so the KPI block and the cash-flow statement in the same
AFS export agree. New test: the May cash-burn KPI equals the fall `getCashBalance` reports over the
same month. Mutating either half alone turns it red (M6a, M6b).

**MEDIUM-3 (fixed).** `company_id` added to the customer, supplier and original-invoice joins in
`creditNotePdfBuilder`, and to the customer and project joins in `invoicePdfBuilder` and
`quotePdfBuilder`. Tenant-drift tests on all three assert another tenant's name, VAT number, address
and invoice number are never printed (M8, M10, M11).

**MEDIUM-4 (fixed).** `vatLineAllocation.allocateVatToLines` shares the authoritative header VAT out
across the lines by largest-remainder, so the printed VAT column sums to the printed VAT total
exactly; header VAT no line can account for is returned as `unattributed`, printed on the page and
logged rather than spread onto zero-rated lines. Seven R14.29 lines at 15% now print a column
summing to R15.00 rather than R14.98 (M7). The quote table prints rates rather than amounts, so it
gets the disagreement notice only (M9).

**LOW-1 (fixed).** `COALESCE(ci.status, '') <> 'cancelled'` in the route, and the k093 oracle now
uses the same COALESCE instead of mirroring the route's bug. A NULL-status invoice is seeded and
asserted present (M4).

**LOW-2 (fixed).** Each unresolvable id gets its own `Unknown customer (<id>)` label, in the JSON and
the CSV; two drifted invoices from different other-tenant customers are asserted distinguishable (M5).

**LOW-3 (fixed).** The `to_regclass` probe and the dead `credit_note_items` branch are deleted; the
credit note renders from its header totals. There is no line table in the schema at all — adding one
is a schema change, raised separately, not a runtime probe.

**LOW-4 (fixed).** Rebased onto `origin/master`; the six integration files were re-run green on the
new base. The nine intervening master commits are settings/report UI only and touch none of these
files.

**Tests (round 4).** 39 tests across 6 integration files, all green on the fixture DB; full unit
suite 9559 passed / 243 skipped with `DATABASE_URL` unset; `tsc --noEmit` and `eslint` clean.

**Historical-data impact (round 4).** No stored row changes. Non-asset `bank` accounts return to the
coverage report and to statement import — the state before round 2, plus a flag. Find them read-only:
```sql
SELECT company_id, account_code, account_name, account_type, account_subtype
FROM   gl_accounts
WHERE  account_subtype = 'bank' AND account_type <> 'asset'
ORDER  BY company_id, account_code;
```
Every such account is a chart-of-accounts defect to correct at source; the report now names them
instead of hiding them. Invoice PDFs re-rendered for an invoice whose stored `tax_amount` disagrees
with its lines will now print a red note stating the unattributable amount.

---

## Round 5 — the six findings of review-k091-r4

**HIGH-1 (fixed).** `allocateVatToLines` no longer divides by `Σ weights`. Each line keeps its own
`round2(amount × rate)`; only the residual is moved, and only while it is within one cent per RATED
line. Beyond that the header is disagreeing with its lines, not rounding, and the excess is returned
as `unattributed` — printed in red on the invoice and `log.warn`ed. A R100 line at 15% under a R30
header now prints R15.00 with a note for the other R15.00, not R30.00 in silence.

**MEDIUM-1 (fixed).** One definition of "does this account hold bank transactions?". Twenty-six
SQL sites move from the literal `'bank'` to `account_subtype = ANY(BANK_SUBTYPES)`, and the
TypeScript comparisons in four files (`bankReconciliationService`, `accountReclassifyService`,
`accountReportingClass`, `bank-accounts`) to the new `isBankSubtype`. The nine the review enumerated, plus every other
site that selects GL accounts as bank accounts — `bankAccountStatusService` (`cash.statement.v1`,
which the coverage report prints beside `cash.balance.v1`), `kpiDashboardService`, `kpiChartsService`,
`cash-movement`, `consolidatedReportingService`, `openingBalanceReadService`, `hasBankAccountService`,
`bureauClientMetricsService`, `sageMigrationOrchestrator` — because widening coverage alone would
have moved the disagreement one report to the left rather than removing it.

**MEDIUM-2 (fixed).** Same change as HIGH-1. Nothing divides by `Σ weights`, so mixed-sign weights
cannot explode: `hdr=15, weights=[100, −99.999999]` now yields `[100.00, −100.00]` with `15.00`
unattributed instead of `[1500000003.79, −1499999988.79]`.

**LOW-1 (fixed).** `fetchOpeningCash` / `fetchClosingCash` moved to `afs/afsKpiCash.ts` (62 lines).
`afsKpiService.ts` is 262 lines, back under the 300-line rule.

**LOW-2 (fixed).** `vatDisagrees` no longer carries `lines.length > 0`. Zero lines means zero
tolerance, and the note reads "is not accounted for by any line item" when there is no table above it.

**LOW-3 (fixed in code; the finding is unreachable).** The `Unknown customer (null)` label is
replaced by `Unattributed` when the grouping key is null. It cannot fire today:
`customer_invoices.customer_id` is `NOT NULL` in the live schema (verified on the fixture DB), so
`COALESCE(ci.client_id, ci.customer_id)` is never null. No test — a row that violates a NOT NULL
constraint cannot be seeded, and asserting an unreachable branch would be asserting nothing. The
guard stays because the label, not the constraint, is what makes it safe.

**Files (round 5).** `ar/vatLineAllocation.ts`, `ar/invoicePdfBuilder.ts`, `ar/quotePdfBuilder.ts`,
`gl/accountSubtypes.ts` (+`isBankSubtype`), `afs/afsKpiService.ts`, new `afs/afsKpiCash.ts`,
`reports/sales-by-customer.ts`, and the 26 bank-subtype query sites listed above.

**Tests (round 5).** New `tests/unit/services/vatLineAllocation.test.ts` (10) and
`tests/unit/services/bankSubtypeVocabulary.test.ts` (5). Integration: 44 across the six files
(k091b 9, k091 5, k126 10, k126b 10, k126c 4, k093 6). Full unit suite 9583 passed / 243 skipped,
`DATABASE_URL` unset. `tsc --noEmit`, `eslint` on changed src/pages, `agent-docs:check` all clean.

**Mutation proof (round 5).** M-A remove the residual tolerance → 6 unit tests red. M-B let a
zero-rated line absorb a cent → 1 red. M-C coverage back to the literal `'bank'` → 3 red. M-D
importer back to the literal → 4 red. M-F restore `lines.length > 0` on the quote note → 1 red.
M-G narrow `isBankSubtype` to `subtype === 'bank'` → 1 red. Baseline green before each; every
mutation reverted.

**Historical-data impact (round 5).** No stored row changes, no migration. Accounts spelled
`bank_account` gain a coverage row, a statement-import path and a place in every bank-balance report
that previously omitted them — their cash balance was already counted by `cash.balance.v1`, so the
two figures stop disagreeing rather than either one moving on its own. Find them read-only:
```sql
SELECT company_id, account_code, account_name, account_type, account_subtype
FROM   gl_accounts
WHERE  account_subtype = 'bank_account'
ORDER  BY company_id, account_code;
```
