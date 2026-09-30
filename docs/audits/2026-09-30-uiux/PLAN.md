# IsaFlow UI/UX audit 2026-09-30 — remediation plan

Base: origin/master 3591a6380. Audit SHA 66e776d81. Only R-168/R-170 merged since (10 practice files); every other cited line is byte-identical. P0 roots re-read on master. Severities below apply verify-a/b/c corrections (53 P0 → 33 P0).
Reuse, do not rebuild: `apiJson` + `src/lib/apiRoutes.ts` (envelope defects), `localISODate` in `src/lib/dateUtils.ts`, figure owners in `src/lib/mcp/contracts/figures.ts` (cash.ledger.v1 = bank/cashBalanceService#getCashBalance, ar.subledger.v1, vat.output.v1 = vat201ReportService, fiscalyear.start.v1 = gl/fiscalYearBasis, ppe.register/ppe.ledger), `closeReadinessChecks/*`, `fixedAssetReconciliationService`, `assertOk` in `src/lib/apiFetch.ts`, guard-census tests in `tests/unit/guards/`.
Ledger-sensitive = Y → GL-figure review gate before merge.

## 1. Work packages

### Wave 1 — shared root-cause utilities
| WP | Title | Root cause | Findings | Sev | Lane | Files | Ledger | Hein? | RED on master |
|---|---|---|---|---|---|---|---|---|---|
| W1-01 | Local-calendar date defaults | `new Date(y,m,1).toISOString().split('T')[0]` shifts a day in SAST (vat-return.tsx:49-55, cashbook.tsx:32-38, executive-dashboard.tsx:64, timesheets/index.tsx:38,75) — 94 UI files | RPT-06 TAX-04 BNK-28 PAY-15 | P0 | shell | src/lib/dateUtils.ts (+monthStartISO/monthEndISO/prevMonthRange/fyStartISO); ~94 pages/components | Y (VAT201 default period) | N | `tests/unit/guards/utcCalendarDefaultCensus.test.ts` scanning pages/** + src/components/** for `toISOString().split('T')[0]`/`.slice(0,10)` → 94 hits; `TZ=Africa/Johannesburg` `prevMonthRange(new Date(2026,8,30))` = 2026-08-01..08-31 |
| W1-02 | Envelope/field-name read defects → apiJson | pages guess fields: import-pdf.tsx:190 `a.name` (API `accountName`); capture/settings.tsx:57 `json.data` (API `data.inbox`); products/[productId].tsx:15,21 `sku/qty_on_hand` (API `code/current_stock`); migration/validate.tsx:34-38 `json.data.id` (API `{session}` — route already registered); document-capture/[docId].tsx:74-78 scans page 1 of list | BNK-05 PUR-09 INV-03 LED-17 PUR-08 | P0 | settings | src/lib/apiRoutes.ts; the 5 pages; document-capture API `?id=` | N | RTL: import-pdf option label = accountName (RED empty); validate with `{data:{session:null}}` shows "No active migration session" (RED blank); docId not in first 25 loads (RED "not found") |
| W1-03 | Mutations report success on 4xx | `apiFetch` resolves on 4xx; user-access.tsx:65-85 wipes list + "Role updated."; useBankTxActions.ts:57-62 silent; bank-transactions/index.tsx:175-191 POSTs relink on every view | SET-11 BNK-27 | P1 | settings | user-access.tsx; useBankTxActions.ts; bank-transactions/index.tsx; guard test | N | RTL: role PATCH → 409 keeps list + shows error (RED wiped); census: mutating `apiFetch` not passed to `assertOk`/`apiJson` → count > 0 |
| W1-04 | Dead links & ignored query params | accept-invite.tsx:66 → /accounting/dashboard (404); :22 no-token spinner; next.config.js:95 redirect shadows pages/payroll/year-end; payroll/year-end/index.tsx:230,284 → /accounting/settings/company; CreateNewMenu.tsx:46-52 `?action=new`; wip/index.tsx:206 `?id=`; practice nav `?view=groups`/`?action=invoice`; sent-mirror.tsx:194 /accounting/ar; BillingTabParts.tsx:224; activeTab.ts dead paths | NAV-01 SET-13 NAV-02 NAV-04 JRN-10 NAV-15 NAV-28 PRC-10 PRC-14 | P1 | shell | accept-invite.tsx; next.config.js; CreateNewMenu.tsx; navSections/practice.ts; wip/index.tsx; sent-mirror.tsx; payroll/year-end/index.tsx; BillingTabParts.tsx; activeTab.ts | N | `tests/unit/guards/internalLinkCensus.test.ts`: every nav/CreateNew/`router.push('/…')` literal resolves to a pages/ route not shadowed by a redirect → RED on 6 targets |
| W1-05 | Global search: real columns, no swallowed errors, record URLs | globalSearchService.ts:112-252 selects non-existent columns, `catch → []`; hits link to list `?id=` / `?tab=accounts` (:101-248) | JRN-01 NAV-03 | P1 | shell | globalSearchService.ts | N | int: `global-search?q=<invoice no>` returns hit (RED []); unit: every result href matches a pages/ route |
| W1-06 | Overlays render under sticky nav | AppLayout sticky header z-index ≥ hand-rolled `fixed inset-0 z-50` overlays (customer-quotes/index.tsx:49, EvidenceDrillModal.tsx:134-142, CaptureInboxPanel) | SAL-14 LED-11 PUR-28 | P1 | shell | AppLayout.tsx; ui/Modal.tsx; ui/Drawer.tsx; tailwind z tokens; 3 overlays (+Esc close) | N | Playwright: `elementFromPoint` at modal title is inside the modal (RED nav) |
| W1-07 | Supplier pickers capped at 25 | suppliers-list.ts:31,47 default limit 25; 15 callers use `<select>` with no q/limit (supplier-invoices/new.tsx:58, useBankTxRefData.ts:62, useBankRuleRefData.ts:111, bank-transactions/new.tsx:84 …) | PUR-01 | P0 | purchases | new SupplierSelect over SupplierTypeahead; suppliers-list.ts; 15 callers | N | census: callers of suppliers-list without `q=`/`id=` → 12 (RED); int: supplier #26 findable |
| W1-08 | List KPIs from the visible page | customer-invoices/index.tsx:95-97 & suppliers/index.tsx:111-113 reduce over 25 rows; overdue = `status==='overdue'` | SAL-02 PUR-10 | P0 | sales | customer-invoices list API + page; suppliers-list.ts + suppliers/index.tsx | Y (AR outstanding) | int: list API `summary.overdueCount` == SQL count on ar.subledger predicate (RED absent) |

### Wave 2 — figures that disagree / ledger & report correctness (GL = source of truth)
| WP | Title | Root cause | Findings | Sev | Lane | Files | Ledger | Hein? | RED on master |
|---|---|---|---|---|---|---|---|---|---|
| W2-01 | Cash position = cash.ledger.v1 | kpiDashboardService.ts:87-101 & BankTxBankCards.tsx:118 use SUM(bank_transactions) (bankAccountStatusService.ts:87) labelled cash/"GL Balance" | BNK-03 JRN-03 BNK-20 | P0 | banking | kpiDashboardService.ts; BankTxBankCards.tsx; StatementBalanceWidget.tsx; BankAccountCard.tsx; dashboard hero/overview | Y | N | int: fixture with one unallocated feed line → dashboard cashPosition == getCashBalance() (RED) |
| W2-02 | Cash-flow statement & mgmt-accounts reconcile to GL | reports-cash-flow.ts:118-163 closing = opening+NI+ΔAR+ΔAP, never tied to cash; reports-management-accounts.ts own engine; reports/cash-movement.ts statement sum | RPT-02 RPT-01 | P0 | reports | reports-cash-flow.ts; reports-management-accounts.ts; reports/cash-movement.ts; reuse afs/cashFlowDirectService | Y | N | int: closing_cash == getCashBalance(period_end) (RED) |
| W2-03 | Cash-flow forecast inputs | cashFlowForecastDataService.ts:45-110 no upper date bound; :135-150 drops overdue AP; cash-flow-forecast.ts:57 AI failure → databaseError | RPT-09 RPT-05 | P1 | reports | cashFlowForecastDataService.ts; cash-flow-forecast.ts | N | int: future-dated journal excluded, overdue bill included (RED) |
| W2-04 | P&L account detail ignores FY start | accountLedgerService.ts:96,111 opening = all entries < fromDate (also MCP general_ledger via lib/mcp/tools/reports.ts) | LED-01 | P0 | ledger | accountLedgerService.ts (use fiscalYearBasis) | Y | N | int: P&L account with prior-FY postings → drill closing == TB (RED) |
| W2-05 | Fiscal-year & regional settings single source | FY start in GeneralTab vs Compliance "year-end month" (ComplianceTab.tsx:130); Jan–Dec periods vs FY-start 3 not detected; duplicate regional columns (GeneralTab.tsx:72-107 vs RegionalTab.tsx:86-170); reporting_currency placebo (accounting-settings.tsx:22-34) | LED-16 SET-06 SET-09 | P1 | settings | GeneralTab/RegionalTab/ComplianceTab; fiscal-years API; accounting-settings.tsx | Y | Y: which wins when periods ≠ FY start (+ prod count); drop reporting_currency? | int: FY-start 3 with Jan–Dec periods → mismatch warning (RED none) |
| W2-06 | Depreciation screen empty | depreciation/index.tsx:108 sends comma list; assets.ts:38,45 exact match | LED-02 | P0 | ledger | assets.ts; depreciation/index.tsx | Y | N | int: `assets?status=available,assigned` > 0 rows (RED 0) |
| W2-07 | Register ↔ FAR ↔ GL reconciliation surfaced | three stores unreconciled in UI; fixedAssetReconciliationService MCP-only; POST /api/accounting/assets posts no journal | LED-03 LED-04 | P1 | ledger | assets pages; new recon panel over fixedAssetReconciliationService; assets.ts | Y | Y: should /assets/new post capitalisation (Dr PPE / Cr ?) or require a bill/journal link? | int: after POST asset, list/recon flags register-vs-GL gap (RED silent) |
| W2-08 | Subledger ↔ control tie-out in close & aging | monthEndWorkbenchService.ts has no subledger check; CloseReadinessChecklist only in FiscalPeriodsTab.tsx; aging reports no control row; ar.control.v1 owner null | LED-05 RPT-10 | P1 | ledger | monthEndWorkbenchService.ts; ar/ap aging pages; closeReadinessChecks | Y | N | int: approved invoice without JE → workbench returns failing AR-vs-control item (RED) |
| W2-09 | AR balance: aging vs statements vs Send Statements | statements/index.tsx:56-97 balance from customer-statements (allocations) vs overdue from ar-aging (`amount_paid`); send pre-selects all | SAL-03 SAL-04 SAL-24 | P0 | sales | statements/index.tsx; arAgingService.ts; customer-statements.ts | Y | Y: balance source = allocations or amount_paid? (rec: allocations; amount_paid a cache + repair) | int: CN allocated to paid invoice → aging == statement (RED) |
| W2-10 | Report sign / null rendering | three-way-forecast.tsx:40 `Math.abs`; financial-analysis.tsx:187 guards only undefined; exec-dashboard colours by sign not direction; waterfall.tsx:28-33 no picker, CoS colour | RPT-03 RPT-04 RPT-22 RPT-26 | P0 | reports | src/lib/format (fmtSignedMoney, fmtRatio); 4 pages | Y | N | RTL: GP −161 391 renders negative (RED); debtToEquity null renders "n/m" (RED throws) |
| W2-11 | Budget vs actual | budgetVsActualLines.ts:70-77 −100% when budget 0; reports-budget-vs-actual.ts:176 sums revenue+expense | RPT-08 | P0 | reports | budgetVsActualLines.ts; reports-budget-vs-actual.ts; page empty state | Y | N | unit: revenue budget 0 → "no budget" not −100; total = net (RED) |
| W2-12 | Account-transactions selector | account-transactions.tsx:44,60 default 1110 filtered by level≥3 | LED-06 | P1 | reports | account-transactions.tsx | N | N | RTL: selected option == body account; bank accounts selectable (RED) |
| W2-13 | Dashboard counters: one predicate per queue | dashboard-todos.ts:69,85 `LIMIT 10` as count; workbenchService.ts:24-72 vs supplierInvoiceWhereBuilder.ts:99-104 vs bankAccountStatusService.ts:93-110 predicates differ; drills unfiltered | JRN-02 JRN-04 JRN-05 JRN-06 BNK-04 | P0 | banking | new dashboard/queuePredicates.ts; dashboard-todos.ts; TodoWidget.tsx; workbenchService.ts; supplierInvoiceWhereBuilder.ts; bankAccountStatusService.ts | N | N | int: 11 overdue → todo count 11 (RED 10); tile count == linked list total (RED) |
| W2-14 | Month-end workbench links & load | monthEndWorkbenchService.ts:252-259 cards lack periodId, exceptions no href; close-run/index.ts:51 404 when none | JRN-07 LED-29 | P1 | ledger | monthEndWorkbenchService.ts; close-run/index.ts | N | N | unit: every card href has periodId (RED); GET close-run none → 200 (RED 404) |
| W2-15 | VAT201: one engine, SARS field numbers | vatReturnService.ts:22,117-128 Box 1 = tax not supply; two H1 "VAT201 Return" pages; /sars/vat201 boxes 1–11; blocking+info exceptions summed | TAX-05 TAX-06 TAX-08 | P0 | tax | reports/vat-return.tsx; vatReturnService.ts; components/accounting/sars/VAT201*.tsx | Y | Y: retire /reports/vat-return or keep as view on vat201ReportService? | int: reports-vat-return field1 == sars-vat201 field1 (RED) |
| W2-16 | SARS filing status single source | calendar reads sars_compliance_events (no writer, sarsComplianceService.ts:142); recon reads vat_returns (written only by uncalled submitVATReturn); UI writes sars_submissions; "submitted" without ref/date | TAX-01 TAX-03 TAX-12 TAX-13 | P0 | tax | sarsComplianceService.ts; vatReconciliationService.ts; sars/submissions; sars/vat201.tsx | Y | Y: canonical = sars_submissions? mark-submitted locks VAT period? | int: markSubmitted → calendar 'completed', recon not "not yet submitted" (RED) |
| W2-17 | VAT category & due dates per company | sarsComplianceService.ts:134 `getComplianceCalendar(year)` default 'odd' with parity inverted vs vatPeriodHelper.ts:6-13; due day 25th (sarsTaxPeriodsService.ts:110); no company obligations; VAT-adjustment free-text period | TAX-02 TAX-09 TAX-10 TAX-11 TAX-21 | P0 | tax | sarsTaxPeriodsService.ts; sarsComplianceService.ts; sars/vat201.tsx default; vat-adjustments form | Y | Y: due date 25th vs last business day | unit: 'odd' calendar periods end Jan/Mar… == vatPeriodHelper (RED) |
| W2-18 | PAYE/EMP501/IRP5 vs declared & GL | sarsCodesService.ts:87-93 strict year, no "table not loaded" state; emp501/reconciliation.ts:64-93 self-check; EMP201 no GL control | PAY-03 PAY-04 TAX-16 | P1 | payroll | sarsCodesService.ts; irp5ValidationEngine.ts; emp501 recon API+page; emp201 page | Y | Y: prod has 2027 codes? block e@syFile when missing? | int: GL PAYE ≠ run header → variance flagged (RED "All reconcile") |
| W2-19 | Inventory: one model, valuation | items (0 rows) vs products (stock-levels.ts:18-20); avg_cost never written (products.ts:45, stock-adjustments.ts:87); sales-by-item.ts:26-35 groups by description | INV-01 INV-02 INV-06 | P0 | purchases | items/products services+pages; stock-levels.ts; reports/sales-by-item.ts | Y | Y: items or products? valuation method? | int: 80 × R1 200 → stock value 96 000 (RED 0) |
| W2-20 | One PO system | purchase_orders (nav/GRN) vs supplier_purchase_orders (reports-supplier-pos.ts:74, purchaseOrderPdfBuilder.ts:32 → 404 for nav POs); [poId].tsx:59 list fetch | PUR-06 PUR-05 | P0 | purchases | purchaseOrderService.ts; purchaseOrderPdfBuilder.ts; reports-supplier-pos.ts; supplier-purchase-orders pages | N | Y: retire supplier_purchase_orders (prod count?) | int: purchase-order-pdf for a purchase_orders id → 200 (RED 404) |
| W2-21 | Bill header VAT rate ignored | supplier-invoices/new.tsx:53,267-269 header rate never reaches lines; supplierInvoiceTotals.ts:64 line wins; supplier-invoices.ts:84 drops 0 | PUR-02 | P0 | purchases | supplier-invoices/new.tsx; BillLineItemsTable.tsx; supplierInvoiceTotals.ts; supplier-invoices.ts | Y | N | int: POST taxRate 0 → VAT 0 (RED 150) |
| W2-22 | Supplier "unallocated" queue | supplier-payments.ts:46 ignores `unallocated`, no allocatedAmount | PUR-03 | P0 | purchases | supplier-payments.ts; supplier-allocations/index.tsx | Y | N | int: fully allocated payment excluded (RED included) |
| W2-23 | AP aging vs statement (post-dated payments) | apAgingService.ts:82-87 rewind keeps payments dated after as-at | PUR-04 | P1 | purchases | shared/agingRewind.ts; apAgingService.ts | Y | N — execute inside R-074 | int: post-dated payment → aging == statement at as-at (RED) |
| W2-24 | Cashbook | cashbook.tsx:66-94 sends from/to (API reads from_date/to_date, bank-transactions.ts:25,35-36); cap 100; running balance from 0 | BNK-01 | P0 | banking | cashbook.tsx; bank-transactions.ts | Y | N | RTL: request carries from_date; opening row from getCashBalance (RED) |
| W2-25 | Reconciliation workspace full dataset | [reconId].tsx:68,82 limit 500/200 vs cap 100 (bankTransactionQueryService.ts:58) / 200; counts from truncated set; no difference breakdown | BNK-02 BNK-12 | P0 | banking | [reconId].tsx; cursor use; difference panel | Y | N | RTL/int: 150-line recon shows 150 unmatched (RED 100) |
| W2-26 | Bank rule VAT default | create-rule modal defaults Standard 15% ignoring line classification; duplicate/targetless rules | BNK-11 BNK-22 | P1 | banking | bank-rules modal; BankRulesHeader.tsx; rule validation | Y | N | RTL: rule from 2170 salaries row defaults to no-VAT (RED 15%) |
| W2-27 | Loans vs GL | loan_period_locks independent (loanPeriodCloseService.ts:58-63); portfolio total = principals (loanScheduleService.ts:250) | LED-13 LED-14 | P1 | ledger | loan services | Y | Y: retire loan_period_locks for fiscal locks? | int: portfolio outstanding == schedule balance today (RED). Execute inside K-175/K-176/R-062 |
| W2-28 | Default Accounts strips system accounts (HOTFIX) | default-accounts.ts:61-66 GET reads app_settings only; :138-148 POST clears is_system_account for all 8 subtypes; 4 rows map to nothing | SET-01 SET-02 LED-19 | P0 | settings | default-accounts.ts; default-accounts/index.tsx | Y | Y: remove or wire the 4 no-op rows | int: seeded company GET shows 1120 for AR (RED "Not configured"); POST `{mappings:{}}` keeps 8 flags (RED 0) |
| W2-29 | AFS draft correctness gate | AFS renders raw GL at 0/118 mapped; compliance year-end from another FY source; employee-cash sign | RPT-20 | P1 | reports | afs services/pages | Y | N (after W2-05) | int: generate at 0% mapping → blocking finding (RED none) |
| W2-30 | Practice reports correctness | practiceReportsService.ts:141 revenue = 'billed' only (timesheet path writes 'invoiced'); 239-316 pipeline = approved × 0.8; "Compliance" = timesheet days | PRC-11 PRC-12 | P1 | practice | practiceReportsService.ts; reports pages | N | Y: drop 0.8/relabel; rename Compliance report | int: 'invoiced' entry counted in revenue (RED 0) |
| W2-31 | Report-pack rendering | PackSectionCard.tsx:67-69 prints null/[object Object]; :80-83 dev placeholders; Present renderer gaps; PDF 503 (env, unverified prod) | RPT-07 RPT-11 RPT-19 | P1 | reports | PackSectionCard.tsx; present/[pack].tsx | N | Y: is feat/ws4-board-pack landing? if yes fold in | RTL: ratio null → "n/m", no placeholder text (RED) |

### Wave 3 — blocked workflows / missing CRUD
| WP | Title | Root cause | Findings | Sev | Lane | Files | Ledger | Hein? | RED on master |
|---|---|---|---|---|---|---|---|---|---|
| W3-01 | Payroll run: approve & explain | runs/[id].tsx:183-232 no Approve (approve.ts has no UI caller); deductions/employer UIF hidden; warnings ungrouped (:171-178); variance.tsx:99 headcount as R; runs list no JE/EMP201 link | PAY-01 PAY-06 PAY-08 PAY-09 PAY-24 | P0 | payroll | runs/[id].tsx; variance.tsx; runs/index.tsx | Y | N | RTL: calculated run shows Approve → POST /approve (RED) |
| W3-02 | Payroll period context & run creation | PayrollPeriodBar.tsx:29-36 current = max run, 'posted' not 'paid'; period-context.ts:42 FY not tax year; runs/new.tsx:22-23 free year; nothing sets 'paid' (bureauWorkAggregatorService.ts:43-48) | PAY-11 PAY-12 PAY-13 | P1 | payroll | PayrollPeriodBar.tsx; period-context.ts; runs/new.tsx; bureauWorkAggregatorService.ts | N | Y: add 'paid' transition? | unit: Jan-2031 draft + Sep-2026 approved → current ≠ Jan 2031 (RED) |
| W3-03 | Employee bank/payment method/anchors | no bank or payment-method fields (employees/new.tsx:116-167); validationEngine.ts:46,56,119 anchors missing; DOB not from ID | PAY-07 PAY-17 | P1 | payroll | employee pages; validationEngine.ts | N | N | RTL: #bank-details exists with fields (RED) |
| W3-04 | Practice client lifecycle | no edit UI (PUT exists); linkCustomerId unsettable (clients/[id].tsx:254-263); Prospect default vs Active pickers (practiceApi.ts:138, jobs/new.tsx:57); empty state hides CTA (clients/index.tsx:264-281); WIP VAT free-typed (wip/index.tsx:117,153) | PRC-01 PRC-06 PRC-07 PRC-17 PRC-25 | P0 | practice | clients/[id].tsx; clients/new.tsx; clients/index.tsx; practiceApi.ts; wip/index.tsx | Y (WIP invoice VAT) | Y: new client default Active? | e2e/int: UI-created client linkable → WIP invoice generates (RED no link) |
| W3-05 | Practice time first-use & job link | 0 seeded work items but TimeEntryForm.tsx:215 requires one; job_id never written (practiceTimeEntryService.ts:118-131); resolveRate ignores work-item override (practiceStaffRateService.ts:105-135) | PRC-02 PRC-08 PRC-21 | P1 | practice | TimeEntryForm.tsx; practiceTimeEntryService.ts; practiceJobCategoryService.ts; practiceStaffRateService.ts | N | N | int: entry with jobId persists job_id (RED null) |
| W3-06 | Customer & supplier edit | customers.ts:148 GET/POST only; suppliers-list.ts:119-132 PATCH drc only | SAL-01 PUR-07 | P0 | sales | customers.ts; suppliers-list.ts; customer/supplier edit pages | N | N | int: PUT customer email (RED 405) |
| W3-07 | Bill draft edit & supplier defaults | SupplierInvoiceSummary.tsx:54-55 edits due/terms/notes only; new.tsx:65 `accountCode >= '5000'` string filter; no supplier defaults | PUR-12 PUR-13 | P1 | purchases | supplier-invoices/new.tsx; SupplierInvoiceSummary.tsx; draft edit API | Y | N | RTL: GL list includes 1xxx postable, excludes junk (RED) |
| W3-08 | GRN from PO | goods-received/new.tsx ignores ?poId; :99 deliveryNote → receivedBy | PUR-11 | P1 | purchases | goods-received/new.tsx | N | N | RTL: ?poId preselects PO (RED) |
| W3-09 | Credit notes: type split & invoice link | creditNoteService.ts:119-124 lists both types; credit-notes/new.tsx no invoice/lines/?invoiceId; raw status/Date.toString | SAL-07 SAL-15 PUR-16 | P1 | sales | creditNoteService.ts; credit-notes pages; supplier-returns | Y | N | int: customer CN list excludes supplier type (RED) |
| W3-10 | Sales document chain navigable | customer-sales-orders/index.tsx:222-233 rows not links; quotes no detail; no SO→DN / DN→invoice | SAL-05 SAL-08 | P1 | sales | sales-orders list; quotes detail (new); delivery-notes/[id].tsx | N | N | RTL: confirmed SO row links to detail (RED) |
| W3-11 | Sales invoice form | customer-invoices/new.tsx:205 FibreFlow line types; terms not applied; no ?clientId; FibreFlow copy | SAL-09 JRN-25 | P1 | sales | customer-invoices/new.tsx; list empty state | Y | N (item picker waits W2-19) | RTL: client with net30 sets due date (RED blank) |
| W3-12 | Receipts from invoice & receipt queues | customer-payments/new.tsx:136 cancel/save → list; allocation select width; two receipt queues; auto-match same invoice | SAL-10 SAL-17 | P1 | sales | customer-payments/new.tsx; customer-allocations; ar/receipt-match | Y | N | RTL: from ?invoiceId Cancel returns to invoice (RED) |
| W3-13 | Capture inbox review panel | CaptureInboxPanel.tsx: no preview/confidence/edit; hover-only Post (inbox.tsx:208-213) | PUR-14 | P1 | purchases | CaptureInboxPanel.tsx; capture/inbox.tsx | Y | N (after R-169) | RTL: panel renders preview + editable totals (RED) |
| W3-14 | Journals list & draft lifecycle | new.tsx:200 "Post" creates draft; [entryId].tsx:126 no edit/delete; journalEntryCrudService.ts:85-133 last 50 manual | LED-09 LED-10 | P1 | ledger | journal-entries/new.tsx, [entryId].tsx; JournalEntriesTab.tsx; journalEntryCrudService.ts | Y | N | RTL: draft shows Edit/Delete; API paginates (RED) |
| W3-15 | Drill-through rows → JE → source document | no shared source-document href; AccountLedgerTable.tsx, [entryId].tsx:105,214, aging/GL/VAT201 tables plain text | LED-07 LED-08 LED-18 RPT-16 TAX-07 BNK-06 | P1 | ledger | new src/lib/sourceDocumentHref.ts; AccountLedgerTable.tsx; [entryId].tsx; report tables; VAT201 components; BankTxAllocatedAccountCell.tsx; CoA rows | N | N | unit: resolver covers every gl_journal_entries.source (RED missing); RTL: ledger row entry no. is a link |
| W3-16 | Company settings save semantics | companyService.ts:96-107 `COALESCE(null,col)` can't clear; company-settings.tsx:120-134 unchecked PUTs; no unsaved guard; two saves | SET-03 SET-04 SET-05 SET-15 | P1 | settings | companyService.ts; company-settings.tsx | N | N | int: PUT fax '' → null (RED old value) |
| W3-17 | Company switch consistency | portfolio-workbench.tsx:108-127 bypasses CompanyContext.switchCompany; record-page switch crashes | JRN-08 JRN-09 | P1 | shell | portfolio-workbench.tsx; CompanyContext; invoice detail | N (wrong-client risk) | N | RTL: client click calls switchCompany (RED) |
| W3-18 | Long reports complete & paginated | AR/AP aging "first rows only (server cap)"; audit trail 6 581 rows unpaginated | RPT-17 | P1 | reports | aging/audit-trail APIs+pages | N | N | int: aging returns all rows or cursor (RED capped) |
| W3-19 | Consolidation companies 500 masked | GET consolidation/companies 500 rendered as empty state (cause uninvestigated) | SET-12 | P1 | settings | pages/api/accounting/consolidation/companies*; page | N | N | int: GET → 200 (RED 500) |
| W3-20 | Year-end close safety | year-end/index.tsx live Process on empty years; :51 posts with no confirm | LED-27 | P2 | ledger | year-end/index.tsx | Y | N | RTL: zero-activity year disabled + confirm dialog (RED) |
| W3-21 | Approvals queue | approvals empty while 83 drafts; approval creation has no caller (R-035) | PUR-18 | P1 | purchases | approvals page | Y | Y: bill approvals mandatory? (R-035) | blocked on R-035 |
| W3-22 | Bank match candidate ranking | Find & Match ranks no exact-amount/date proximity; score unexplained | BNK-14 | P1 | banking | bankMatchDbQueries.ts; match modal | Y | N | unit: exact amount same week outranks +1 month/different amount (RED). Coordinate K-142 |

### Wave 4 — navigation / breadcrumbs / search / menus (listed only; rebuilt per IA design)
| WP | Bucket | Findings | Sev |
|---|---|---|---|
| W4-A | Active-tab resolver & sub-nav (activeTab.ts:94,165 fallback 'dashboard') | NAV-05 NAV-06 JRN-15 BNK-08 SAL-11 INV-04 PUR-15 RPT-28 SET-16 PAY-10 PAY-19 | P1 |
| W4-B | Breadcrumbs, back/cancel/save targets | NAV-10 NAV-11 RPT-13 NAV-12 NAV-13 NAV-21 BNK-23 LED-25 TAX-15 INV-08 PUR-21 PRC-20 NAV-19 | P1 |
| W4-C | Menus, orphans, duplicate pages | NAV-07 NAV-08 NAV-17 NAV-18 NAV-20 SET-07 SET-08 SET-18 JRN-16 JRN-23 JRN-24 BNK-13 BNK-29 TAX-14 PRC-24 RPT-14 RPT-15 SAL-18 PUR-17 PUR-22 LED-24 JRN-30 | P1 |
| W4-D | Landings/home, route metadata (titles), tour | NAV-09 JRN-11 BMK-01 JRN-19 JRN-17 | P1 |
| W4-E | Palette, shortcuts, URL state | BMK-05 NAV-22 BNK-07 BNK-24 SET-14 PRC-16 | P1 |
Note W4-C: PUR-17 orphans call broken APIs (K-223/K-224) — fix those before re-linking.

### Wave 5 — new features needing product design
| WP | Title | Findings | Sev | Hein? |
|---|---|---|---|---|
| W5-01 | Accountant cockpit; practice client ↔ books | JRN-12 BMK-02 PRC-05 PAY-14 | P1 | Y: which page is home |
| W5-02 | Fee calculator & engagement billing | PRC-03 | P1 | Y |
| W5-03 | Payslips & employee 360 | PAY-05 PAY-21 | P1 | Y |
| W5-04 | Practice overview & client 360 | PRC-04 | P1 | Y |
| W5-05 | Statutory deadlines per practice client | PRC-13 | P1 | Y |
| W5-06 | Unified time capture | PRC-09 NAV-14 | P1 | Y (R-078/R-106 billing paths) |
| W5-07 | One month-end close flow | LED-12 | P1 | Y |
| W5-08 | Customer & supplier 360 | SAL-06 PUR-19 | P1 | Y |
| W5-09 | Supplier pay-run builder | PUR-20 | P1 | Y (K-136/K-253/K-254/R-134/K-278) |
| W5-10 | One pack system | RPT-12 | P1 | Y (ws4-board-pack) |
| W5-11 | Batched client queries | BMK-03 | P1 | Y |
| W5-12 | Plan/billing page for subscription tenants | SET-10 | P1 | Y |
| W5-13 | Privacy / Terms / Security pages | NAV-16 | P1 | Y: legal content owner |

### Wave 6 — P2 polish / mobile / visual
| WP | Title | Findings | Sev |
|---|---|---|---|
| W6-01 | Canonical SA money/date formatters + lint ratchet | NAV-25 JRN-21 LED-22 SAL-19 BNK-21 TAX-17 PUR-23 | P2 |
| W6-02 | Report chrome (exports, pickers, widths, CSV comparatives) | RPT-23 RPT-24 RPT-25 RPT-27 RPT-30 LED-21 LED-26 | P2 |
| W6-03 | Design-system primitives, theme gaps | NAV-23 NAV-24 NAV-26 NAV-27 INV-05 SAL-13 JRN-13 | P1 |
| W6-04 | Mobile 390px pass | BNK-09 BNK-10 JRN-18 LED-20 PAY-16 PUR-27 SAL-16 SET-21 TAX-18 INV-09 PRC-23 RPT-29 | P1 |
| W6-05 | Banking polish | BNK-15 BNK-16 BNK-17 BNK-18 BNK-19 BNK-25 BNK-26 | P2 |
| W6-06 | Dashboard / chrome / public visual | JRN-14 JRN-20 JRN-22 JRN-26 JRN-27 JRN-28 | P1 (JRN-27 Hein: 14 vs 30-day trial) |
| W6-07 | Ledger polish (loan detail, user UUIDs, migration copy, periods list) | LED-15 LED-23 LED-28 LED-30 | P1 |
| W6-08 | Payroll polish | PAY-18 PAY-20 PAY-22 PAY-23 | P2 |
| W6-09 | Purchases/sales polish | PUR-24 PUR-25 PUR-26 PUR-30 SAL-20 SAL-21 SAL-22 SAL-23 SAL-25 SAL-26 | P2 |
| W6-10 | Practice polish (PRC-18 API half fixed by R-170 c7ea889b2; client-contacts + page open) | PRC-18 PRC-19 PRC-22 | P2 |
| W6-11 | Settings/admin polish | SET-17 SET-19 SET-20 SET-22 | P2 |
| W6-12 | Inventory empty states | INV-07 | P2 |

## 2. File-conflict matrix (waves 1–3; serialize in listed order)
| File(s) | WPs (merge order) |
|---|---|
| ~94 UI files incl. cashbook.tsx, reports/vat-return.tsx, waterfall.tsx, executive-dashboard.tsx, management-accounts.tsx, account-transactions.tsx, timesheets/index.tsx | W1-01 → W2-24, W2-10, W2-12, W2-02, W2-15 |
| pages/api/accounting/suppliers-list.ts | W1-07 → W1-08 → W3-06 |
| supplier-invoices/new.tsx | W1-07 → W2-21 → W3-07 |
| credit-notes/new.tsx | W1-07 → W3-09 |
| useBankRuleRefData.ts / bank-rules modal | W1-07 → W2-26 |
| purchase-orders/[poId].tsx | W1-07 → W2-20 |
| customer-invoices/index.tsx | W1-08 → W3-11 |
| customer-quotes/index.tsx | W1-06 → W3-10 |
| CaptureInboxPanel.tsx | W1-06 → W3-13 (and after R-169) |
| practice/wip/index.tsx | W1-04 → W3-04 |
| src/lib/apiRoutes.ts (append-only) | W1-02 → W1-03 → any later registration; also feat/ws4-board-pack |
| bankAccountStatusService.ts | W2-01 → W2-13 |
| bankTransactionQueryService.ts / bank-transactions.ts | W2-24 → W2-25 |
| monthEndWorkbenchService.ts | W2-14 → W2-08 (W2-08 also after K-050) |
| arAgingService.ts / shared/agingRewind.ts / aging pages | W2-23 (in R-074) → W2-09 → W2-08 (aging control row) → W3-18 |
| VAT201 components / sars/vat201.tsx | W2-15 → W2-16 → W2-17 → W3-15 |
| sarsComplianceService.ts | W2-16 → W2-17 |
| journal-entries/[entryId].tsx | W3-14 → W3-15 |
| Settings tabs / company-settings.tsx | W2-05 → W3-16 |
| AFS FY source | W2-05 → W2-29 |
| Item model (items/products) | W2-19 → W3-11 (item picker) |
| payroll runs/[id].tsx, runs/index.tsx | W3-01 → W3-02 |

## 3. Lane schedule, waves 1–3 (10 lanes; single merge queue)
Global merge order head: 1 W2-28 (hotfix, no conflicts) · 2 W1-01 · 3 W1-07 · 4 W1-04 · 5 W1-02 · 6 W1-06 · 7 W1-05 · 8 W1-08 · 9 W1-03; then first-ready lane heads, P0 before P1.
| Lane | Order |
|---|---|
| shell | W1-01 → W1-04 (after R-030) → W1-05 → W1-06 → W3-17 |
| settings | W2-28 → W1-03 → W1-02 → W2-05 → W3-16 → W3-19 |
| purchases (+inventory) | W1-07 → W2-21 → W2-22 → W2-20 → W2-23 (inside R-074) → W3-07 → W3-08 → W3-13 (after R-169) → W2-19 (after decision) → W3-21 (after R-035) |
| sales | W1-08 (after W1-07) → W2-09 (after decision + W2-23) → W3-06 → W3-09 → W3-10 (after W1-06) → W3-12 → W3-11 (after W2-19) |
| banking | W2-24 (after W1-01) → W2-01 → W2-25 → W2-13 → W2-26 (after W1-07) → W3-22 |
| reports | W2-10 → W2-11 → W2-12 → W2-02 → W2-03 → W2-29 (after W2-05) → W2-31 (after ws4 decision) → W3-18 |
| tax | W2-17 → W2-15 (after R-026) → W2-16 |
| ledger | W2-04 → W2-06 → W2-14 → W2-08 (after K-050) → W2-07 → W2-27 (inside K-175/K-176/R-062) → W3-14 → W3-15 (after W2-15) → W3-20 |
| payroll | W2-18 → W3-01 → W3-02 → W3-03 |
| practice | W2-30 → W3-04 (after W1-04) → W3-05 |

## 4. Not-a-bug / already-fixed / duplicate
| Finding | Judgement | Reason |
|---|---|---|
| JRN-29 | duplicate | same KPI strip as SAL-02 → W1-08 |
| SAL-12 | duplicate | same /accounting/ar 404 as NAV-15 → W1-04 |
| PAY-02 | duplicate | same redirect as NAV-02 (verify-c) → W1-04 |
| RPT-18 | duplicate | same selector as LED-06 → W2-12 |
| PUR-29 | duplicate | same empty document.title as JRN-17 → W4-D |
| RPT-21 | duplicate | same consolidation 500 as SET-12 → W3-19 |
| SET-23 | not-a-bug (env) | WhatsApp 500 = migrations 617/618 not applied on isaflow_dev (verify-b) |
| PRC-15 | not-a-bug (env) | isaflow_dev lacks 625b; finding says "not a production claim". Ops: apply 625b on dev |
Already fixed: none fully. PRC-18 half-fixed by R-170 (kept in W6-10).

## 5. Register overlaps & in-flight collisions
- In flight: R-169 (ai-invoice-pipeline.ts, captureRowLock.ts, supplierRulesService.ts) → W3-13 waits. R-171 (practiceNotificationService.ts) → no overlap. R-168/R-170 merged; W2-30 and W3-04 build on them.
- In progress: K-050 (arSubLedgerCheck.ts) blocks W2-08; R-026 (vatBoxBasisQuery.ts) blocks W2-15; R-030 (invitations/[token]) same flow as W1-04 accept-invite; R-027/K-113/K-242 (year-end) coordinate W3-20; R-035 blocks W3-21.
- Fold into register items: PUR-04 → R-074 (+R-011/K-130/K-131); LED-13/14 → K-175/K-176/R-062; PRC-11/12 → R-102/R-072 (+R-078/R-106 status semantics).
- Coordinate: W2-16 with R-061/R-063; W2-18 with R-005/K-163/K-249/R-018; W2-19 with K-180..K-185/K-264/K-265; W2-07 with R-023/R-024/K-186/K-179; W2-09 with R-099/R-083/K-129; W2-13 with K-193; W2-20 with K-255; W2-22 with R-060; W2-25 with R-111/R-087/K-153; W2-26 with K-141/K-150/R-039; W3-05 with R-103/R-104/K-229; W3-09 with R-016/R-019/K-056; W3-12 with K-116/K-117; W3-14 with K-237/K-196; W3-22 with K-142; W2-29 with K-187..K-191/R-007.
- Server-side date twin: K-235 (recurringJournalService toISOString) — not in W1-01's UI scope.
- Stale register item: R-040 names pages/accounting/suppliers.tsx, which no longer exists.
- Branch risk: feat/ws4-board-pack (645 files, idle since 2026-09-08) touches src/lib/apiRoutes.ts, src/lib/format/money.ts, packs → W2-31, W5-10, W6-01.

## 6. Coverage check (computed)
Non-IDEA findings 307 · placed in WPs 299 · in section 4 8 · total 307 · duplicates 0 · missing 0 · unknown ids 0.
WPs: wave 1 = 8, wave 2 = 31, wave 3 = 22, wave 4 = 5, wave 5 = 13, wave 6 = 12 (91). P0 after verify corrections: 33 (from 53).
