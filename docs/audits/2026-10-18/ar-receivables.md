# ar-receivables — audit 2026-10-18

Code root: IsaFlow-audit-20261018 @ 6ee5e9108 (origin/master). Read-only. No prod access, no DB writes; a few read-only SELECTs on isaflow_dev, each noted where used.

Method: four parallel sub-audits (A invoices/quotes/recurring, B receipts/allocations/gateway, C credit notes/write-offs/disputes/contra, D aging/statements/dunning/subledger). The coordinator re-read the source for every HIGH finding (A1, B1, B2, C1, C2, D1). It also checked that no migration under scripts/migrations/sql caps `amount_paid <= total_amount`. That means the over-allocation paths in B1, B2 and C1 really store over-payments and do not fail on a constraint.

## Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 6 (A1, B1, B2, C1, C2, D1) |
| MEDIUM | 16 |
| LOW | 27 |

Top HIGH:
- **A1** `services/ar/recurringInvoiceRun.ts:186` `advanceDate` uses `setMonth(+1)`: a monthly template on the 29th–31st skips a whole month, e.g. 31 Jan → 3 Mar with no February invoice (K-119, worse than listed).
- **B1** `services/ar/customerPaymentAllocationService.ts:101` confirm adds draft allocations with no re-check against the current balance → amount_paid 2× total, AR credited twice (K-116 widened).
- **B2** `services/ar/customerPaymentService.ts:117` balance check reads with no lock → concurrent receipts or `settle_by_contra` over-apply (NEW).
- **C1** `services/ar/writeOffService.ts:119-205` approval neither re-validates the balance nor takes a lock → write-off after payment double-credits AR and claims §22(3) VAT relief on collected money (K-055).
- **C2** `services/ar/writeOffService.ts:81` write-off accepted on draft/pending/cancelled/deleted invoices → credits AR that was never debited (NEW).
- **D1** statements and customer ledger never read `customer_write_offs` → written-off debt still shows as owing on the emailed statement (NEW).

Counts are taken from the sub-reports below. Finding ids are prefixed by sub-area.

---

## Part A: customers, quote → SO → invoice, invoice create/edit/approve/post/cancel, recurring invoices

Code root: /home/hein/Workspace/IsaFlow-audit-20261018 @ 6ee5e9108. Read-only. Dev DB used only for read-only SELECTs (counts / constraints), noted per finding.

### Findings

| # | Sev | Status | File:line | Trigger → wrong outcome | Why |
|---|-----|--------|-----------|-------------------------|-----|
| A1 | HIGH | KNOWN-STILL-OPEN (K-119, worse than listed) | src/modules/accounting/services/ar/recurringInvoiceRun.ts:186-195 (`advanceDate`) | A monthly template whose next run is 29, 30 or 31 Jan. Run it → `next_run_date` becomes 1–3 March, so **February is never invoiced**, and from then on the template runs on the 3rd. Reproduced in node under both TZ=Africa/Johannesburg and UTC: 2026-01-31 → 2026-03-03 → 2026-04-03 …; 2026-01-29 → 2026-03-01. Quarterly and annual templates do the same (31 Aug + 3 months → 1 Dec, skipping November; 29 Feb + 1 year → 1 Mar). | `Date.setMonth(+1)` on day 31 overflows into the next month. The month is lost, not just shifted, so revenue for that period is missing. K-119 describes it as "drift". It is a skipped billing period. |
| A2 | MEDIUM | NEW | pages/api/accounting/recurring-invoices.ts:62-63,78-80 + pages/accounting/recurring-invoices/[id].tsx:130-142 | The edit page shows a VAT-rate control (`onTaxRateChange`), but its PUT payload has no `taxRate`. The route then computes `tax_amount` at `req.body.taxRate ?? 15` and never writes `tax_rate`. (a) Template at 0% (zero-rated or export customer), operator edits any line → `tax_amount` stored at 15% while `tax_rate` stays 0. Every later run fails `assertAggregateAgrees` ("tax disagrees, re-save"), and re-saving repeats the fault, so the template is stuck. (b) Operator changes 15% to 0% → silently ignored, and every invoice keeps charging 15% VAT. | The UI drops the field, and the route uses one rate for the aggregate while the run reads another column. |
| A3 | MEDIUM | NEW | src/modules/accounting/services/ar/recurringInvoiceRun.ts:146-155; pages/accounting/recurring-invoices/new.tsx:94, [id].tsx:140 | The recurring create/edit forms capture a revenue account per line (`glAccountId`), which is stored in `line_items` JSON. The run inserts invoice items without `gl_account_id`, so every recurring invoice credits `default_revenue`. | The coding the operator chose is silently discarded, so revenue lands on the wrong account. Contrast `recurringTransactionInvoices.ts:93`, which does carry it. |
| A4 | MEDIUM | NEW | src/modules/accounting/services/ar/quoteConvertService.ts:131-137; salesOrderWorkflowService.ts:120-127 | Quote with lines coded to revenue account X → "convert to order" → "invoice". Neither the SO item insert nor the SO→invoice item insert writes `gl_account_id` (the column exists on `customer_sales_order_items`). The invoice posts all revenue to `default_revenue`. The direct quote→invoice path keeps the account (quoteConvertService.ts:225), so the same quote posts differently depending on the route taken. | Line coding is lost through the sales-order path. |
| A5 | MEDIUM | NEW | src/modules/accounting/services/ar/customerInvoiceGlPosting.ts:297-313,432-435 + pages/api/accounting/customer-invoices-gl.ts:30 | POST /customer-invoices-gl (Post to GL) for an in-population invoice with `gl_journal_entry_id IS NULL`, sent twice concurrently (double click, retry, or two tabs). Each request reads the row unlocked, sees no journal, creates and posts a full AR/Revenue/VAT journal, and then overwrites the link without any `IS NULL` predicate. Result: AR, revenue and output VAT are doubled, and the first journal is orphaned where cancel (which reverses only the linked id) can never reach it. Reachable: dev has 638 approved/sent/paid/partially_paid/overdue invoices with no journal (read-only count). No unique index on `gl_journal_entries` prevents it (checked pg_indexes). | No row lock or compare-and-set on the link. The AP twin was locked for exactly this (K-014). The "AR twin has always been immune" comment in supplierInvoiceWorkflowService.ts:94 covers only the sequential case. |
| A6 | MEDIUM | NEW | src/modules/accounting/services/core/customerWriteService.ts:157,182; src/components/accounting/CustomerForm.tsx:191-195 | The customer form offers "Opening balance" and its date. `createCustomer` stores `customers.opening_balance`, and nothing reads it: there is no GL posting, no AR document, and it is absent from aging, statements, the ledger and the debtors manager (grep for readers finds none outside payroll/bank/GL). A new debtor entered with R5,000 opening balance shows R0 owing everywhere. | The input is accepted and silently has no effect on any money figure. The service's own comment says to correct it "with a journal", which assumes the stored figure was ever used. |
| A7 | MEDIUM | NEW | src/modules/accounting/services/ar/quoteConvertService.ts:206-216; salesOrderWorkflowService.ts:100-112 | Convert a quote dated 3 months ago → the draft invoice gets `invoice_date = quote_date` and `due_date = quote expiry`. An SO → `invoice_date = order_date`, `due_date = delivery_date or order_date`. On approval the output VAT posts at the old tax point (into an earlier VAT period, if it is not locked). The invoice is born already overdue, so dunning and aging pick it up immediately. Header `tax_rate` is also left at the column default 15 whatever the line rates, so the first save on the edit page (which always resends items at the header rate) re-prices a zero-rated or mixed-rate converted invoice at 15%. | Conversion copies dates and VAT from the source document. Nothing derives the invoice date from today or the due date from customer terms, and the header rate is not taken from the lines. |
| A8 | LOW | NEW | pages/api/accounting/customer-invoices-detail.ts:205-213 | `send` action: `snapshotInvoicePdf` runs SQL without a savepoint (approve wraps the same call in `withSavepoint`, with a comment explaining why). If the snapshot's SQL fails, the catch swallows it and the handler answers 200 `status: 'sent'`. withAuth then COMMITs an aborted transaction, which Postgres executes as ROLLBACK without raising. The client is told "sent" but the status write is lost. | Missing savepoint (customerInvoiceApprovalService.ts:233-245 documents the hazard). |
| A9 | LOW | KNOWN-STILL-OPEN (K-251) | src/modules/accounting/services/ar/salesOrderService.ts:95-107, quoteConvertService.ts:104-113, deliveryNoteService.ts:95-99 | First sales order or delivery note for a company: the INSERT seeds `next_number = 1` and `RETURNING next_number - 1` → `SO-00000` / DN-00000. | Off-by-one on the seed row. |
| A10 | LOW | NEW (K-250 analogue) | pages/api/accounting/time-entries-invoice.ts:85-93 vs 124-140 | Header `subtotal = round(Σ unrounded hours×rate)`, while each line stores `round(hours×rate)`. With several fractional entries the header and its lines differ by cents (inside the 1c-per-line approval tolerance, so the invoice posts while its lines do not foot). Uses float `Math.round(x*100)/100`. | K-250 was fixed in customerInvoiceCreateService (invoiceLineAmount.ts) but not in this sibling writer. |
| A11 | LOW | NEW | src/modules/accounting/services/ar/quoteService.ts:133-143,219,253; salesOrderService.ts:115-131 | Quote/SO totals use float `Math.round(x*100)/100` on unrounded `quantity × unitPrice`, and the price is stored unrounded on the quote/SO but `numeric(15,2)` on the invoice. A quote line of 3 × 0.335 converts to an invoice line printed 3 × R0.34 = R1.01 (should be R1.02), and the edit page reads it back as a 0.98% "discount". | Quotes and SOs still use their own float pricing instead of `invoiceLineAmount`. |
| A12 | LOW | NEW | src/modules/accounting/services/ar/customerInvoiceCancelService.ts:164-168 | Cancelling an invoice minted from time entries, a sales order or a quote releases none of its sources: entries keep `invoiced = true`, the SO stays `invoiced`, and the quote stays `converted`. None can be invoiced again, so the work is unbillable without hand edits. | Cancel undoes the GL only. |
| A13 | LOW | NEW | src/modules/accounting/services/ar/recurringInvoiceRun.ts:136; customerInvoiceCreateService.ts:361 | Recurring invoices are always due at +30 days, ignoring the template's `payment_terms` and the customer's terms. The create service leaves `due_date` NULL when none is sent (MCP/API), and the list then buckets the invoice as "Current" forever (customerInvoiceReadService.ts:131). Dev: 2 issued invoices with a NULL due date. | Customer payment terms are not applied anywhere on the AR write paths audited. |
| A14 | LOW | NEW | pages/api/accounting/recurring-invoices.ts:52-58,84 | PUT accepts a line with no `quantity` (`quantity ?? 1 > 0`), but the run's `parseLineItems` refuses it (NaN), so the template fails every run. PUT on a completed or cancelled template matches 0 rows and still answers `{updated:true}`. | The route's validation and the run's validation disagree, and the route ignores the row count. |
| A15 | LOW | NEW | src/modules/accounting/services/ar/customerInvoiceDraftEdit.ts:266 + src/lib/schemas/customerInvoiceDetail.ts:17 | The PUT schema accepts a per-line `taxRate`, which is stored on the line, but header VAT is always `invoiceTotals(lines, headerRate)`. An API/MCP caller sending a 0% line under a 15% header gets VAT charged on the zero-rated line, and the PDF prints the residual as "unattributed". The UI always sends the header rate. | Line rate is stored but not priced. |
| A16 | LOW | NEW | src/modules/accounting/services/ar/customerInvoiceReadService.ts:68-77,117-131 | The `overdue-90` and `due-soon` list filters, `days_overdue` and `aging_bucket` exclude only `status='paid'`, so cancelled and draft invoices appear as 90+ overdue in the invoice list filter. | The status predicate is not `documentInPopulation`. |
| A17 | LOW | NEW | src/modules/accounting/services/ar/deliveryNoteService.ts:199-235,242-258 | `sales_order_id`, `invoice_id` and `item_id` on create are not checked against the company (FK only), so a note can reference another tenant's SO or invoice id (stored, not read back, so no leak observed). Status changes are unguarded (cancelled → delivered). | Missing ownership and transition guards. |

### PLAUSIBLE (not proven)

- P1. `postCustomerInvoiceToGL` via Post to GL: if `postJournalEntry` throws after `createJournalEntry` for a reason other than the pre-checked closed or VAT-locked period (e.g. an unbalanced legacy header where total ≠ subtotal + tax, or an inactive account), the route answers 400 and withAuth COMMITs the draft journal row. A draft journal does not hit the TB, but it is an orphan. (customer-invoices-gl.ts:33-37)
- P2. Recurring templates that are months behind: each Run mints one invoice dated CURRENT_DATE, and `next_run_date` is still ≤ today, so catching up mints several invoices all dated today for different periods. That may be intended, but the period being billed is not recorded on the invoice.
- P3. `updateRecurringStatus` lets a `cancelled` or `completed` template be resumed to `active` (recurring-invoices-action.ts 'resume'), restarting billing on a template the operator ended. Business rule unclear.
- P4. `quote 'accept'` is allowed from `declined` / `expired` (updateQuoteStatus only blocks converted states). Business rule unclear.

### Prior K-items in this area: re-verified

| K | Verdict | Evidence |
|---|---------|----------|
| K-013 | FIXED | recurringInvoiceRun.ts inserts lines and approves through approveCustomerInvoice (posts GL) |
| K-060 | FIXED | quoteService.ts:101-106 uses company `quotation` sequence + unique index |
| K-107 | FIXED | recurringTransactionInvoices.ts:64 uses `insertWithReservedNumber` |
| K-044 | FIXED | recurringTransactionInvoices.ts:122-124 approves through canonical path |
| K-119 | STILL OPEN → A1 (and it skips a month, not just drift) |
| K-120 | FIXED | recurring and SO→invoice both use `customer_invoice` sequence; SO uses `sales_order` sequence |
| K-121 | FIXED | quoteConvertService.ts:38,83-90 allow-list + CAS claim |
| K-126 | FIXED | invoicePdfBuilder.ts:145-175 uses line tax_rate + allocateVatToLines |
| K-232 | FIXED | runRecurringInvoice wraps each template in a savepoint; route asserts tx usable |
| K-233 | FIXED | salesOrderEditService.ts:36-48 checks claimed row count |
| K-250 | FIXED in customerInvoiceCreateService (invoiceLineAmount); analogue survives in time-entries-invoice → A10 |
| K-251 | STILL OPEN → A9 |

### Covered

- invoiceLineAmount.ts, vatLineAllocation.ts, customerInvoiceCreateService.ts, customer-invoices-create.ts
- customerInvoiceDraftEdit.ts, schemas/customerInvoiceDetail.ts, customer-invoices-detail.ts (PUT/approve/send/cancel)
- customerInvoiceApprovalService.ts, customerInvoiceGlPosting.ts, invoiceRevenuePosting.ts, invoiceRevenueLines.ts (invoice side; CN allocation read only), customer-invoices-gl.ts
- customerInvoiceCancelService.ts, customerInvoiceLock.ts, softDeleteInvoiceGuards.ts, invoiceStatusRecompute.ts
- quoteService.ts, quoteConvertService.ts, customer-quotes-action.ts
- salesOrderService.ts, salesOrderEditService.ts, salesOrderWorkflowService.ts, customer-sales-orders-action.ts, deliveryNoteService.ts
- recurringInvoiceRun/Service/Lock/Template.ts, recurring-invoices.ts, recurring-invoices-run.ts, recurring-invoices-action.ts, recurring-invoices edit/new pages (payload only)
- core/recurringTransactionInvoices.ts (AR half), time-entries-invoice.ts
- customers.ts, customerWriteService.ts (create), customers-bulk.ts (scan), customerMergeService.ts (scan), customerInvoiceReadService.ts list
- withTransaction / withAuth commit semantics (to judge A8)

### NOT covered (Part A)

- invoiceLineCodingGuard.ts, dimension derivation/policy internals (only call sites)
- approvalGate / approval_document_digest SQL (R-035) beyond the gate-amount function
- invoicePdfBuilder / snapshot internals beyond the K-126 check
- sageMigrationCommitService, migrationImportService, practiceWipService invoice writers
- MCP tool wrappers (writeInvoices, writeBulkCustomerInvoices, writeBulkFinalizeInvoices): only confirmed that they call the same services
- customerMergeService correctness in depth; customer update path
- No unit tests were run; A1 was reproduced with a standalone node snippet of the exact `advanceDate` body

---

## Part B: AR receipts, allocations, portal / gateway payments

Code: detached worktree at 6ee5e9108. Evidence comes from reading the code only. No DB queries and no tests were run.

### Findings

| # | Sev | Status | File:line | Trigger → wrong output | Why |
|---|---|---|---|---|---|
| B1 | HIGH | KNOWN-STILL-OPEN (K-116, widened) | src/modules/accounting/services/ar/customerPaymentAllocationService.ts:101-117 (confirm loop); src/modules/accounting/services/ar/receiptAllocationLines.ts:257-264 (outstanding ignores drafts); src/modules/accounting/services/ar/openCustomerInvoices.ts:189-196 | 1) Create a draft receipt D for R1,000 against INV-1 (balance R1,000). 2) Apply other cash to INV-1 through any path that ignores draft allocations: bank-line receipt match (`confirmReceiptMatch`), apply of an unapplied receipt (`customer-allocations` / MCP `apply_receipt_to_invoice`), FIFO auto-apply or `auto_apply_unapplied`. INV-1 is now paid. 3) Confirm D. INV-1 `amount_paid` = R2,000 and status = 'paid'. The GL credits AR twice for one R1,000 debit. Aging (total − amount_paid, filtered >0) drops the invoice, so the R1,000 customer credit shows up nowhere in the subledger while the AR control carries it. | `confirmCustomerPayment` adds each stored draft allocation with `amount_paid + x` and re-checks nothing: no invoice lock, no outstanding check. `createCustomerPayment` counts other drafts' pending amounts, but every other applier computes outstanding as `total − amount_paid` and never sees drafts. No CHECK or trigger caps `amount_paid` at `total_amount`. |
| B2 | HIGH | NEW | src/modules/accounting/services/ar/customerPaymentService.ts:117-141 | Two concurrent `POST /customer-payments` (or two `settle_by_contra` calls, src/lib/mcp/tools/writeSettleByContra.ts:227-243) for the same invoice: both read pending = 0 and both pass the balance check. Both are created, and confirming both over-applies the invoice as in B1. `settle_by_contra` confirms straight away, so two concurrent contras for the full balance each post DR contra / CR AR and drive `amount_paid` to 2× total. | The check-then-insert reads `customer_invoices` and pending drafts without `FOR UPDATE`. `loadContraDocument` (src/modules/accounting/services/core/contraSettlementService.ts:219-261) is also an unlocked read. Confirm (B1) never re-validates. |
| B3 | MEDIUM | NEW | src/modules/accounting/services/ar/customerPaymentService.ts:117-123 + customerPaymentAllocationService.ts:103-116 | `POST /api/accounting/customer-payments` with an allocation to a **draft** invoice, then `customer-payments-action confirm`, with approval enforcement off (the default). The draft invoice goes to status 'paid'. It never passes `approveCustomerInvoice`, because 'paid' is not approvable, so its revenue, output VAT and AR debit are never posted. The GL holds CR AR with no DR. The same request can name a **cancelled** invoice (status → 'paid') or an invoice of **another customer** in the same company. The receipt's `client_id` and the invoice's owner are never compared. | `createCustomerPayment` checks only that the invoice exists and is payable in a settleable currency. It has no status, owner or `deleted_at` guard. The CASE in confirm sets 'paid'/'partially_paid' with no `status = ANY(BALANCE_DERIVED)` guard, unlike `recomputeInvoiceStatus`, and also overwrites 'disputed'. Migration 865's own header notes that confirm moves a DRAFT invoice into the AR population. It is backstopped only when enforcement is on. The UI form filters to approved/sent/partially_paid/overdue, so the path is reachable through the API (any write-access user) or with a stale form. |
| B4 | MEDIUM | NEW | src/modules/accounting/services/ar/customerPaymentAllocationService.ts:78-80 (with customer-payments.ts:31 accepting any `bankAccountId`) | `POST /customer-payments` with `bankAccountId` = the AR control account (or any revenue or expense account), then confirm. With AR control the result is DR AR / CR AR: the invoice is marked paid and the control account does not move, so subledger and GL diverge by the full amount. With an expense or revenue account, the confirm becomes an unapproved write-off with no VAT adjustment and no write-off approval. | Confirm checks only that the account belongs to the company. It has no bank-subtype check, no "is not AR control" check and no leaf/active check. Compare `assertContraAccountUsable`, which carries all of these for the contra path. |
| B5 | LOW | NEW | src/modules/accounting/services/ar/receiptAllocationLines.ts:192-210, 238-243; customerPaymentService.ts:118-121 | Applying a receipt (or creating a draft receipt) against a **soft-deleted** invoice is accepted, so cash lands on a document that the aging, statement and portal no longer show. A receipt can also be applied to a `pending_approval` invoice: `amount_paid` moves but status stays put (recompute skips non-balance-derived statuses), and approval later sets 'approved' on a fully paid invoice. | `fetchInvoiceCandidates` selects no `deleted_at`. `UNALLOCATABLE_INVOICE_STATUSES` lists only draft/cancelled, while the FIFO path (`openCustomerInvoices`) filters `deleted_at IS NULL` and BALANCE_DERIVED, so the explicit and FIFO paths disagree. |
| B6 | LOW | NEW | src/modules/accounting/services/ar/customerPaymentAllocationService.ts:175-185 | Cancelling a receipt on an invoice that was 'sent', 'overdue' or 'disputed' resets it to 'approved' (balance back to full) or 'partially_paid'. Dunning, overdue state and the dispute flag are lost. | The inline CASE hard-codes 'approved' and has no status guard. `recomputeInvoiceStatus` documents exactly this defect ("cancel recomputed but hard-coded 'approved' … discarding 'sent', 'overdue'") and is not used here. |
| B7 | LOW | NEW | src/modules/accounting/services/ar/receiptApplicationService.ts:136 + customerPaymentAllocationService.ts:163 | A receipt fully applied through `customer-allocations` becomes 'reconciled'. The HTTP cancel then refuses it ("Cannot cancel payment with status: reconciled"). The only remaining undo is the MCP `void_receipt` or a bank-line reversal. | The code comment acknowledges the asymmetry. It is a functional gap, not wrong money. |
| B8 | LOW | NEW (documented known limit) | src/modules/accounting/services/ar/gatewayFeeService.ts (header "Known limit") | Paystack fees, which carry 15% VAT in SA, are booked gross to `admin_expense`. Input VAT on every gateway fee is never claimed. | Self-documented. Listed here so the money effect is on record. |

### K-items checked

| K-id | Result |
|---|---|
| K-036 (Paystack payments never reach GL) | FIXED. `recordGatewayInvoiceReceipt` creates the payment, allocation and confirm journal. Unique index 620 on (company_id, bank_reference) for card payments. |
| K-054 (confirm takes no lock) | FIXED. `lockCustomerPaymentForUpdate` plus a status re-check under the lock (customerPaymentAllocationService.ts:69-74). Invoice-side staleness remains: B1. |
| K-101 (portal routes use default company) | FIXED. generate.ts and payment-link.ts use `req.companyId`. |
| K-102 (portal queries missing columns) | FIXED as far as the code shows (portalService uses COALESCE(client_id, customer_id) and the shared population/presence helpers). Not run against the schema. |
| K-116 (application ignores draft allocations) | STILL OPEN, see B1. |
| K-117 (unapplied counts draft payments) | Code still filters only `status <> 'cancelled'` (shared/unappliedPaymentBasis.ts:137). Every draft writer requires allocations equal to the total, so the unapplied amount is 0 and there is no money effect found. Not re-listed. |
| K-118 (noJournal bucket swallows pre-stamp receipts) | Effectively fixed. Migration 530 backfilled `posting_agent` on every NULL journal ('legacy:*'). |
| K-201 (one-second duplicate window) | FIXED. verify.ts was rewritten and delegates to the idempotent `recordGatewayInvoiceReceipt` under `FOR UPDATE` plus the unique index. |
| K-211 (payment-link clientId unchecked) | FIXED (payment-link.ts:118-120, 131). |
| K-248 (R0.00 link on settled invoice) | FIXED. `resolveLinkCharge` refuses `nothing_owed`, and payment-link POST refuses over-balance or no balance. |
| K-276 (portal mint lacks CSRF) | FIXED (`withCsrf` on generate.ts and payment-link POST). |
| K-035 (webhook failure discarded on retry) | FIXED. Processing and `processed=true` run inside one tx, and a failure leaves `processed=false`. |

### PLAUSIBLE (unverified)

- `recordGatewayInvoiceReceipt` with a non-ZAR reported currency still banks the receipt with `total_amount = cents/100` and confirms it, so the journal posts DR Bank / CR AR at the foreign face value as rand. It is flagged `currency_mismatch` for review, but the journal stands (gatewayInvoiceReceiptService.ts:102-103, 189-222). Portal checkouts are created in 'ZAR', so this is reachable only if Paystack settles in another currency.
- `fetchOpenCustomerInvoices` (openCustomerInvoices.ts:214-217) does `SET LOCAL lock_timeout = DEFAULT` after its read instead of restoring the caller's budget, as `lockCustomerPaymentForUpdate` does via `restoreLockTimeout`. That can silently lift an outer `underFlowLockBudget` for the rest of the request.
- Two payment links (a fixed one plus a standing `charges_balance` one) for the same invoice can both be paid in full. The second is banked as unapplied and flagged `overpaid_unapplied` (gatewayReceiptAllocation.ts:78-79). No over-application, but the customer is double-charged until refunded.
- `getCustomerOnAccountCredit` (customerRefundDocument.ts:56-77) measures refundable credit from unapplied receipts only. It ignores the customer's open invoices: a customer with R1,000 unapplied and R1,000 overdue can be refunded R1,000. It also ignores unapplied credit notes.

### Covered

customerPaymentService, customerPaymentAllocationService (confirm/cancel), receiptAllocationLines, receiptApplicationService, invoiceStatusRecompute, customerAutoAllocate, openCustomerInvoices, unappliedReceiptService, unappliedReceiptOrigin, shared/unappliedPaymentBasis (AR arm), customerBankReceipt, customerRefundDocument, receiptMatchConfirmService, receiptMatchService (candidate query only), invoicesPayable, core/paymentVoidService + paymentVoidReads (void_receipt), core/contraSettlementService + MCP settle_by_contra, MCP void_receipt, autoApplyBackfillService/applyOnePayment (auto_apply_unapplied), routes customer-payments.ts, customer-payments-action.ts, customer-allocations.ts, customer-*-export.ts (tenant scope). Gateway: gatewayInvoiceReceiptService, gatewayReceiptAllocation, gatewaySettledReceipt, gatewaySettlementReview (settledCharge/merchantFee), gatewayFeeService (header), portalLinkCharge, portalService, pages/api/portal/payment-link.ts, invoice/generate.ts, payments/paystack/verify.ts, pages/api/webhooks/paystack.ts. Also checked migration 620 (card reference unique) and 865 (approval backstop).

### Not covered

bank/bankAllocationService and bankAllocationUnwind internals (bank area), confirmCustomerMatch beyond its header, paystackEventHandlers beyond the receipt call sites, portal/payments/paystack/create.ts, standingPaymentLink.ts, portalTokenService.ts, portalChatbotService, readReceiptService, receiptRefusal/receiptBankLeg (small helpers, skimmed), MCP writeApplyReceipt.ts body (it delegates to plan/applyReceiptPlan, which were reviewed), and any Stitch webhook (none found under pages/api/webhooks). No runtime reproduction was done.

---

## Part C: credit notes, write-offs, disputes, contra, invoice-cancel interplay

Code root: /home/hein/Workspace/IsaFlow-audit-20261018 (origin/master 6ee5e9108). Read-only. No DB queries and no tests were run, so every finding below comes from reading the code.

### Findings

| # | Sev | File:line | Trigger → wrong outcome | Why | Status |
|---|-----|-----------|-------------------------|-----|--------|
| C1 | HIGH | src/modules/accounting/services/ar/writeOffService.ts:119-205 | Raise a draft write-off for the full R1,000 balance. The customer then pays R1,000 (or a second draft write-off is approved, or the invoice is cancelled). Approve the first draft. Result: AR is credited again, `amount_paid` becomes 2,000 on a 1,000 invoice, and bad-debt expense and §22(3) VAT relief are booked on money already collected. | Approval re-reads neither the invoice balance nor its status, and takes no invoice row lock. The status-predicated claim (L136) only stops the *same* write-off being approved twice. The increment at L200-205 has no `amount_paid + amount <= total_amount` predicate. | KNOWN-STILL-OPEN (K-055) |
| C2 | HIGH | src/modules/accounting/services/ar/writeOffService.ts:81-89 | `POST /api/accounting/write-offs` against a **draft**, **pending_approval**, **cancelled** or **soft-deleted** invoice, then approve it. Result: DR bad debt / DR VAT output / CR AR for a document that never debited AR, or whose journal was already reversed. The AR control account goes below the subledger and VAT output relief is claimed on VAT never declared. | `createWriteOff` reads the invoice with no status filter and no `deleted_at IS NULL`, and checks only `amount <= total - amount_paid`. That balance is the full total on an unposted draft. | NEW |
| C3 | MEDIUM | src/modules/accounting/services/ar/writeOffService.ts:79-99 | A write-off with `clientId` = customer A and `invoiceId` = customer B's invoice is accepted. Write-off lists and per-customer reports then attribute B's bad debt to A. | `assertCustomerInCompany` checks only the tenant. Nothing compares `COALESCE(ci.client_id, ci.customer_id)` with `input.clientId`. The credit-note path does this check in creditNoteLinkService:103. | NEW |
| C4 | MEDIUM | src/modules/accounting/services/ar/writeOffService.ts:178-185 + src/modules/accounting/services/reports/vat201ReportService.ts:45-58,148-150 | Approve any write-off on a VAT-bearing invoice. The §22(3) relief is posted as a DEBIT on the `vat_output` account with `vatType: 'bad_debt'`. `classifyVatJournalLine` turns that into `output:bad_debt`, which has no entry in BOX_NUMBERS, so it lands in box `'unclassified'` ("Unmapped VAT type"). Box 17 (Bad debts, keyed `input:bad_debt`) is never populated. | The direction comes from the account subtype (vat_output → output), but the only bad-debt box key is `input:bad_debt`. The legacy vatReturnService box 17 needs accountType 'asset', so it misses the line too. Net VAT is probably still right; the box allocation on the return is not. | NEW |
| C5 | MEDIUM | src/modules/accounting/services/ar/creditNoteService.ts:150-154; pages/accounting/credit-notes/new.tsx:34; pages/api/accounting/credit-notes.ts:79 | Raise a credit note linked to a zero-rated or exempt invoice through the UI, which defaults the rate to 15. Approval debits VAT output for 15% that was never charged, so the VAT201 under-declares output tax. The same path lets a linked note reverse more VAT than the invoice carried. | Neither create nor approve derives the rate from the linked invoice or caps the note's VAT at the invoice's remaining VAT. Revenue legs are capped per invoice leg (invoiceRevenuePosting.ts:77-136); the VAT leg (creditNoteApproveService.ts:119-124) is not. | NEW |
| C6 | MEDIUM | src/modules/accounting/services/ar/creditNoteCancelService.ts:216-224 | REST `credit-notes-action` `apply` with the id of a soft-deleted customer invoice that still has status approved or sent. Soft-delete does not change status (softDeleteRowOps.ts:54) and has already reversed the invoice's journal. The note's credit is consumed against a document the ledger no longer carries, so the AR subledger moves while GL AR does not. | The `SELECT ... FOR UPDATE` has no `deleted_at IS NULL`. Every sibling has it: lockInvoicesForUpdate (creditNoteApplicationWrites.ts:103), the MCP planner (creditNoteDocumentApply.ts:288) and the cancel service. | NEW |
| C7 | MEDIUM | src/modules/accounting/services/core/contraSettlementService.ts:219-226,204 | `settle_by_contra` (ar) on a soft-deleted invoice, or on a `pending_approval` invoice. The tool posts DR contra / CR AR for a document whose AR debit is reversed (deleted) or not yet posted (pending). The deleted case leaves AR control permanently below the subledger. | `loadContraDocument` has no `deleted_at` filter, and UNSETTLEABLE is only {cancelled, draft}. The downstream receipt allocation (receiptAllocationLines.ts:192-209, `UNALLOCATABLE_INVOICE_STATUSES` = {cancelled, draft}) does not filter deleted or pending_approval either. That half overlaps the receipts area. | NEW |
| C8 | LOW | src/modules/accounting/services/ar/writeOffService.ts:200-205 | A partial write-off leaves status `sent`, `approved` or `overdue` rather than `partially_paid`. A write-off that clears the balance sets `status='paid'` but leaves `paid_at` NULL. | The write-off writes status by hand instead of calling `recomputeInvoiceStatus`. That helper's header says `paid_at` is what aging and statements use to date a settlement, so point-in-time readers cannot date write-off settlements. | NEW |
| C9 | LOW | src/modules/accounting/services/ar/creditNoteService.ts:33-78 | `GET /api/accounting/credit-notes?status=draft` returns every status. | `filters.status` is accepted and passed by the route (credit-notes.ts:44) but no query uses it. | NEW |
| C10 | LOW | src/modules/accounting/services/ar/creditNoteService.ts:150-154,174 | A subtotal with more than 2 decimal places (REST or MCP; neither rejects it). Example: subtotal 0.125 at 15% stores subtotal 0.13 (NUMERIC(15,2)) and tax 0.02, while JS computes the total as 0.14. Approval builds DR 0.13 + 0.02 / CR 0.14 and the journal fails to balance, so the note can never be approved. | Tax and total are computed from the unrounded subtotal, which Postgres then rounds on insert. The settle_by_contra tool already refuses non-cent amounts (`hasWholeCents`). | NEW |
| C11 | LOW | src/lib/mcp/tools/writeCreditNotesCreate.ts:149-150 vs creditNoteService.ts:151-154 | The dedupe total is `round(subtotal*(1+r))`; the stored total is `subtotal + round(subtotal*r)`. These can differ by a cent at half-cent boundaries (e.g. 0.10 at 15% gives 0.11 vs 0.12), so the duplicate-draft guard misses a true retry and a second draft is created. | The service and the tool use two different rounding formulas. | NEW |
| C12 | LOW | src/modules/accounting/services/ar/disputeResolution.ts:211-245 | `withdrawDispute` racing `resolveDispute`. Withdraw reads 'open', resolve claims and creates a credit note, then withdraw's UPDATE (on id only) overwrites the status to 'withdrawn'. The dispute shows withdrawn while its credit note exists. | Read-then-update with no `AND status = 'open'` predicate. Resolve was fixed with a claim; withdraw was not. | NEW |
| C13 | LOW | src/modules/accounting/services/ar/creditNoteCancelService.ts:236-264 | REST apply of a note to an invoice it is already allocated to. The allocation INSERT raises 23505, the route's catch-all returns it as a raw 400 (constraint text), and the aborted transaction rolls back. The denylist also lets a `disputed` invoice take credit, which the MCP path's allowlist refuses. | No `prior allocation` pre-check (the MCP twin has one at creditNoteDocumentApply.ts:233-242). It uses the UNAPPLICABLE denylist rather than FIFO_ELIGIBLE_STATUSES. | NEW |

### Prior K-items in this sub-area

- K-011 (credit-note apply writes an absolute amount_paid from a stale read): **FIXED.** creditNoteCancelService.ts:216-269 locks the note, then the invoice FOR UPDATE, and increments relatively.
- K-032 (cancelled credit note gives spurious VAT201 amounts): **FIXED.** vatBoxBasisQuery.ts:89-120 hides the original and its reversal as a pair.
- K-055 (write-offs never re-validated at approval): **STILL OPEN** (C1).
- K-056 (dispute credit at zero VAT): **FIXED.** disputeResolution.ts:112-139 splits the gross at the invoice's rate.
- K-057 (credit-note PDF missing column): **FIXED** (3e1fe01dd, 41fd83233).
- K-123 (listDisputes total = page size): **FIXED.** disputeService.ts:161-181 uses a separate aggregate.
- K-124 (dispute uses client_id only): **FIXED.** COALESCE is used in resolution and listing.

### PLAUSIBLE (not confirmed)

- Write-off §22(3) relief is claimed whenever the invoice has tax, without checking that the company is on the invoice (accrual) basis. A payments-basis vendor never declared that output VAT. I found no company VAT-basis flag in the services, so I could not tell whether payments-basis is supported at all.
- A write-off has no reversal or cancel path once approved: `cancelWriteOff` handles drafts only. A recovered bad debt has no workflow, so users may post manual journals that never touch `amount_paid`.
- Contra settlements are `customer_payments` rows whose `bank_account_id` is a non-bank GL account. Any reader that treats `customer_payments.bank_account_id` as a bank account (cash-flow, bank recon, receipts-by-bank) may count a contra as cash. I did not trace those readers.
- agedNetting.ts:154 counts unapplied customer payments with `status <> 'cancelled'`, which includes drafts. This looks like K-117 surfacing in aged netting; it belongs to the receipts area.
- A draft credit note linked to an invoice that is later cancelled: approval finds `ci.gl_journal_entry_id` NULL (cancel nulls it), so the whole debit goes to `default_revenue` untagged rather than the invoice's original revenue accounts or projects. This may be accepted behaviour.

### Covered

creditNoteService, creditNoteLinkService, creditNoteApproveService, creditNotePostingChecks, creditNoteCancelService (cancel + REST apply), shared/creditNoteFifo, shared/creditNoteApplicationWrites, shared/creditNoteDocumentApply (MCP apply), shared/creditNoteUnapply (MCP unapply), invoiceRevenuePosting (credit-note revenue legs), credit-notes.ts and credit-notes-action.ts routes, the MCP create_credit_note tool, writeOffService plus the write-offs and write-offs-action routes, disputeService and disputeResolution, settle_by_contra plus loadContraDocument, customerInvoiceCancelService, the soft-delete invoice guards (as far as they touch credit notes and write-offs), VAT201 box mapping for bad_debt, and the credit-note PDF query (K-057).

### Not covered

- Supplier credit-note internals (supplierCreditNoteExpenseLines, AP side).
- invoiceRevenueLines.allocateCreditNote arithmetic in depth (pro-rata and legacy replay).
- creditNoteHeaderTags and the dimension rules.
- The credit-note PDF rendering maths.
- Bulk-approve adapter internals beyond the savepoint/catch check.
- The receipt allocation and confirm path that contra composes (customerPaymentService, receiptAllocationLines): receipts area.
- The aging and statement treatment of credit notes and write-offs beyond the agedNetting status filter.

---

## Part D — Aged debtors, AR subledger vs GL, statements, dunning, debtors manager, merge

Code root: /home/hein/Workspace/IsaFlow-audit-20261018 @ 6ee5e9108. Read-only. isaflow_dev was read with `default_transaction_read_only=on` SELECTs only, for schema facts and exposure counts.

### Findings

| # | Sev | Status | File:line | Trigger → wrong output | Why |
|---|-----|--------|-----------|------------------------|-----|
| D1 | HIGH | NEW | `src/modules/accounting/services/ar/customerStatementRules.ts:39-69`, `pages/api/accounting/customer-statement.ts:86-173`, `pages/api/accounting/customer-statement-detail.ts:61-157`, `pages/api/accounting/customer-statements.ts:51-100`, `src/modules/accounting/services/ar/statementEmailService.ts:70-120`, `src/modules/accounting/services/ar/customerLedgerService.ts:108-251` (writer: `writeOffService.ts:200-204`) | Invoice R1,150, approve a R1,150 bad-debt write-off. `approveWriteOff` posts DR bad debt / CR AR and raises `amount_paid` to 1,150, so aging, subledger and the AR control show R0. All five statement surfaces (screen, detail, balances list, **emailed** statement, customer ledger) and the brought-forward still show **R1,150 owing**. | No statement or ledger query reads `customer_write_offs`. Statements debit invoices at gross and credit only receipts and credit notes. A write-off is neither, so it never reduces the statement. The figure sent to the customer is overstated by every approved write-off and disagrees with the aging and the GL. |
| D2 | MEDIUM | NEW | `src/modules/accounting/services/ar/customerLedgerService.ts:125`, `:228` | Create a receipt through `createCustomerPayment`, which inserts with the column default `'draft'` (no journal until `confirmCustomerPayment`). The customer ledger credits it at full value straight away (`cp.status != 'cancelled'`), in the opening balance and in the rows. The balance drops for money that has not been confirmed or posted to the GL. | The statement rules (`SETTLING_RECEIPT_STATUSES = confirmed, reconciled`) and the emailed statement exclude drafts, but this ledger does not. So the ledger and the statement disagree whenever a draft exists (2 on dev). |
| D3 | LOW | NEW | `src/modules/accounting/services/ar/customerLedgerService.ts:130`, `:240` vs `customerStatementRules.ts:26` | An `'applied'` credit note with a stranded remainder (total 1,000, applied 770) is credited at **1,000** on the customer ledger and at **770** on every statement surface. That gives two customer-facing balances for the same customer (2 such notes on dev). | The ledger ignores `CREDIT_NOTE_STATEMENT_VALUE`, and its own header says it must match the statement. |
| D4 | MEDIUM | NEW | `src/modules/accounting/utils/aging.ts:62-83`; `pages/accounting/ar-aging/index.tsx:119,149-184`; `pages/api/accounting/ar-aging-export.ts:22-51`; vs `pages/api/accounting/reports-ar-aging.ts:145-166` | An invoice with R10,000 outstanding and an open R10,000 dispute. `/ar-aging` (screen and CSV) puts R0 in every bucket and R0 in Total, and the dispute appears nowhere in the bucket table or the CSV (no Disputed column). `/reports-ar-aging` shows R10,000 in its bucket. The two AR aging reports disagree on total AR by the open-dispute amount, and the main screen and CSV understate AR with no indication. | `calculateAgingBuckets` subtracts `disputed` from both the bucket and `total`. The UI and export print only buckets and total. `reconcile_subledger` bridges it as a reconciling item, but nothing a user sees does. |
| D5 | MEDIUM | NEW | `src/modules/accounting/services/ar/dunningCronService.ts:122,149`; `dunningService.ts:150-152` | The customer has an unapplied receipt or an unapplied credit note covering an overdue invoice. The cron still sends the escalation ladder, up to the final demand, for the full `total_amount - amount_paid`. | Dunning reads the per-invoice `amount_paid` snapshot only. `portalOverdue.ts` exists precisely because this ignores unallocated receipts and credit notes (R-095), but the dunning cron and the rendered `{{amount_outstanding}}` were not moved to that rule. |
| D6 | LOW | NEW | `src/modules/accounting/services/ar/dunningSend.ts:54-64` (route `pages/api/accounting/ar/dunning/send.ts:73`) | A manual "send reminder" on a `draft` or `pending_approval` invoice goes out with a payment demand and a portal link. | `sendDunning` refuses only `cancelled` and zero-balance invoices. The cron applies `documentInPopulationExpr` (R-096), but the manual path does not. |
| D7 | LOW | NEW | `src/modules/accounting/services/ar/dunningCronService.ts:199-201,218`; `dunningSend.ts:147-152` | An SMTP failure on the "firm" tier leaves a `dunning_sends` row with `email_status='failed'`. The next day `last_send_for_template_at` is non-null, so that tier is skipped permanently and the customer never receives it. | The gate uses `MAX(sent_at)` without filtering `email_status = 'sent'`. |
| D8 | LOW | NEW | `src/modules/accounting/services/ar/arAgingService.ts:28` + `src/modules/accounting/utils/aging.ts:32-33,64` | Default `/ar-aging` (no `as_at_date`) run at 01:30 SAST on 2026-10-18: an invoice due 2026-10-17 shows as Current (should be 1-30), and one due 2026-09-17 (31 days) shows in 1-30 (should be 31-60). Verified with `TZ=Africa/Johannesburg node`: day counts 0 and 30. | DATE columns arrive as 'YYYY-MM-DD' (`src/lib/pgTypes`), so `new Date(dueDate)` is UTC midnight while `asAt = new Date()` is "now". Between 00:00 and 02:00 SAST every boundary invoice is bucketed one day younger. The population filter (`asAtStr` local) and `reports-ar-aging` (SQL day maths) use the SAST date, so the two reports disagree in that window. |
| D9 | LOW | NEW | `pages/api/accounting/ar-aging-export.ts:31` | The CSV headers read "30 Days, 60 Days, 90 Days, 120+ Days", but the columns hold 1-30, 31-60, 61-90 and **91+** overdue. Anything 91-120 days old is labelled 120+. | Header text does not match `getAgingBucket`. The screen labels (1-30 … 90+) are correct. |
| D10 | LOW | NEW | `pages/api/accounting/customer-statements-send.ts:118` | One request with 100 customer ids charges the volume limiter one unit, while the sibling `statement-bulk-email.ts:139-145` charges one per recipient. The email volume ceiling can be bypassed by using this route. Neither route de-duplicates ids, so a repeated id emails the same customer several times. | No `count:` is passed to `checkSendRateLimit`. |
| D11 | LOW | NEW | `pages/api/accounting/customer-statements-send.ts:44`, `statement-bulk-email.ts:49`, `customer-statement.ts:241` | If the `companies` / `accounting_settings` read throws a SQL error inside withAuth's transaction, the empty `catch {}` swallows it, but the transaction is already aborted. Every later statement in the request then fails with 25P02, which in the send loops means every customer is "failed". | Empty catch blocks (zero-tolerance rule) around SQL with no savepoint. |

### Prior K-items in this area

| K-id | Status | Evidence |
|------|--------|----------|
| K-012 | FIXED | `statementEmailService.ts:97-111` credits `cp.total_amount`. |
| K-053 | FIXED | Aging, subledger and statements use the dated `documentInLedgerAsAtFragment`. |
| K-058 | FIXED | `debtorsManagerService.ts:86,121` use `COALESCE(client_id, customer_id)`. |
| K-059 | FIXED | `dunningCronService.ts:139-146` status, paid and deleted filters. |
| K-062 | FIXED | `customer-statement.ts:92`. |
| K-093 | FIXED | sales-by-customer and `transactionReportingService.ts:58`. |
| K-122 | FIXED | `pages/portal/invoice/[token].tsx` exists and dunning emits `/portal/invoice/<token>`. |
| K-125 | FIXED | `COALESCE(ci.amount_paid,0)` throughout debtors manager. |
| K-128 | FIXED | `customerInvoiceReadService.ts:137,149,177,206`. |
| K-129 | Not re-verified (rate-limit storage semantics not traced). |
| K-252 | FIXED | `dunningInboundParseService.ts:54-55` null-checks the capture. |
| K-117 | Still open in spirit, low impact | `shared/unappliedPaymentBasis.ts:36-41` claims "a customer_payments row is created already confirmed". That is false: the column default is `'draft'` (dev schema) and `createCustomerPayment` relies on it. Drafts are always fully allocated (allocations must equal the total), so their unapplied remainder is about 0. See PLAUSIBLE P1. |
| K-061 | FIXED | `customerMergeService.ts` moves `customer_payments.client_id`. |

### PLAUSIBLE (not proven)

- **P1** `shared/agedNetting.ts:154` and `shared/unappliedPaymentBasis.ts:137,200` include `draft` receipts as unapplied cash. Draft receipts have no GL journal. The impact is about 0 today only because `createCustomerPayment` forces allocations to equal the total. A draft created by another writer with an unallocated remainder would net off the aging `net` and the reconciliation without any GL cash.
- **P2** In the AR subledger, `arSubledgerService.ts:98-119` carries only `status='approved' AND customer_invoice_id IS NULL` notes at full face value. Since mig 677 FIFO, the unconsumed part of a `partially_applied` note is missing from `subledgerTotal`. `reconciliation/unappliedCreditNoteService.ts` bridges it as a reconciling item, so `reconcile_subledger` still ties. But anyone reading `subledgerTotal` raw (`agingReportService`) sees an overstated subledger.
- **P3** For stranded `'applied'` notes, statements credit `applied_amount` while the approval journal credited AR with `total_amount`. So the statement balance exceeds the customer's GL balance by the stranded remainder (2 notes on dev). The code comments call this deliberate. It is still a statement ≠ GL difference worth a product decision.
- **P4** `customerStatementRules.ts:53` and the statement window (`ci.invoice_date BETWEEN`) drop invoices with a NULL `invoice_date`, while the aging uses `COALESCE(invoice_date, created_at)`. The column is nullable, but there are 0 rows on dev.
- **P5** Dunning cron has no run lock. Two overlapping invocations of `/api/cron/dunning-send` can both pass the "no prior send" gate for the same invoice and template and email twice.
- **P6** `customerLedgerService.ts:257` keeps a JS float running balance (`balance + debit - credit`), unlike the statements' `RunningBalance` decimal helper. Cent drift is possible on long ledgers.
- **P7** `pages/api/portal/invoice/[token].ts:87` joins `customers` on `ci.client_id` only, so the customer name is blank for the 14 dev invoices with NULL `client_id`. This is in the portal area, not mine. `customer_id` is NOT NULL on dev, so `customer_id`-only joins (`kpiChartsService.ts:187`, `receiptMatchService.ts:129`, `bankMatchDbQueries.ts:119`) are safe. Only `client_id`-only joins drop rows.

### Covered

arAgingService, utils/aging, shared/agingRewind, shared/agedNetting, shared/documentPopulation, ar-aging, reports-ar-aging, ar-aging-export, the AR aging page, arSubledgerService, subledgerShared, reconciliation/unappliedCreditNoteService and agedReportTotal (dispute bridging), customerStatementRules, customer-statement, customer-statement-detail, customer-statements, customer-statements-send, statement-bulk-email, statementEmailService, customerLedgerService and reports-customer-ledger, debtorsManagerService, dunningCronService, dunningService, dunningSend, dunningAdmin, dunningInboundParseService (token parse), portalOverdue, smartCollectionsService, customerMergeService and customer-merge, transactionReportingService.getCustomerReport, the census of AR `amount_paid` writers (each has a GL journal or acts on an already-posted note), and the `client_id`-only join sweep.

### Not covered

- MCP tool wrappers (`reportsAging`, `reconcileSubledger`) beyond their service calls.
- `subledgerReconciliationService` and its item builders (read only for dispute bridging).
- `dunningOverridesService` and `dunningDefaults` (skimmed).
- `debtors-manager.ts` route.
- Manual journals posting to the AR control without subledger (GL area).
- K-129 rate-limit refund semantics.
- Write-off approval re-validation (K-055 still looks open: `writeOffService.ts:117-204` has no balance re-check at approval). That belongs to the write-offs owner.

---

