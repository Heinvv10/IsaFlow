# IsaFlow — MCP / API endpoint audit

3 September 2026. What the MCP surface can do today, what it cannot, and which
endpoints would have prevented or detected the findings in the Velocity Fibre and
Brightsphere Technologies audits.

Written from the accountant's and auditor's side of the desk: not "what would be
nice to automate" but "what does a machine need in order to prove a set of books,
and what is it currently unable to see".

> Source: supplied by Hein, 2026-09-03. This file is the specification of record
> for the MCP assurance programme. Sections are reproduced verbatim.

## 1. The one-line diagnosis

IsaFlow's MCP can post far more than it can prove.

Of the 77 tools on the connection, roughly 35 mutate the ledger and 9 report on
it. An agent can import 8,853 bank lines, post 4,319 allocations and raise
journals — and then cannot produce a trial balance that lists more than 7 of 118
accounts, cannot tell you whether the subledgers agree to their control accounts,
cannot see which periods are open, and cannot apply a receipt to an invoice.

That asymmetry is the cause of the Brightsphere findings, not a coincidence
alongside them. Every material misstatement in that audit was either (a) a break
between a subledger and its control account, (b) a consequence of an operation the
API cannot perform, or (c) a defect that a routine integrity query would have
surfaced in milliseconds and which instead took a week of manual tracing.

## 2. What exists today

| Domain | Tools | Assessment |
|---|---|---|
| Banking / allocation | 17 | The strongest area by a distance. Import, list, suggest, match candidates, allocate, bulk-allocate, rules CRUD, reverse, undo import, batches. This is a genuinely complete write path. |
| General ledger | 8 | Accounts CRUD, draft/post journal, list_journals, search_gl, set_opening_balance. Adequate for posting; thin for reading. |
| AR | 10 | List/get/create-draft/finalize invoices, quotes, credit notes, customers (read only). No cash application. |
| AP | 5 | List/get/create/approve supplier invoices, suppliers (read only). No payment application. |
| Reporting | 9 | trial_balance, balance_sheet, profit_and_loss, aged_debtors, aged_creditors, vat_status, bank_accounts_status, search_gl, company_profile. Every one is a point-in-time snapshot with no comparatives, no totals, no drill-down and no completeness signal. |
| Practice / jobs | 7 | Practice clients, work items, job categories, time entries. Capture only — no job-costing or WIP report over any of it. |
| Governance | 2 | list_agent_postings, attach_document. |

Absent entirely: fiscal periods, period close, year-end close, payroll, fixed
assets, inventory, budgets, document retrieval, audit trail, users/permissions,
statements, consolidated or comparative reporting, and any endpoint that
reconciles one part of the system to another.

## 3. Live evidence, gathered today (Velocity Fibre)

Four calls, four confirmations that the documented defects are current.

**trial_balance** returned 7 accounts. Movement inside the current fiscal period
only — no opening balance, no closing balance, no total, no balanced assertion, no
way to request all accounts. On Brightsphere it returned 7 of 118 and the UI
stamped it "Difference R0.00 · Balanced". A trial balance that omits every account
without movement in the month is a period-movement listing wearing a trial
balance's name, and it is the single most important report in the system.

**aged_debtors** returned exactly 10 customer rows totalling R63.1m — with no
total line, no rows_total, no truncated flag and no pagination parameter. Ten is a
suspiciously round number. Either that is the whole book or the report silently
truncates; the response gives a machine no way to tell. There is also no
invoice-level drill-down: the report says Fibertime is owed R56.9m and offers no
route to the documents behind it.

**balance_sheet** returned assets R85.5m, liabilities R105.2m, equity −R19.6m. It
balances only because equity is the residual. No current/non-current split, no
subtotals by class, no comparative, no link to the P&L that produced retained
earnings. Note Interbank Transfer Clearing R14,081,940 sitting on the face of the
balance sheet — a clearing account should be nil, and nothing in the API flags
that.

**vat_status** returned 67,571 characters and exceeded the response limit. It
inlines every underlying transaction with no detail level and no pagination, so
the VAT201 for a two-month period is effectively unreadable programmatically on a
company of this size. Inside it: standardRatedPurchases = R15,401,348.82 against
input tax of R1,544,575.33, which implies R10,297,169 of purchases. SARS's own 15%
check on box 15 fails by R5.1m. This is the same defect logged on Brightsphere in
July–August, still live on a second company.

## 4. Findings mapped to the missing endpoint

Each row: the audit finding, and the endpoint whose absence caused it or allowed
it to survive.

| Finding | Value | Missing endpoint |
|---|---|---|
| amount_paid = 0.00 on all 163 customer invoices; R2.45m unallocated receipts | AR overstated R8.5m | apply_receipt_to_invoice |
| All 17 supplier invoices open; Sage shows all paid | AP overstated R613,642 | apply_payment_to_supplier_invoice |
| R371,470 of AP settled in Sage by contra, no payment document | blocks clearance | settle_by_contra |
| Aging ≠ control ≠ Sage, three answers to "what are we owed" | R1.43m / R7.09m | reconcile_subledger |
| 203 BT1 bank lines never imported; Velocity 4 months stale | R1.90m net movement | bank_statement_coverage |
| Nothing ever reconciled on any account, both companies | GL bank overstated R5.87m | perform_bank_reconciliation |
| No opening balances anywhere; bankOpeningBalance = 0 | GL vs bank uncomparable | get_opening_balances, bank opening balance |
| 55 prior periods open, 2027 closed, periods Jan–Dec vs FY March | anyone can post to 2022 | list_fiscal_periods, close_fiscal_period |
| Retained earnings R8.46m with zero journal lines; 4 year-ends never run | equity is a plug | year_end_close |
| Invoice with null due_date vanishes from the aging | R1,058,000 | integrity check |
| VAT column says "No VAT" while journal claims input tax | ~R45–55k over-claim | integrity check |
| Journals dated one day before their source bank transaction | ~4,300 postings, period risk | integrity check |
| Cost accounts typed default_expense | gross profit overstated R562,428 | chart_of_accounts_health |
| Seven loan accounts typed asset carrying credit balances | R8.4m misclassified | chart_of_accounts_health |
| Duplicate live control accounts (2001 / 2110 / SYS8) — cash flow reads the wrong one | AP movement shown as R0 | chart_of_accounts_health |
| Deactivated accounts still carrying balances | R450, R6,550 | integrity check |
| "QA Test Customer" R10,000 in production | −R10,000 on 1120 | integrity check |
| R1.65m VAT sitting in control since 2022; apparent shortfall R1.38m | R1,383,192 | vat_reconciliation |
| Box 1 / box 15 values don't tie to the tax at 15% | blocks filing | vat_status fix |
| 4,300 agent postings attributed identically to a human user | no agent/human split | audit_trail |
| No payroll: net pay only, no PAYE/UIF/SDL, no EMP201, no IRP5 | R2.72m salaries understated | payroll endpoints |
| R7,500 depreciation charged against no fixed assets | — | fixed asset endpoints |
| Sage invoice numbers renumbered 133 → 137 on migration | crosswalk permanently broken | external_ref on all documents |

## 5. Proposed endpoints

### Tier 0 — Existing endpoints to CHANGE

Cheaper than any new work below, and several of these are what made the audit
necessary in the first place.

| Endpoint | Change | Why |
|---|---|---|
| trial_balance | Rewrite: as_at or period, opening/movement/closing per account, all accounts, totalDebits/totalCredits/difference/balanced, accountsReturned/accountsTotal, comparative | Returns 7 of 118 accounts and the UI calls it "Balanced" |
| aged_debtors / aged_creditors | Add totals, pagination, detail: summary\|invoices, an unappliedReceipts column, and an excludedRows[] block | 10 rows, no total, no truncation signal; R1,058,000 invoice silently dropped |
| vat_status | Add detail: summary\|boxes\|full + pagination; derive box 1 and box 15 values from the same journals as the tax; exclude cancelled invoices from output tax | 67KB response; box 15 fails SARS's 15% check by R5.1m on Velocity |
| search_gl | Widen into general_ledger: multiple accounts, opening balances, source filter, cursor paging | One account / 200 rows means no complete GL can be extracted |
| balance_sheet | Add comparative, current/non-current split, class subtotals, and both equityFromLedger and equityResidual | The two equity fields alone would have exposed the R8.46m retained-earnings plug in one call |
| profit_and_loss | Drive totalCostOfSales off account subtype, not account name; add comparative, budget and %-of-revenue columns | R562,428 of gross profit overstated by two mistyped accounts |
| list_bank_transactions | allocatedEntityName must always resolve to the GL account; add allocationRuleName, vatCodeDisplayed, vatTreatmentPosted | One field carrying two kinds of value; "No VAT" shown over claimed input tax — the ~R50k over-claim |
| bulk_allocate_bank_transactions | Mandatory dry_run returning the journals that would post, plus idempotency_key | 4,319 journals in bulk is how a wrong VAT default scales unseen |
| list_agent_postings | Generalise into audit_trail with actor_type: human\|agent\|system and the MCP token id recorded as actor | 4,300 agent postings attributed to a human user |
| create_draft_invoice, create_supplier_invoice, create_draft_journal | Accept and index external_ref / external_document_number | Renumbering Sage 133 → IsaFlow 137 broke the crosswalk permanently |
| attach_document, set_opening_balance | Add the read side: list_documents, get_opening_balances, plus a bank opening balance | Both write and nothing reads back; no GL-vs-bank comparison is possible |

### Tier 1 — Close the loop on money

These are not reporting gaps. They are operations the business performs that the
API cannot express, which is why the ledger is wrong.

**apply_receipt_to_invoice** `{ customer_id, source: {bank_transaction_id | payment_id}, allocations: [{ invoice_id, amount, discount?, write_off? }], date, dry_run? }`
→ updated amount_paid per invoice, the resulting control-account journal, and any
unapplied remainder. Companion: `list_unapplied_receipts` (exists as a UI report,
not an endpoint) and `suggest_receipt_matches` (propose, never post — same pattern
as suggest_bank_allocation, which works well). This is the highest-value single
endpoint in the list. Without it the aged debtors report is a list of everything
ever invoiced, and R9.44m of collected cash has nowhere to land.

**apply_payment_to_supplier_invoice** — the AP mirror, same shape.

**settle_by_contra** `{ subledger: ar|ap, document_id, contra_account_id, amount, reason }`
Clears a debtor or creditor against a loan or intercompany account without
inventing a bank payment. R371,470 of Brightsphere AP cannot be cleared correctly
today because the only settlement path the API offers is a bank payment that never
happened.

**create_customer / update_customer, create_supplier / update_supplier**
You can raise an invoice but not create the party it is for. Any migration
therefore has a manual step in the middle, which is where the Sage crosswalk
broke.

**external_ref on every document-creating endpoint**
Invoices, supplier invoices, credit notes, journals, bank transactions. Accept and
store a source-system identifier, and expose it as a filter. IsaFlow auto-assigns
numbers and refuses a supplied one; that single decision means Sage INV0000136 and
IsaFlow INV0000136 are now different documents forever. Every future
reconciliation to a legacy system will mismatch.

**reverse_journal_entry**
Reversal exists for bank allocations only. Manual journals — including correction
journals — have no reversal path.

### Tier 2 — Endpoints that let a machine prove the books

**trial_balance v2** `{ as_at | fiscal_period_id, comparative_as_at?, include_zero_balances?, include_opening?, account_type?, cursor, limit }`
→ per account: opening / debit movement / credit movement / closing; plus
totalDebits, totalCredits, difference, balanced, accountsReturned, accountsTotal.
The current endpoint cannot support a sign-off. This one can.

**reconcile_subledger** — the endpoint I would build first if I could only build one report.
`{ subledger: ar | ap | bank | vat | payroll | inventory, as_at }`
→ `{ subledgerTotal, controlAccountBalance, difference, reconcilingItems: [{ type, description, amount, documentIds }] }`
The Brightsphere AR gap of R1,429,774 reconciled exactly to three items:
R2,436,024 of receipts credited to the control account but never applied,
−R1,058,000 for the null-due-date invoice, +R51,750 for a future-dated one. That
is a query, not a week of work. Run it nightly and no reconciliation break
survives longer than a day.

**general_ledger** `{ from_date, to_date, account_ids?, account_types?, include_opening, cursor, limit }`
search_gl handles one account, 200 rows. There is currently no way to extract a
complete general ledger — the base document of any audit file.

**bank_statement_coverage** `{ bank_account_id }`
→ first/last transaction date, count and net movement by month, day-level gaps,
duplicate bank_reference groups, opening balance state, GL balance vs statement
balance vs computed balance. The 203 missing BT1 lines were found only by holding
IsaFlow next to Sage. A coverage endpoint finds a gap without a second system, and
would have flagged Velocity's four-month import hole the week it opened.

**perform_bank_reconciliation** `{ bank_account_id, statement_date, statement_balance, transaction_ids[] }`
→ reconciled balance, outstanding items, difference. list_bank_reconciliations and
cancel_bank_reconciliation exist; nothing creates one. unreconciledCount ==
txnCount on every account in both companies, which is exactly what you would
expect when the only reconciliation verbs are list and cancel.

**get_opening_balances / set_bank_opening_balance**
set_opening_balance writes; nothing reads back, and bank accounts have no opening
balance concept at all. Until they do, no GL-versus-bank comparison is possible on
any account.

**cash_flow_statement** and **financial_statements** (AFS pack, with comparatives
and notes). The cash flow exists in the UI and reads the wrong AP control account;
there is no endpoint against which to test it.

**profit_and_loss additions** — comparative period, budget column, percentage-of-revenue
column, and a correct costOfSales bucket driven by account subtype rather than the
account's name.

### Tier 3 — Period, control and governance

**list_fiscal_periods / get_fiscal_period / close_fiscal_period / reopen_fiscal_period**
close should refuse on unreconciled banks, unposted suggested allocations, draft
journals and subledger breaks — and return the reasons rather than a boolean. An
agent cannot respect a lock it cannot read. 55 open prior periods with 2027 closed
is the control running exactly backwards, and no MCP client can currently even
observe it.

**period_close_checklist** `{ fiscal_period_id }` → the Month-End Workbench's
contents as data. That screen is the best thing in the product and it is UI-only.

**year_end_close** — roll the P&L into retained earnings, create comparatives,
lock the year. Brightsphere has four unclosed year-ends and R8.46m of "retained
earnings" that has never been posted to. Equity is currently a computed residual,
which is why the balance sheet balancing proves nothing.

**audit_trail** `{ from, to, user_id?, source?, entity_type?, entity_id?, action?, actor_type: human|agent|system, cursor }`
And, upstream of the endpoint: record the MCP token identity as the actor. Today
4,300 programmatic postings are attributed to "Hein van Vuuren" and are
indistinguishable from typed entries. For an accounting system that is not a
logging gap, it is an assurance failure — an auditor cannot form a view on
controls over a ledger that cannot say who posted to it.

**list_documents / get_document** — attach_document writes and nothing reads.
"Which transactions over R10,000 have no supporting document?" is a standard audit
test and is currently unanswerable.

### Tier 4 — Exception and integrity endpoints

One endpoint, a named suite of checks, each returning a count and sample rows:
`data_integrity_checks { checks?: [...], as_at, limit }`.

Ship it with these, all drawn from findings that took hours to locate by hand:

| Check | Caught |
|---|---|
| Invoices with null due_date | INV0000133, R1,058,000, invisible in the aging |
| Displayed VAT code ≠ posted journal VAT treatment | the entertainment input-tax over-claim |
| Journal entry date ≠ source bank transaction date | ~4,300 postings, VAT/year-end boundary risk |
| Duplicate bank references | 914 duplicated refs; reference unusable as a key |
| Deactivated accounts carrying a balance | 1140 R450, 1110 R6,550 |
| Accounts typed asset with credit balances | R8.4m of loans inside total assets |
| Cost-of-sales accounts typed as expense | R562,428 of gross profit |
| Clearing and suspense accounts non-nil | Interbank Clearing R14.08m, "Suspence Account" |
| Duplicate control accounts both in use | 2001 / 2110 / SYS8 — cash flow read the wrong one |
| Documents dated outside any open period | posting into 2022 today |
| Transactions in suggested state older than N days | 1,718 rows that look done and are not in the GL |
| Test/demo records in production | "QA Test Customer" R10,000 |
| Invoices with no revenue line / journals with no VAT line where expected | — |

**chart_of_accounts_health** — duplicates, type/subtype mismatches, system accounts
overlaid on an imported chart, accounts with no postings since inception,
misspellings. Brightsphere is running two charts of accounts on top of each other
and nothing in the API says so.

**vat_reconciliation** `{ from, to }` → per VAT period: VAT201 as computed, control
account movement, payments made to SARS, cumulative unpaid. The R1,383,192
apparent shortfall was assembled by hand from a Sage bank export. It should be one
call.

**vat_status fixes** — a `detail: summary | boxes | full` parameter and pagination
(67KB today); derive standardRatedSupplies and standardRatedPurchases from the
same journals as the tax so the 15% check ties; exclude cancelled invoices from
output tax. Then `vat201_export` and `lock_vat_period`.

### Tier 5 — Domains with no endpoint at all

**Payroll** — list_pay_runs, create_pay_run, post_payroll_journal, emp201_status,
irp5_data, list_employees. Neither company has a payroll process. Net pay is
auto-coded to Salaries & Wages; no PAYE, UIF or SDL liability is ever raised;
there is no EMP201 support and no IRP5 data. Employment cost is understated by
every employer contribution, and the statutory exposure is of the same order as
the VAT one. The GL structure already exists (2140/2150/2160/2170/2175) — it is
deactivated and empty.

**Fixed assets** — list_fixed_assets, create_asset, dispose_asset, run_depreciation,
asset_register. R7,500 of depreciation is charged against assets that are not on
the balance sheet.

**Inventory / items** — list_items, stock_movements, stock_valuation. Claimed in
FEATURES.md, absent from the MCP.

**Statements** — customer_statement / supplier_statement `{ entity_id, as_at, format }`.
You cannot chase a debtor programmatically today.

**Job costing / WIP** — job_cost_report, wip_report, project_profitability. IsaFlow
captures work items, job categories and time entries and reports on none of them.
For a fibre contractor this is the management report: revenue, direct cost, labour
and margin by project. It is also the natural join to FibreFlow, which already
exposes project, build-progress and procurement data over its own MCP — a
project_profitability endpoint keyed on a shared project reference would give
Velocity a contract-level P&L that neither system can produce alone.

**Budgets** — set_budget, budget_variance. Nothing to compare actuals against.

## 6. Cross-cutting rules the whole API should adopt

These matter more than any individual endpoint.

1. **Every report must state its own completeness.** rowsReturned, rowsTotal,
   truncated, next_cursor. aged_debtors returned exactly ten rows and no way to
   know whether that was the book. A figure whose completeness cannot be
   established cannot be relied on, and an agent has no instinct that says "ten is
   suspicious".

2. **Every report needs a detail level.** summary (totals only), standard, full
   (with transactions). vat_status returns 67KB because it has one mode and it is
   the largest one.

3. **Every aggregate needs a drill-down.** If a report says a customer owes
   R56.9m, the same call should return, or link to, the invoice ids behind it.
   Otherwise every investigation is a manual reconstruction.

4. **One figure, one query.** Cash has four answers across dashboard, balance
   sheet, cash flow and reality; AR has four; revenue two. This is not four bugs,
   it is four implementations. The MCP and the UI should call the same figure
   service, and the endpoint should return the definition it used. Then a
   disagreement is impossible rather than merely detected.

5. **dry_run and idempotency keys on every mutating endpoint.**
   bulk_allocate_bank_transactions can post thousands of journals in one call.
   Bulk allocation with a wrong VAT default is how a R45k over-claim scales; a
   mandatory dry-run that returns the resulting journals before posting turns that
   into a review step.

6. **Reports should carry an as_at and a posted_through timestamp**, so a figure
   can be re-derived identically later. Nothing in the current API supports
   point-in-time re-derivation, which means no report can be reproduced as it
   stood at signature date.

7. **Refuse rather than silently drop.** A null due_date currently removes an
   invoice from the aging with no error. Reports should return an excludedRows
   block naming what they could not classify and why.

## 7. What I would build, in order

1. apply_receipt_to_invoice + apply_payment_to_supplier_invoice — the ledger is wrong until these exist.
2. reconcile_subledger — turns a week of audit work into a nightly job.
3. trial_balance v2 — nothing can be signed off on the current one.
4. data_integrity_checks — cheapest endpoint here and it catches a dozen live findings.
5. Fiscal period endpoints + close_fiscal_period — the control is inverted and invisible.
6. vat_status fixes + vat_reconciliation — blocks filing today, on two companies.
7. audit_trail with actor type — you cannot separate agent from human on 4,300 postings.
8. bank_statement_coverage + perform_bank_reconciliation — completeness and the recon that has never been run.
9. external_ref everywhere + customer/supplier CRUD — makes migration reproducible.
10. Payroll — the largest untouched statutory exposure.

Items 1–4 would, on their own, have caught or prevented roughly two-thirds of the
26 Brightsphere findings.

## 8. One caution

Most of the value above is in read endpoints, and the temptation with an MCP
surface is to keep extending the write path because it demos better. Brightsphere
is the argument against that. The write path worked — 4,319 allocations posted,
samples tying to the cent — and the books are still materially wrong, because
nothing in the system could tell anyone that the subledgers had drifted from the
control accounts, that half the feed had never reached the GL, or that four years
of periods were open.

An accounting system is judged on what it can prove, not on what it can post.
