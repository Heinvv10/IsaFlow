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

---

## Round 6 — the five findings of review-k091-r5

`allocateVatToLines` is untouched: the reviewer's 200,000-case property harness found zero
violations, reproduced both worked examples and turned all 8 mutations red. That work is closed.

### MEDIUM-1 (fixed) — the census, completed

Round 5 converted the sites that answer "is this a bank account". It did not convert the sites
that answer "which subtype is this", and four of those printed money. Every literal subtype
comparison in `src/**` and `pages/**` was enumerated (`git grep` on `account_subtype` /
`accountSubtype` against a comparison operator, then read one by one) and given a disposition.

**Converted — the four the review named:**

| Site | Was | Now |
|---|---|---|
| `reports/vatBoxBasis.ts` `classifyVatJournalLine` | raw subtype vs `['bank','cash','receivable','payable']` and vs `VAT_TAX_SUBTYPES` | `canonicalSubtype()` first, then the same canonical token lists |
| `reports/cashFlowForecastDataService.ts` ×5 | `IN ('bank','cash')` | `= ANY(CASH_SUBTYPES)` |
| `afs/noteGenerators/notes11to15.ts` (note 11) · `reports/disclosureNoteGenerators.ts` (`noteCash`) | `IN ('bank','cash','petty_cash')` | `= ANY(CASH_SUBTYPES)` |
| `afs/noteGenerators/notes26to30.ts` ×3 (notes 27, 29) | `IN ('bank','cash','trade_receivable','inventory')`, `= 'trade_receivable'`, `IN ('trade_payable',…)` | `CASH/RECEIVABLE/INVENTORY/PAYABLE_SUBTYPES`; `vat_payable`, `overdraft`, `bank_loan`, `current_tax_liability` stay literals — they are not in the canonical vocabulary at all |

**Converted — the guards and pickers (the review's group d), all onto `isBankSubtype`:**
`bank/bankAllocationService.ts:203` (the ledger-write transfer guard — it would have refused a
legitimate `bank_account` counterparty), `core/contraSettlementService.ts:81`,
`gl/bankContraVat.ts` (the `BANK_SUBTYPE` constant deleted; both call sites),
`gl/accountMergeGuards.ts:209`, `gl/chartOfAccountsService.ts:447`,
`lib/mcp/tools/writeOpeningBalance.ts:110`, `components/accounting/bank-rules/BankRuleForm.tsx:74`,
`pages/accounting/bank-transactions/new.tsx:79`,
`components/accounting/bank-transactions/useBankTxRefData.ts:79`.

**Converted — the remaining SQL literals:** `gl/integrityChecks/accountChecks.ts:228`
(`<> ALL(ARRAY['bank','cash',…])` → `CASH_SUBTYPES` + the two VAT literals),
`reports/vatAllocationMismatchService.ts:110,114,118` (`<> 'bank'` → `<> ALL(BANK_SUBTYPES)`),
`afs/afsKpiService.ts:202-204` (`inventory` / `receivable` / `payable` → the shared constants),
`reports/casewareExportService.ts` (the `type:subtype` suggestion map now tries the canonical key
second, so `bank_account` reaches B10 instead of "Other assets"; raw-only keys `retained`,
`tax_payable`, `loan` still resolve, which is why the canonical key is second and not first).

**Deliberately left, with reasons:**

| Site(s) | Why |
|---|---|
| `chartOfAccountsImportService`, `migrationParserService`, `migrationCoaService`, `pages/accounting/bank-accounts/index.tsx`, `default-accounts.ts`, `writeGlAccounts.ts` | WRITE side. They SET `'bank'`; that is what makes it canonical. Widening them lets an importer invent a second spelling instead of normalising onto the first. |
| `systemAccountKeys.ts`, `controlAccountService.ts`, `farDisposalService.ts`, `getSystemAccount('bank', …)`, `glCrossModuleHooks`, `CreateRuleModal.tsx`, `migration/chart-of-accounts.tsx` | `'bank'` is a system-account ROLE or a UI allocation type, not a subtype. Same word, different question. |
| `gl.types.ts`, `glAccountSubtypes.ts`, `accountSubtypes.ts` | The vocabulary definitions themselves. |
| every `vat_input` / `vat_output` / `retained_earnings` / `opening_balance_equity` / `accumulated_depreciation` literal (≈30 sites in `vatReconciliationService`, `vatExceptionsService`, `vatControlMovement`, `workbenchService`, `bankTxQueryFragments`, `_helpers.ts`, …) | Each of these canonical tokens has exactly ONE raw spelling in `SUBTYPE_ALIASES`. The literal and the constant are the same set, so there is no gap to close and the swap would be churn. |
| `cost_of_sales`, `depreciation_expense` literals (`afsKpiService:167,173`, `managementPackGeneratorService:88`, `consolidatedStatementsService:99`) | Genuinely multi-spelling (`cogs`, `direct_cost`, `amortisation`), so the same gap exists — but it is an income-statement classification gap, not the bank/cash one K-091 is about. Raised as a separate item rather than widened here without its own fixture. |
| `ASSET_COST_SUBTYPE = 'fixed_assets'` (`fixedAssetReconciliationQueries` + 3 consumers) | Already defined in one place and read identically by its SQL and its TS partition, so the two cannot disagree. Widening it means rewriting a two-way partition; same separate item as above. |
| `bank_loan`, `overdraft`, `vat_payable`, `current_tax_liability`, `equity_loan`, `salaries`, `uif`, `provision`, `goodwill`, … | Not in `SUBTYPE_ALIASES` at all. `rawSubtypesFor` cannot express them; extending the vocabulary is a separate change. |
| `classificationCoverageService:73` (`'default_expense'` / `'default_revenue'`) | Asks whether a subtype is a PLACEHOLDER, not which concept it names. Canonicalising would defeat it. |
| `chartOfAccountsService:220`, `chart-of-accounts.ts:37`, `consolidatedReportingService:78`, `accountMergeFigures:220` | The subtype is a caller-supplied filter parameter, not a literal. |

### LOW-1 (fixed)
`invoicePdfBuilder` branches the disclosure on the SIGN of `unattributed`. A header BELOW the
lines now reads "The line items above account for R 9.00 more VAT than the total states." instead
of "includes R -9.00", which said the opposite of what it meant.

### LOW-2 (fixed)
`quotePdfBuilder`'s tolerance is a flat half-cent, not `lines.length / 100`. That table prints a
rate per line and never a VAT amount, so nothing rounds per line; the line-scaled tolerance only
silenced up to R0.20 of real header/line disagreement on a 20-line quote, without a `log.warn`.

### LOW-3 — no change
Upheld in the author's favour by the reviewer: `customer_invoices.customer_id` is NOT NULL, the
branch is unreachable, no test is owed. Not revisited.

### LOW-4 (fixed for the files this branch pushed over)
`quotePdfBuilder.ts` (304→300) and `disclosureNoteGenerators.ts` (303→300) are back under the cap;
the excess was comment lines this round added, and they were trimmed. The three files the review
named — `bank-transactions-bulk-commit.ts` 339, `bankReconciliationService.ts` 356,
`bankRulesMatchingService.ts` 335 — were over on `origin/master` and gained one import line each.
Not split: a split to absorb one import is a larger change than the defect.

Disclosed rather than fixed: `reports/vatBoxBasis.ts` is 386 lines, up from 374 on `origin/master`.
Twelve of the fourteen added lines are the comment stating why the classifier canonicalises before
it compares — the reasoning a future reader needs in order not to put the raw literal back. The
file was 74 lines over the cap before this branch touched it; trimming that comment to recover six
of them would not bring it under and would delete the explanation this round exists to record.
Splitting it is a separate change with its own risk to a filed-return code path.

**Files (round 6).** 20 changed, listed in the tables above.

**Tests (round 6).**
- New `tests/integration/k091c-subtype-vocabulary-agreement.int.test.ts`, 10 tests on real
  Postgres. Seeds ONE asset account per `CASH_SUBTYPES` spelling and asserts `cash.balance.v1`,
  the cash-flow forecast's opening cash and history, AFS note 11, the IFRS disclosure cash note
  and bank coverage all see the same accounts at the same balances — coverage carrying exactly the
  `BANK_SUBTYPES` subset, differing from cash by exactly the petty-cash balances. Seeds one
  settlement leg per settlement spelling on a VAT tenant and asserts the VAT201 base box excludes
  every one of them and that SARS's 15% check ties. Seeds one control account per receivable and
  payable spelling and asserts note 27's current ratio and the AFS KPI debtor/creditor days count
  all of them.
- New `tests/unit/services/bankCashSubtypeCensus.test.ts`, 1 test. A LINT, labelled as one: it
  greps `src`/`pages` for a subtype compared against a bank/cash literal and fails on any new one.
  It proves nothing about behaviour; it stops the census from decaying.
- `tests/unit/services/vatBoxBasis.test.ts` +4: every settlement spelling classifies as
  `settlement`, the cancelled-source branch uses the same widened vocabulary, case and spacing
  canonicalise on the tax leg, and the generic `tax` subtype is still `unmapped` rather than VAT.
- `k126` +1 (header below lines), `k126b` +1 (a 20-line quote's 15c disagreement is stated).
- `tests/unit/services/isActiveNeverFiltersBalances.test.ts` updated: it asserted the literal
  `IN ('bank','cash')` as its query fingerprint.

**Mutation proof (round 6).** Ten mutations, each applied to the working tree, run, then restored;
the baseline below was green before each, and `git diff --stat` was identical afterwards.

| # | mutation | result |
|---|---|---|
| M9 | `vatBoxBasis` settlement branch back to the raw `subtype` | k091c 1 failed / 9 passed; vatBoxBasis unit 1 failed / 22 passed |
| M10 | forecast, all five sites back to `IN ('bank','cash')` | k091c 2 failed / 8 passed; census lint 1 failed |
| M11 | note 11 back to `IN ('bank','cash','petty_cash')` | k091c 1 failed / 9 passed |
| M12 | `noteCash` back to the same literal triple | k091c 1 failed / 9 passed |
| M13 | quote tolerance back to `lines.length / 100` | k126b 1 failed / 10 passed |
| M14 | invoice disclosure back to the single unsigned sentence | k126 1 failed / 10 passed |
| M15 | note 27 current assets back to the literal list | k091c 1 failed / 9 passed |
| M16 | `afsKpiService` trade receivables back to `= 'receivable'` | k091c 1 failed / 9 passed |
| M17 | `accountChecks` back to `ARRAY['bank','cash','vat_input','vat_output']` | census lint 1 failed |
| M18 | `bankContraVat` back to `String(...) === 'bank'` | census lint 1 failed |

M10 is the one that proves the two layers are independent: the same edit turns two behavioural
assertions red AND trips the lint, so neither is standing in for the other.

**Gates (round 6).** Full unit suite with `DATABASE_URL` unset: 9588 passed / 243 skipped, 0 failed.
Integration, the seven files of this branch on the fixture DB: 56 passed. `bunx tsc --noEmit` exit 0.
`bunx eslint` on every changed `src`/`pages` file: clean.

**Migration / rollback (round 6).** None. Revert the commit.

**Historical-data impact (round 6).** No stored row changes. Every conversion WIDENS a read, so
figures move only for a company that uses a non-canonical spelling. The consequential one is the
VAT201: a company whose debtors or creditors control carries any spelling other than `receivable` /
`payable` had its gross settlement leg counted as taxable base, over-stating boxes 1 and 15.
Read-only sizing, not run against production:
```sql
SELECT ga.company_id, ga.account_code, ga.account_name, ga.account_subtype,
       SUM(ABS(jl.debit - jl.credit)) AS gross_on_vat_journals
FROM   gl_accounts ga
JOIN   gl_journal_lines jl ON jl.gl_account_id = ga.id AND jl.company_id = ga.company_id
JOIN   gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
WHERE  je.status = 'posted'
  AND  ga.account_subtype IN ('receivables','accounts_receivable','trade_receivable',
                              'trade_receivables','debtor','debtors','payables',
                              'accounts_payable','trade_payable','trade_payables',
                              'creditor','creditors','bank_account','cash_on_hand','petty_cash')
  AND  EXISTS (SELECT 1 FROM gl_journal_lines v
               JOIN gl_accounts va ON va.id = v.gl_account_id AND va.company_id = v.company_id
               WHERE v.journal_entry_id = je.id
                 AND va.account_subtype IN ('vat_input','vat_output'))
GROUP  BY ga.company_id, ga.account_code, ga.account_name, ga.account_subtype
ORDER  BY gross_on_vat_journals DESC;
```
Every rand this returns was being reported as the value of a supply. Any period already FILED on
the old figure has to be reconciled against the corrected one before the next return.

**Limits (round 6).** The census covers the K-091 vocabulary only. Two named gaps are left open and
recorded above: the multi-spelling `cost_of_sales` / `depreciation_expense` tokens, and the
fixed-asset reconciliation's `'fixed_assets'` constant. Both are the same defect shape on the income
statement and the FAR, and both need their own fixture. Neither is a regression from this round.

---

## Round 7 — the census, built from the consumers instead of from a grep

Rounds 4, 5 and 6 each rebuilt the census by grepping for the literals someone
had thought of, and each missed live read paths. Round 7 changes the method: the
sites were enumerated from the CONSUMERS (`git grep` on the column itself — 661
occurrences in 152 files — then read one by one), and for each the literals were
mechanically compared against `SUBTYPE_ALIASES` to decide whether the literal is
a STRICT SUBSET of its canonical token's spellings. That test is objective, so
the answer no longer depends on which words the author thought to search for.
The result is then reconciled by OUTCOME in `k091d`, which seeds one account per
spelling with a distinct balance and asserts the printed figures agree.

### HIGH-1 (fixed) — the eight untabled sites, and two more the method found

| Site | Was | Now | Figure it moved |
|---|---|---|---|
| `afs/afsKpiService.ts` `fetchBalanceSnapshot` | `NOT IN ('fixed_asset','accumulated_depreciation')` | `<> ALL(NON_CURRENT_SUBTYPES)`, `COALESCE`d | current ratio, quick ratio |
| same, current LIABILITIES arm | no non-current exclusion at all | same exclusion, mirrored | the denominator of the same ratio |
| `afs/managementPackGeneratorService.ts` | identical expression | identical fix | management pack ratios |
| `gl/closeReadinessChecks/arSubLedgerCheck.ts` | `= 'receivable'` | `= ANY(RECEIVABLE_SUBTYPES)` | the AR-ties close gate |
| `gl/closeReadinessChecks/apSubLedgerCheck.ts` | `= 'payable'` | `= ANY(PAYABLE_SUBTYPES)` | the AP-ties close gate |
| `core/migrationValidationService.ts` ×2 | `= 'receivable'` / `= 'payable'` | the same constants | post-migration AR/AP validation |
| `afs/noteGenerators/notes6to10.ts` ×2 | `IN ('investment',…)`, `IN ('inventory',…)` | `rawSubtypesFor(...)` + the non-vocabulary literals | AFS notes 8 and 9 |
| `afs/noteGenerators/notes1to5.ts` ×2 | `'depreciation'`, `'intangible_asset'` | `rawSubtypesFor(...)` | AFS notes 2 and 5 |
| `afs/noteGenerators/notes16to20.ts` ×2 | `'other_income'`, `NOT IN (…'finance_cost')` | `rawSubtypesFor(...)`, `COALESCE`d | AFS notes 19 and 20 |
| `afs/noteGenerators/notes21to25.ts` ×2 | `'finance_cost'`, `'salaries','wages'` | `rawSubtypesFor(...)` | AFS notes 21 and 22 |
| `pages/api/accounting/reports-extended-ratios.ts` ×2 | the same two lists | the same constants | interest cover, cost per employee |
| `afs/afsKpiService.ts` ×2 (income) | `'cost_of_sales'`, `'depreciation_expense'` | `rawSubtypesFor(...)` | gross margin, EBITDA |
| `afs/managementPackGeneratorService.ts` (income) | `'cost_of_sales'` | same | pack gross profit |
| `gl/integrityChecks/accountChecks.ts` | `<> 'cost_of_sales'` | `<> ALL(rawSubtypesFor(...))` | a false integrity finding |
| `reports/consolidatedStatementsService.ts` | `subtype === 'cost_of_sales'` (TS) | `canonicalSubtype(subtype) ===` | group cost of sales |

Round 6 deferred `cost_of_sales` / `depreciation_expense` as "a separate item"
and the round-6 reviewer ratified that. It is **closed here instead**: deferring
those two while converting `finance_cost` and `payroll_expense` in the notes
beside them would be an arbitrary line through one vocabulary, and it is the
arbitrary line that produced three partial censuses. Each has a fixture in
`k091d`.

**Two further defects the reconciliation found, both pre-existing:**

1. `afsKpiService` / `managementPackGeneratorService` `NOT IN (...)` is NULL for
   a NULL subtype, so an asset with no subtype was excluded from current assets
   entirely. `COALESCE(...,'')` added; NULL now defaults to CURRENT, matching
   `isCurrentSubtype`. Fixture: "an asset with NO subtype is still a current asset".
2. `migrationValidationService` summed `balance_due` on `customer_invoices` and
   `supplier_invoices`. **There is no such column on either table**, so both
   checks threw and `validateMigration` — the migration wizard's Step 8 — has
   never returned at all. Changed to `total_amount - COALESCE(amount_paid, 0)`,
   the project's own rule. Found only because the reconciliation test called it.

### The complete disposition of every surviving literal

The lint below now enforces this: it flags a comparison against ANY raw spelling
whose canonical token has more than one, so the categories below are what is
left, and each is left for a reason that is not "nobody noticed it".

| Class | Sites | Why the literal is correct |
|---|---|---|
| WRITE side | `chartOfAccountsImportService`, `migrationParserService`, `migrationCoaService`, `migrationTemplateService`, `default-accounts.ts`, `writeGlAccounts.ts`, `csvFieldMapper` | They SET the canonical spelling — that is what makes it canonical. Widening lets an importer invent a second spelling instead of normalising onto the first. |
| System-account ROLE / UI allocation type | `systemAccountKeys`, `controlAccountService`, `farDisposalService`, `getSystemAccount('bank', …)`, `glCrossModuleHooks`, `CreateRuleModal`, `migration/chart-of-accounts.tsx` | Same word, different question. |
| Vocabulary definitions | `accountSubtypes.ts`, `glAccountSubtypes.ts`, `gl.types.ts` | They ARE the vocabulary. |
| Single-spelling tokens | every `vat_input` / `vat_output` / `retained_earnings` / `opening_balance_equity` / `accumulated_depreciation` literal | The literal and the constant are the same set. Mechanically confirmed: these tokens have exactly one alias. |
| Outside the vocabulary | `bank_loan`, `overdraft`, `vat_payable`, `current_tax_liability`, `provision`, `goodwill`, `raw_materials`, `uif`, `interest_income`, `income_tax_expense`, … | `rawSubtypesFor` cannot express them; extending `SUBTYPE_ALIASES` is a separate change with its own blast radius. |
| Caller-supplied filter parameter | `chartOfAccountsService:220`, `chart-of-accounts.ts:37`, `consolidatedReportingService:78`, `accountMergeFigures:220`, `controlAccountService:239` | Not a literal — the value comes from the caller. |
| Already canonicalised | `cashFlowClassification`, `revenueBand`/`expenseBand`, `incomeStatementDisclosure`, `isBankSubtype` call sites | They compare the OUTPUT of `canonicalSubtype`. The lint recognises this shape and permits it everywhere. |
| Allow-listed in the lint, with the reason in the file | `vatBoxBasisQuery:92`, `vatReturnService:103` (`'tax'`), `classificationCoverageService:73` (`'default_expense'`/`'default_revenue'`) | `'tax'` is the RAW token a VAT control account carries and is deliberately narrow — canonicalising it pulls income tax into the VAT return, the R23,219.01 PAYE defect `accountReportingClass` records. The coverage service asks whether a subtype is a PLACEHOLDER, not what it names. |
| **Still deferred, named** | `fixedAssetReconciliationQueries` / `fixedAssetReconciliationItems` / `farDisposalService` / `leafAccountValidator` (`'fixed_asset'`+`'fixed_assets'`, missing `property_plant_equipment`) | A two-way partition (cost vs accumulated depreciation) mirrored between SQL and TypeScript plus a write gate. Widening one side without the other IS the disagreement. Needs its own fixture and its own review; unchanged by this round, so not a regression. |

### MEDIUM-1 (fixed) — `credit_card` and `other_current_liability` settle invoices

`VAT_SETTLEMENT_SUBTYPES` gains both. Both are offerable subtypes in the Add
Account dialog and the MCP write path, and against the four-token list the gross
leg fell through to `base`, giving a box-15 input base of **-R150** on a
R1,000 invoice. Two tests in `vatBoxBasis.test.ts` (classification, and the base
through `deriveVatBoxes`) plus a `k091d` fixture through `getVat201Report`.

### MEDIUM-2 (fixed) — note 27's current ratio gets both `account_type` guards

`ga.account_type = 'asset'` on the current-assets arm and `= 'liability'` on the
current-liabilities arm. Production carries 27 paycards typed `liability` with a
bank subtype; round 6's widening to `bank_account`/`petty_cash` made them count
as current ASSETS at a negative balance. `k091d` seeds exactly that paycard.
This also closes **LOW-4**: `afsKpiService.fetchBalanceSnapshot` and
`notes26to30` are now both on the guarded side, so there are two documented
behaviours (guarded readers; `bankCoverageQueries`' deliberately unguarded
misclassification report) rather than an undocumented third.

### MEDIUM-3 and LOW-1 (fixed) — the lint can now see what it exists to stop

`bankCashSubtypeCensus.test.ts` is rebuilt. It enumerates files from
`git ls-files -- src pages` and filters by extension (LOW-1: the old
`'pages/**/*.tsx'` pathspec silently excluded 13 depth-1 pages), reads each file
WHOLE and strips comments, so a multi-line `sql` template is no longer invisible
(MEDIUM-3). Its vocabulary is derived from `SUBTYPE_ALIASES` rather than written
out, so it refuses a literal for EVERY multi-spelling token, and an alias added
tomorrow widens it without an edit. Mutations M28 and M29 prove both new powers.

### LOW-2 (fixed) — the file-size disclosure, complete this time

Every file on this branch over the 300-line cap, as `branch/master`. Counted
mechanically from the whole branch diff, not by memory:

`bankAllocationService.ts` 757/756 · `chartOfAccountsService.ts` 502/501 ·
`costCentreService.ts` 424/430 · `vatBoxBasis.ts` 393/374 ·
`bankReconciliationService.ts` 356/355 · `pages/accounting/bank-transactions/new.tsx`
346/345 · `bank-transactions-bulk-commit.ts` 339/338 ·
`bankRulesMatchingService.ts` 336/335 · `useBankTxActions.ts` 310/315 ·
`notes1to5.ts` 309/305 (this round, +4).

Round 6 named four of these ten. Every one was already over on `origin/master`;
eight gained one import line, `notes1to5` four, and two are SHORTER than master.
`accountSubtypes.ts` is at 299, one line under, which is why round 7's two new
exports are derived one-liners rather than written-out arrays. None is split: a
split to absorb an import is a larger change than the defect, and `vatBoxBasis`'s
split is raised as its own item as the round-6 reviewer required.

### LOW-3 (fixed) — `k091c` no longer leaks fixture rows

`afterAll` now deletes all three tenants with `company_id = ANY($1::uuid[])` —
four round trips instead of twelve — and carries an explicit 60s timeout, so the
config's 10s default cannot cut cleanup off half done on a loaded box. `k091d`
is written the same way from the start.

### LOW-5 (fixed) — mixed constants and literals now carry the comment

`notes6to10`, `notes1to5`, `notes16to20` and `notes21to25` now spread
`rawSubtypesFor(...)` first and list the non-vocabulary literals after it, the
shape `notes26to30` already used, so which half is which is visible.

**Files (round 7).** 15 source files, 4 test files. `accountSubtypes.ts` gains
`NON_CURRENT_SUBTYPES` (derived from the same `NON_CURRENT` set
`isCurrentSubtype` reads, so SQL and TypeScript cannot disagree on the
current/non-current split) and `ALL_CANONICAL_SUBTYPES` (for the lint).

**Tests (round 7).** New `tests/integration/k091d-subtype-census-reconciliation.int.test.ts`,
11 tests on real Postgres. `k091c` 10 (cleanup rewritten). `vatBoxBasis.test.ts`
+2 (25). `bankCashSubtypeCensus.test.ts` rebuilt, 1.
Integration, the 8 files of this branch: **67 passed** (35 + 32, two runs).
Full unit suite with `DATABASE_URL` unset: **9590 passed / 243 skipped / 0 failed**
(806 files). `bunx tsc --noEmit` exit 0. `bunx eslint` on all 15 changed
`src`/`pages` files: exit 0, no output.

**Mutation proof (round 7).** Eleven, each applied to the working tree, run, then
restored from the index; `git status --porcelain` empty afterwards each time.

| # | mutation | result |
|---|---|---|
| M19 | current assets back to `NOT IN ('fixed_asset','accumulated_depreciation')` | k091d 3 failed / 8 passed; census lint 1 failed |
| M20 | current liabilities loses the non-current exclusion | k091d 2 failed / 9 passed |
| M21 | KPI cogs back to `= 'cost_of_sales'` | k091d 1 failed / 10 passed; lint 1 failed |
| M22 | AR close gate back to `= 'receivable'` | k091d 1 failed / 10 passed; lint 1 failed |
| M23 | migration validator back to `= 'receivable'` | k091d 1 failed / 10 passed |
| M24 | note 27 loses `account_type = 'asset'` | k091d 1 failed / 10 passed |
| M25 | inventories note back to the literal list | k091d 1 failed / 10 passed; lint 1 failed |
| M26 | settlement vocabulary back to the four tokens | k091d 1 failed / 10 passed; vatBoxBasis unit 2 failed / 23 passed |
| M27 | invoice balance back to `balance_due` | k091d 1 failed / 10 passed |
| M28 | a NEW multi-line `IN ('bank','cash')` written into a service | lint 1 failed — the round-6 lint could not see this |
| M29 | a NEW `accountSubtype === 'bank'` in `pages/home.tsx` | lint 1 failed — outside the round-6 pathspec |

**Migration / rollback (round 7).** None. Revert the commit.

**Historical-data impact (round 7).** No stored row changes; every change is a
read. Figures that move: the current and quick ratios on the AFS KPI scorecard
and the management pack (up for any company holding non-current assets spelled
anything but `fixed_asset`, down for any carrying long-term debt); gross margin
and EBITDA for a company spelling cost of sales `cogs`/`direct_cost`; AFS notes
2, 5, 8, 9, 19, 20, 21, 22; and the AR/AP close gates and migration validation,
which change from a hard `fail` on correct books to a pass. Read-only sizing,
not run against production:

```sql
SELECT ga.company_id, ga.account_type, ga.account_subtype, COUNT(*) AS accounts
FROM   gl_accounts ga
WHERE  ga.account_subtype IN ('fixed_assets','property_plant_equipment','intangible_assets',
                              'investments','non_current_assets','fixed_asset_other',
                              'long_term_liabilities','non_current_liabilities',
                              'receivables','accounts_receivable','trade_receivables','debtor','debtors',
                              'payables','accounts_payable','trade_payables','creditor','creditors',
                              'cogs','cost_of_goods_sold','direct_cost','direct_costs',
                              'depreciation','amortisation','amortization',
                              'finance_costs','other_revenue','stock',
                              'credit_card','other_current_liability','other_current_liabilities')
GROUP  BY ga.company_id, ga.account_type, ga.account_subtype
ORDER  BY accounts DESC;
```

**Limits (round 7).** `managementPackGeneratorService`'s balance aggregate is
covered by the census lint and by the identical expression in `afsKpiService`,
not by a behavioural fixture: `generateManagementPack` writes an AFS document
and calls the AI summary service, which is not something to run in this suite.
The fixed-asset register's `'fixed_assets'` partition remains deferred and named
above. `vatBoxBasis.ts` remains 93 lines over the cap and its split remains an
open item.
