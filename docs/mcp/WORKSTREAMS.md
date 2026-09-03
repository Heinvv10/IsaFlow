# Workstream briefs

Each workstream gets: this section, `docs/mcp/CONTRACTS.md`,
`docs/mcp/PROGRAMME.md`, and the specification
`docs/mcp/isaflow-mcp-endpoint-audit-2026-09-03.md`.

**Verdicts come from a service inventory of the codebase, not from the
specification.** The spec was written from the outside and calls several things
missing that already exist and are UI-proven. Where the verdict says WRAP, the
logic is there and working — expose it, do not rebuild it. Rebuilding a figure
the UI already computes is the exact failure this programme was commissioned to
fix, and a PR that does it is sent back regardless of whether the arithmetic is
right.

- **WRAP** — the service exists and does the job. Add the MCP tool, the envelope,
  the description, the tests.
- **EXTEND** — the service exists but is too narrow. Widen it, keep the UI caller
  working, do not fork it.
- **BUILD** — genuinely new. This is where the design review effort goes.

---

## W1 — Cash application (AR/AP) · migrations 540–549 · Wave 1

Until this lands, `amount_paid` is 0.00 on every invoice in the system and the
aged debtors report is a list of everything ever invoiced rather than of what is
owed.

**Read this first: the ledger operations already exist.** The failure is that MCP
cannot reach them, not that IsaFlow cannot do them.

| Endpoint | Verdict | Owner |
|---|---|---|
| `apply_receipt_to_invoice` | WRAP | `ar/receiptMatchService#confirmReceiptMatch` (writes `amount_paid`, line 319) and `ar/customerPaymentAllocationService#confirmCustomerPayment` (posts DR Bank / CR AR) |
| `suggest_receipt_matches` | WRAP | `ar/receiptMatchService#getReceiptMatchCandidates` — a scored shortlist, PRD-06 Phase 4 |
| `apply_payment_to_supplier_invoice` | WRAP | `ap/supplierPaymentService`, `ap/supplierPaymentWorkflowService` |
| `reverse_journal_entry` | WRAP | `gl/journalEntryPostingService#reverseJournalEntry` |
| `create_customer` / `create_supplier` | EXTEND | `pages/api/accounting/customers.ts`, `suppliers-list.ts` have POST but no service function — extract one |
| `update_customer` / `update_supplier` | BUILD | no update path anywhere |
| `list_unapplied_receipts` | BUILD | the spec says this "exists as a UI report". **It does not** — there is no `unapplied` anywhere in the codebase |
| `settle_by_contra` | BUILD | no contra settlement path; the only settlement the API offers is a bank payment that never happened |

`suggest_receipt_matches` **proposes and never posts**, exactly like
`suggest_bank_allocation`. That pattern works. Do not improve it.

Every mutating tool here takes `dry_run` and `idempotency_key`, and the dry run
runs every row-state guard the live path runs.

Catches: AR overstated R8.5m · AP overstated R613,642 · R371,470 of contra-settled
AP · R2.45m of unapplied receipts.

---

## W2 — Assurance reporting · migrations 550–559 · Wave 1

| Endpoint | Verdict | Owner |
|---|---|---|
| `trial_balance` v2 | **WRAP — WAIT** | `gl/trialBalanceService#getTrialBalance` is being rewritten right now on `fix/reporting-audit-p0` (see below). **Do not start this until that PR merges.** |
| `reconcile_subledger` | **BUILD** | nothing like it exists. The most valuable endpoint in the programme |
| `general_ledger` | EXTEND | `gl/generalLedgerReportService#getGeneralLedgerReport` already does all accounts with opening balances; needs filters and a cursor. `search_gl` (1 account, 200 rows) is the narrow MCP view of it |
| `balance_sheet` additions | EXTEND | `reports/balanceSheetService#getBalanceSheet` already takes `asAtDate` and `compareDate` — they are simply not wired to MCP |
| `profit_and_loss` additions | EXTEND | `reports/incomeStatementService#getIncomeStatement` has `comparePeriod`, not wired — **but see the caveat below.** Cost of sales must be driven by account **SUBTYPE**, never by name |
| `aged_debtors` / `aged_creditors` | EXTEND | `ar/arAgingService#getARAging`, `ap/apAgingService#getAPAging` — already `as_at` capable; need totals, pagination, drill-down, `unappliedReceipts`, `excludedRows` |

### `profit_and_loss` — treat the existing output as unreliable

`incomeStatementService` is **not** being fixed by the parallel session and has
three known open defects. Do not build on them:

1. The comparative is a **rolling N-day window**, not a prior period. Do not wire
   the existing `comparePeriod` through to MCP and call it a comparative.
2. There is no other-income / finance-cost / tax layer, so the statement does not
   reach a profit figure anyone can sign.
3. Cost of sales is selected by account NAME. Two accounts typed
   `default_expense` overstated gross profit by R562,428 for exactly that reason.
   Drive it by SUBTYPE.

Fixing 1 and 3 is in scope for W2. Fixing 2 is a bigger change — scope it, then
raise it with the integrator before starting.

**W2 also settles three figures** left unowned in `contracts/figures.ts`:
`ar.control.v1`, `ap.control.v1`, `equity.ledger.v1`. Fill in the owner and remove
the duplicate implementations in the same PR.

`reconcile_subledger` must **decompose the difference into itemised reconciling
items with document ids**, not report a gap. The Brightsphere AR gap of
R1,429,774 reconciles exactly to three items: R2,436,024 of receipts credited to
the control account but never applied, −R1,058,000 for the null-due-date invoice,
+R51,750 for a future-dated one. If your endpoint returns R1,429,774 and no items,
it has not done the job.

### `trial_balance` — blocked on a parallel session, and the verdict has flipped

A concurrent session is landing a P0 fix to `getTrialBalance` on
`fix/reporting-audit-p0`. Build the MCP tool on top of it; **do not extend the
version currently on `master`, and do not start before it merges.** If you build
against today's code you will ship the bug over MCP.

What that fix does, per the session doing it:

- The old query filtered `je.fiscal_period_id = <one period>` and returned the
  result in columns named `debit_balance` / `credit_balance`. It was **one
  month's movement wearing the name of a balance.** Brightsphere's bank account
  displayed R113,843 against a real balance of R6,003,472.64; Trade Debtors
  R123,850 against R8,675,798.60.
- New `gl/trialBalanceBasis.ts` holds the shared basis: fiscal-year start from
  `companies.financial_year_start` (every production company is March, not
  calendar), retained-earnings brought forward, no `Date` arithmetic and no
  `.toISOString()`.
- Balance-sheet accounts cumulative to period end; P&L year-to-date within the
  fiscal year; accounts kept on **balance**, not movement.
- `openingDebit` / `openingCredit` / `periodDebit` / `periodCredit` already exist
  on the row type (`gl.report.types.ts`). **That is the opening/movement/closing
  the spec asks for — it is done. Wrap it.**
- The same basis is applied to `consolidatedTrialBalanceService` and
  `casewareExportService`, which repeated the defect.

**Breaking semantic:** `debitBalance` / `creditBalance` now carry the **net**
balance on one side, not gross turnover. Anything that SUMs those columns
expecting turnover is silently wrong. Check before you consume them.

`trial_balance` returning 7 of 118 accounts is the original defect. A trial
balance that omits every account without movement in the month is a
period-movement listing wearing a trial balance's name. Note that
"zero balance" and "no movement this period" are **different questions** — the
old `HAVING` clause conflated them, which is half of why dormant accounts
vanished. Your `include_zero_balances` must distinguish them.

Catches: three answers to "what are we owed" · the R8.46m retained-earnings plug
(both equity bases in one call) · R562,428 of overstated gross profit · the
R1,058,000 invisible invoice.

---

## W3 — Banking completeness and period control · migrations 560–569 · Wave 2

| Endpoint | Verdict | Owner |
|---|---|---|
| `perform_bank_reconciliation` | WRAP | `bank/bankReconciliationService#startReconciliation` / `#completeReconciliation` / `#autoMatchTransactions` — MCP has only list and cancel today |
| `get_opening_balances` / bank opening balance | WRAP | `bank/bankOpeningBalanceService` — a read side exists |
| `list_fiscal_periods` / `get_fiscal_period` / `reopen_fiscal_period` | WRAP | `gl/fiscalPeriodService` |
| `close_fiscal_period` | EXTEND | `gl/fiscalPeriodService#closePeriod` has **no readiness check**. Wire it to `gl/periodCloseReadinessService#getCloseReadiness` and **REFUSE with itemised blockers, not a boolean** |
| `period_close_checklist` | WRAP | `gl/periodCloseReadinessService#getCloseReadiness` — an exact match for the spec |
| `year_end_close` | WRAP | `gl/yearEndService#closeFiscalYear` — already rolls the P&L and refuses on open periods |
| `bank_statement_coverage` | **BUILD** | nothing exists |
| `cash_flow_statement` | WRAP | `afs/cashFlowDirectService#getCashFlowDirect` — **reads the wrong AP control account**; fix as part of settling `ap.control.v1` |

**W3 owns `cash.balance.v1`.** Four implementations answer it today
(`bank/bankAccountStatusService`, `afs/cashFlowDirectService`,
`reports/balanceSheetService`, and the dashboard). Settle it, converge them,
fill in the owner.

The period control is running exactly backwards: 55 prior periods open, every
2027 period closed, and periods generated Jan–Dec against a March financial year
end. **Fix the period generation here, not as a follow-up.**

Catches: 203 missing BT1 lines / Velocity's four-month import hole · GL bank
overstated R5.87m · anyone can post to 2022 · AP movement shown as R0.

---

## W4 — Integrity, VAT, and two live display defects · migrations 570–579 · Wave 2

| Endpoint | Verdict | Owner |
|---|---|---|
| `data_integrity_checks` (13 checks) | BUILD mostly | only `gl/glIntegrityService#findOrphanJournalEntries` is complete; `reports/vatBalanceSheetExceptions` and `reports/vatAllocationMismatchService` cover two more partially |
| `chart_of_accounts_health` | **BUILD** | `gl/chartOfAccountsService` is plain CRUD |
| `vat_reconciliation` | WRAP | `reports/vatReconciliationService#getVatReconciliation` — matches the spec's shape |
| `vat_status` fixes | EXTEND | `reports/vat201Service#generateVAT201`. Detail levels + pagination (67KB today), box 1 and box 15 **derived from the same journals as the tax**, cancelled invoices excluded from output tax |
| `vat201_export` / `lock_vat_period` | BUILD | |
| `list_bank_transactions` fixes | EXTEND | `bank/bankTxRowMapper` — `allocatedEntityName` must always resolve to the GL account; expose `allocationRuleName`, `vatCodeDisplayed` and `vatTreatmentPosted` **separately** |
| `bulk_allocate_bank_transactions` | EXTEND | mandatory `dry_run` returning the journals that would post |

**The VAT box arithmetic is blocking.** It fails SARS's own 15% check by R5.1m on
Velocity Fibre and by R50,000 on Brightsphere. Derive the supply and purchase
figures from the same journals as the tax, or the check cannot tie by
construction.

Catches: the ~R50k entertainment input-tax over-claim · R1,383,192 VAT shortfall ·
R8.4m of misclassified loans · R562,428 of mistyped cost accounts · R14.08m of
non-nil clearing · deactivated accounts carrying balances · the QA Test Customer
in production.

---

## W5 — Governance · migrations 580–589 · Wave 2

| Endpoint | Verdict | Owner |
|---|---|---|
| `audit_trail` (supersedes `list_agent_postings`) | EXTEND | `gl/transactionLedgerService#getAuditTrail`, `core/auditTrailService`, `bank/agentActivityService` |
| `list_documents` / `get_document` | EXTEND | logic is inline SQL in `pages/api/accounting/documents.ts:63-84` — extract a service function first |

Migration 530 has already added `actor_type` and `actor_token_jti`. **Legacy rows
are NULL and are derived from `posting_agent` at read time** — `mcp:%` is an
agent, `human:%` is a human. Do not backfill: a derived value can be corrected
when the derivation proves wrong, and a backfilled one can never afterwards be
told from a recorded one, which is the property that makes an audit trail worth
having.

W5 also propagates `actorForMcp()` through the write paths so new postings record
the token. That is upstream of the endpoint and is the actual fix.

Catches: 4,300 programmatic postings indistinguishable from typed entries ·
"which transactions over R10,000 have no supporting document" being unanswerable.

---

## W6 — New domains · migrations 590–609 · Wave 3

**Payroll first — it is the largest untouched statutory exposure, and it is a
WRAP.** The services are real, not a shell: `payrollJournalPostingService#…`
posts an idempotency-guarded GL journal, and full PAYE/UIF/SDL/ETI engines exist.
The GL structure exists at 2140/2150/2160/2170/2175, deactivated and empty.

| Endpoint | Verdict | Owner |
|---|---|---|
| `list_employees`, `list_pay_runs`, `create_pay_run`, `post_payroll_journal` | WRAP | `payrollEmployeeService`, `payrollRunService`, `payrollJournalPostingService` |
| `emp201_status`, `irp5_data` | WRAP | `reports/emp201Service`, `reports/irp5Service`. **Wrap the version on `fix/reporting-audit-p0`, not master**: the status filter was `'calculated'`, which misses 85 of 86 production pay runs. The fix moves it to `approved`/`paid` and adds ETI |
| `project_profitability` | WRAP | `reports/projectProfitabilityService#getProjectProfitability` — a direct match |
| `wip_report` | WRAP | `practice/practiceWipService` — practice-scoped; widen only if the general case is needed |
| Budgets | ~~WRAP~~ **BUILD** | The spec's verdict was wrong. `core/budgetService` had never executed — twelve month columns that do not exist, two missing NOT NULL columns, an `ON CONFLICT` with no constraint behind it. Rebuilt against the live `period_amounts` JSONB schema; migration 590 supplies the arbiter index. `budget_variance` registered on `reports/budgetVarianceService` |
| `customer_statement` | WRAP | `ar/statementEmailService#fetchStatementData` — a real builder whose only consumer is email |
| Fixed assets | EXTEND | calc logic is pure (`items/assetService`, `farDepreciationService`, `farDisposalService`) but CRUD is inline SQL in `pages/api/accounting/assets.ts:18` — extract a service first |
| Inventory | EXTEND | `items/itemService` has real CRUD |
| `supplier_statement` | BUILD | |
| `job_cost_report` (general) | BUILD | |

Catches: R7,500 of depreciation against assets not on the balance sheet · no
contract-level P&L for a fibre contractor.

**The "R2.72m of understated employment cost" does not survive re-derivation.**
All 86 pay runs and all 11 `payroll_employees` rows are ISAFlow Demo; Velocity
and Brightsphere have zero of each, so nothing of theirs can be understated *by
a pay run*. Re-derived, the exposure is **R12,807,325.13** posted straight to
salary and wage accounts with no payroll behind it and no PAYE, UIF or SDL ever
raised — see FINDINGS **B42**, and **B43** for the R399,735.97 of input VAT
claimed on top of it. Reported, not fixed: this programme does not correct data.
