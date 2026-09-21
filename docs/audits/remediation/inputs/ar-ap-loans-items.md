# Findings for `ar/`, `ap/`, `loans/`, `items/`, `expense/`

Commit `5661d6f0`. Audited by six readers (five parallel subagents plus a direct read of the
allocation / aging / subledger core). Ranked by severity.

---

## CRITICAL

### [CRITICAL] `applyCreditNoteToInvoice` writes an absolute `amount_paid` — lost update erases real cash
- File: `src/modules/accounting/services/ar/creditNoteCancelService.ts:145-164`
- Bug: The credit note is locked `FOR UPDATE` but the invoice is read with a plain `SELECT`, then
  `amount_paid` is written absolutely from that stale read. Every other AR writer uses the relative
  `amount_paid = amount_paid + X`. The file header claims this was fixed; it was not.
- Trigger: Invoice R1,000, `amount_paid` 0. Request A commits a R400 bank receipt. Request B, which
  had already read `amount_paid = 0`, blocks on A's row lock and then overwrites with `0 + 115 = 115`.
  The R400 receipt vanishes from the subledger while its GL journal stands — AR overstated by R400
  and the invoice re-ages as unpaid.
- Confidence: HIGH
- Evidence: `const newPaid = Number(inv.amount_paid) + applyAmount;` … `SET amount_paid = ${newPaid}`

### [CRITICAL] Loan schedule cache key ignores every financial term
- File: `src/modules/accounting/services/loans/loanScheduleService.ts:89-92` (used at :152-172)
- Bug: `buildInputsHash` hashes `loan.id`, the event rows and the rate points only — never principal,
  start date, term, rate mode, margin, fixed rate, residual, day count, reprice or skip mode. Any
  change to a loan's terms produces an identical hash, so `getOrComputeSchedule` returns the pre-edit
  amortisation. Every downstream money path reads those cached rows: `recordLoanPayment`,
  `postPeriodJournals`, `closeLoanPeriod`, `assessLoan`. The module's `.claude.md` states the hash
  covers "loan + events + points"; it covers the loan **id**.
- Trigger: Create a R100,000 loan at 10%, view the schedule. `PUT` principal to R500,000 (allowed, no
  postings yet). Reopen: identical hash, the R100,000 rows come back, and every later payment journal
  posts that split.
- Confidence: HIGH
- Evidence: `JSON.stringify({ loan: loan.id, events, points })`

### [CRITICAL] Emailed customer statement credits only the allocated part of a partial receipt
- File: `src/modules/accounting/services/ar/statementEmailService.ts:130`
- Bug: `COALESCE(SUM(cpa.amount_allocated), cp.total_amount)` fires only when the LEFT JOIN produced
  no allocation rows. A partially allocated receipt yields a smaller non-NULL sum, so the statement
  credits the allocated portion and silently drops the unapplied remainder. Partial application is
  the normal state — `unappliedReceiptService.ts` documents R2.45m of it on Brightsphere.
- Trigger: Customer pays R100,000; R40,000 allocated to INV-1, R60,000 unapplied. The emailed
  statement shows a R40,000 credit and a closing balance R60,000 above their real debt — and that
  document is what gets dunned on.
- Confidence: HIGH

### [CRITICAL] AP migration import writes to a non-existent column, then poisons the transaction
- File: `src/modules/accounting/services/ap/migrationApService.ts:74`, catch at `:121`
- Bug: `supplier_invoices` has no `balance_due` column — migration 201 defines
  `balance NUMERIC(15,2) GENERATED ALWAYS AS (total_amount - amount_paid) STORED` and nothing adds
  `balance_due`. Every INSERT raises 42703. The per-row catch swallows it into `errors[]`, but there
  is no savepoint, so the request transaction aborts and every remaining row fails 25P02; the final
  `updateSession` also fails, turning the request into a 500.
- Trigger: Run the AP step of the migration wizard with any rows. Zero imported, N
  `column "balance_due" does not exist` errors, request 500s with no session record.
- Confidence: HIGH
- Evidence: `subtotal, tax_amount, total_amount, amount_paid, balance_due,`

---

## HIGH

### [HIGH] AR and AP aging, and both subledgers, include soft-deleted invoices
- File: `ar/arAgingService.ts:53`, `ap/apAgingService.ts:87`, `ar/arSubledgerService.ts:83`,
  `ap/apSubledgerService.ts:51`
- Bug: All four filter `status NOT IN ('draft','cancelled')` with no `deleted_at IS NULL`.
  `core/softDeleteService.ts:96-108` sets `deleted_at` and leaves `status` untouched, so a deleted
  approved invoice keeps aging. `ap/supplierAutoAllocate.ts:119` gets this right, which is what makes
  it a miss rather than a convention.
- Trigger: Soft-delete an approved R1m invoice. It still appears in AR aging, in the debtors total,
  and in the subledger figure the AR control-account reconciliation is compared against.
- Confidence: HIGH
- Evidence: `WHERE ci.company_id = ${companyId} AND ci.status NOT IN ('draft', 'cancelled')`

### [HIGH] A supplier payment can settle a `pending_approval` bill that never credited AP
- File: `ap/supplierAllocationLines.ts:29`, `ap/supplierAutoAllocate.ts:74`
- Bug: `UNALLOCATABLE_STATUSES` in `buildLine` is `{cancelled, draft}`; the auto-allocate list adds
  only `paid` and `written_off`. `pending_approval` is a valid status (migration 201 line 36) and
  `approveSupplierInvoice` is what posts the Expense/VAT/AP journal. The AR twin
  `customerAutoAllocate.ts:38` does exclude `pending_approval`.
- Trigger: Capture a bill, leave it pending approval, allocate a bank payment to that supplier. The
  payment debits AP for an amount AP was never credited, and the bill flips to `paid` with no expense
  or input VAT ever recorded.
- Confidence: HIGH

### [HIGH] Batch payment creation validates nothing — over-payment and foreign-tenant bills both accepted
- File: `ap/batchPaymentService.ts:78-99`
- Bug: `createBatch` never calls `validatePaymentAllocations` and never checks that the allocated
  invoices exist, belong to this company, belong to `p.supplierId`, or have a remaining balance.
  `payment_allocations` has no `company_id`; its FK is global. `processBatch` posts DR AP / CR Bank
  for the whole batch total while its per-invoice UPDATE *is* company-scoped, so a foreign id sends
  the cash and applies nothing. The single-payment path has every one of these guards.
- Trigger: Allocate R50,000 to a R500 bill. GL debited AP R50,000, bill at `amount_paid = 50000`,
  `status = 'paid'`, `balance = -49500`.
- Confidence: HIGH
- Evidence: `const payTotal = p.invoiceAllocations.reduce((s, a) => s + a.amount, 0);`

### [HIGH] `confirmCustomerPayment` takes no row lock and its status flip is unguarded
- File: `ar/customerPaymentAllocationService.ts:39-90`
- Bug: The draft check is a plain read and the final UPDATE carries no `AND status = 'draft'`.
  `core/paymentLock.ts` exists for exactly this defect class and this path does not use it. Two
  concurrent confirms both post a DR Bank / CR AR journal and both increment `amount_paid`.
- Trigger: Double-click Confirm, or an MCP retry of a slow `settle_by_contra`. One receipt, two
  journals, invoices credited twice.
- Confidence: HIGH
- Evidence: `WHERE id = ${id} AND company_id = ${companyId}::UUID RETURNING *`

### [HIGH] `processSupplierPayment` has the identical unguarded flip
- File: `ap/supplierPaymentWorkflowService.ts:56-114`
- Bug: Reads status with a plain SELECT, refuses if not `approved`, posts DR AP / CR Bank, bumps
  `amount_paid` on every allocation, then updates with no `AND status = 'approved'`.
  `voidSupplierPayment` in the same file does guard its flip (`:199`), and `approveSupplierInvoice`
  takes `FOR UPDATE` via `supplierInvoiceLock`; this path got neither.
- Trigger: A double-clicked Process button or an agent retry of an apparently hung call. One payment,
  two posted journals, bank credited twice.
- Confidence: HIGH

### [HIGH] A supplier payment can be allocated to another supplier's bill, or to a draft/cancelled bill
- File: `ap/supplierPaymentService.ts:139-181`
- Bug: The invoice fetch scopes by `company_id` only — never `supplier_id`, never status.
  `validatePaymentAllocations` checks positivity, duplicates, per-invoice balance and the payment
  total; it has no notion of supplier or document state. `processSupplierPayment`'s status CASE has no
  `cancelled` branch, so it flips a cancelled bill to `paid`.
- Trigger: Post a payment for supplier A allocating to supplier B's open bill. B's bill reads paid,
  A's ledger shows the cash, AP debited against a credit never raised for A.
- Confidence: HIGH
- Evidence: `WHERE id = ANY(${invoiceIds}::UUID[]) AND company_id = ${companyId}::UUID`

### [HIGH] Recurring invoices post no GL journal and write no line items
- File: `ar/recurringInvoiceService.ts:131-143`
- Bug: The generated `customer_invoices` row is inserted directly at `status = 'approved'` with
  `gl_journal_entry_id` NULL, and no `customer_invoice_items` rows are written from `ri.line_items`.
  Neither caller posts (`recurring-invoices-run.ts:50,89`, `recurring-invoices-action.ts:40`). This is
  the AR-vs-GL divergence `approveCustomerInvoice` exists to prevent.
- Trigger: Run any active recurring invoice. Full value in AR aging and on the debtors ledger, nothing
  in the GL, and the detail page and PDF render with zero lines against a full total.
- Confidence: HIGH

### [HIGH] Write-offs are never re-validated at approval; multiple drafts each claim the full balance
- File: `ar/writeOffService.ts:69-96, 98-163`
- Bug: `createWriteOff` checks the amount against `total_amount - amount_paid`, but a draft write-off
  does not move `amount_paid`, so N drafts each pass the same check. `approveWriteOff` re-checks
  nothing — it posts the journal and does `amount_paid = amount_paid + ${amount}` unconditionally.
- Trigger: Two R1,000 write-offs on one R1,000 invoice, both approved. `amount_paid = 2000`, AR
  credited R2,000 against a R1,000 debt, and the phantom overpayment nets against that customer's
  other invoices in aged debtors. The same hole lets a payment received between create and approve be
  over-written-off.
- Confidence: HIGH

### [HIGH] Dispute resolved with credit posts a VAT-inclusive amount as a zero-VAT credit note
- File: `ar/disputeService.ts:302-315`
- Bug: `disputed_amount` is validated against the VAT-inclusive outstanding (line 133), then the
  auto-created credit note is built as `subtotal: disputedAmount, taxRate: 0`. `approveCreditNote`
  posts DR Revenue / CR AR for the full inclusive amount with no VAT Output line, because
  `Number(cn.tax_amount) > 0` is false.
- Trigger: R115 invoice (R100 + R15 VAT), fully disputed, resolved with credit. Revenue over-reversed
  by R15 and the R15 output VAT liability never released — VAT201 output VAT overstated on every
  credit-resolved dispute.
- Confidence: HIGH

### [HIGH] Loan period close re-posts the full current-portion reclass every month
- File: `loans/loanPeriodCloseService.ts:54-66, 159-186`
- Bug: `buildReclassificationInput` unconditionally posts DR long-term liability / CR current portion
  for the whole `stLiability` snapshot, every period, for every active loan. Nothing reverses the
  prior month's reclass and nothing posts a delta.
- Trigger: Close twelve months on a loan with a R120,000 current portion. The balance sheet shows
  roughly R1.44m current and understates long-term liability by the same. The current/non-current
  split on the AFS is wrong by an order of magnitude.
- Confidence: HIGH

### [HIGH] IFRS 9 days-past-due is measured against a future instalment, so ECL is always stage 1
- File: `loans/loanComplianceService.ts:281-285`, with `computeDaysPastDue` at `:111-128`
- Bug: `scheduledDate` is the first non-skip row with `r.date >= asOfDate` — the next *upcoming* due
  date, not the earliest unpaid one. `computeDaysPastDue` then returns 0 whenever `asOf <= scheduled`
  or `paid <= scheduled`; both hold by construction. DPD is 0 for every loan, `determineEclStage`
  always returns stage 1, and impairment is 0.45% of 12 months' cashflow.
- Trigger: A loan unpaid since 2025-06 with an instalment due 2026-10-01, assessed 2026-09-08 → DPD 0,
  stage 1, a few hundred rand of ECL on a fully non-performing loan that should carry a
  full-outstanding provision.
- Confidence: HIGH
- Evidence: `const nextScheduled = schedule.find((r) => !r.skip && r.date >= asOfDate);`

### [HIGH] Loan `postPeriodJournals` has no idempotency guard
- File: `loans/loanGlPostingService.ts:148-210`; API `pages/api/accounting/loans/[id]/gl-postings.ts`
- Bug: Before creating the journal the service checks only `nca_flagged` and the period lock. It never
  checks `loan_gl_postings` for an existing row for `(company_id, loan_id, period)`, and migration 390
  puts no unique index there (only two plain indexes). `recordLoanPayment` is protected by
  `idx_loan_payments_period_once`; this path is not.
- Trigger: `POST .../gl-postings {"period":3}` twice. Interest expense, loan-liability debit and bank
  credit all recorded twice, 201 returned both times, nothing rolled back.
- Confidence: HIGH

### [HIGH] Every stock adjustment fails — `stock_movements` has no `company_id`
- File: `pages/api/accounting/stock-adjustments.ts:47`; schema `scripts/migrations/sql/244b_inventory.sql:101-119`
- Bug: The movement insert names `company_id`; the table is created without it and no later migration
  adds it. Postgres raises 42703 and `withAuth` rolls back the whole adjustment.
  `stockValuationService`'s own header states this fact, so the two files contradict each other and
  the writer is the wrong one.
- Trigger: Any stock adjustment POST returns 500. No adjustment, no movement, no stock change. Stock
  adjustment is entirely non-functional.
- Confidence: HIGH

### [HIGH] A stocktake count is added as a delta and recorded as an outbound movement
- File: `pages/api/accounting/stock-adjustments.ts:41,46` vs `items/stockValuationService.ts:51`
- Bug: `sign = ['increase','count'].includes(type) ? 1 : -1` treats a stocktake count — an absolute
  observed quantity — as an increase to `products.current_stock`. The same request then writes the
  movement as `adjustment_out`, which the valuation subtracts.
  `NON_DELTA_MOVEMENT_TYPES = ['count']` shows the read side knows a count is not a delta.
- Trigger: 100 on hand, post a count of 100 → `current_stock` becomes 200 while the valuation reports
  quantity-on-hand 0. Latent behind the 500 above; it surfaces the moment that is fixed.
- Confidence: HIGH

### [HIGH] Credit-note PDF references a column that does not exist
- File: `ar/creditNotePdfBuilder.ts:33` (and `:44-51`)
- Bug: `LEFT JOIN customers c ON c.id = COALESCE(cn.client_id, cn.customer_id)` — `credit_notes` has
  `client_id` only (migration 202 lines 54-79); no migration adds `customer_id`. The pattern was
  copied from `customer_invoices`, where both columns really do exist. A second query at line 44 reads
  `credit_note_items`, a table no migration creates, inside a bare `catch {}` with no savepoint.
- Trigger: Any credit-note PDF request throws 42703 before rendering, and because it runs on the
  ALS-bound connection it aborts the surrounding `withAuth` transaction. Fixing the first defect
  exposes the second, which aborts the transaction from inside an empty catch.
- Confidence: HIGH

### [HIGH] Portal invoice and statement APIs query columns that do not exist
- File: `ar/portalService.ts:111`, `:145`, `:153`, `:155`, `:157`
- Bug: Selects `total` from `customer_invoices` (the column is `total_amount`); selects `reference`
  and `amount` from `customer_payments` (they are `bank_reference` and `total_amount`); filters
  `COALESCE(client_id, customer_id)` on `customer_payments`, which has no `customer_id`; and filters
  `status = 'posted'`, which is not in that table's CHECK list
  (`draft|confirmed|reconciled|cancelled`).
- Trigger: Any authenticated portal user hitting `GET /api/portal/invoices` or `/api/portal/statement`
  gets a 500. The client portal invoice list and statement are dead.
- Confidence: HIGH

### [HIGH] Debtors dashboard silently omits every invoice with a NULL `client_id`
- File: `ar/debtorsManagerService.ts:115`, `:163`, `:214`
- Bug: All three queries use bare `ci.client_id` instead of the mandated
  `COALESCE(ci.client_id, ci.customer_id)`. `client_id` was added later (migration 211) and is
  nullable; `customer_id` is the NOT NULL original, and `migrationImportService.ts:135` inserts
  `customer_id` with no `client_id`.
- Trigger: A tenant onboarded via the migration importer opens Debtors Manager. Aging summary, debtor
  detail and the overdue list all understate AR by the whole migrated book, with no error shown.
- Confidence: HIGH

### [HIGH] Dunning cron chases draft, pending-approval and soft-deleted invoices
- File: `ar/dunningCronService.ts:114-119`
- Bug: The candidate CTE filters `ci.status NOT IN ('cancelled','paid')` with no `deleted_at IS NULL`,
  and `sendDunning` guards only `cancelled` (`dunningService.ts:254`). Documents never issued to
  anyone enter the ladder; at 61+ days that ladder sends a letter of demand.
- Trigger: A draft invoice dated 90 days ago with a due date and outstanding above
  `min_outstanding_zar`. The nightly cron emails the customer a demand threatening attorneys and debt
  collection for an invoice that was never issued.
- Confidence: HIGH

### [HIGH] EFT file builders truncate over-long amounts and account numbers
- File: `ap/eftService.ts:45-48` (`padLeft`), used at `:120-125` and in every bank format
- Bug: `padLeft` keeps the **last** N characters when the input is too long. `formatEFTAmount` returns
  cents padded to 11, so any payment above R999,999,999.99 loses leading digits, and any account
  number longer than 11 digits loses leading digits — producing a valid-looking fixed-width record
  with the wrong amount or the wrong account. `validateEFTBatch` (`:75-94`) never calls
  `validateBankAccount`, so nothing checks length on the way in, and the trailer total is computed
  from untruncated values so the file cannot even agree with itself.
- Trigger: A beneficiary captured with a 13-digit account number sends the payment to a stranger.
- Confidence: HIGH
- Evidence: `return s.length > length ? s.substring(s.length - length) : s.padStart(length, '0');`

### [HIGH] Quote numbering reads across every tenant
- File: `ar/quoteService.ts:85-93`
- Bug: `nextQuoteNumber()` takes no `companyId` and queries `customer_quotes` with no `company_id`
  predicate, deriving the next number from whichever quote was created most recently platform-wide.
- Trigger: Company A's latest is `QUO-00007`, company B is already at `QUO-00050`. B creates a quote →
  `QUO-00008`, which B already used: either a duplicate number or a 23505 that 500s quote creation.
  A's sequence position leaks into B's document.
- Confidence: HIGH
- Evidence: `SELECT quote_number FROM customer_quotes ORDER BY created_at DESC LIMIT 1`

---

## MEDIUM

### [MEDIUM] A period with a lump-sum loan event can never be paid
- File: `loans/loanPaymentService.ts:209-222`
- Bug: `principal` is derived as `opening − closing`, which includes any lump-sum capital reduction,
  while `totalPaid` comes from `installment`, which excludes it. The cent-level guard then compares
  instalment principal plus lump plus interest against the instalment and throws.
- Trigger: Add a R50,000 LUMP event in month 7, recompute, then record that payment →
  `Journal imbalance: DR … ≠ CR …`. The payment can never be recorded through the UI.
- Confidence: HIGH

### [MEDIUM] `capitalGain` reports zero when an asset sells above original cost
- File: `items/farDisposalService.ts:102`, surfaced at `pages/api/accounting/assets/[assetId]/dispose.ts:144`
- Bug: `capitalGain = max(0, policyGainLoss − recoupment)`. Recoupment is capped at `taxAccDep`, but
  `policyGainLoss` is measured against the *policy* carrying amount, so wherever tax depreciation has
  outrun policy depreciation the recoupment absorbs the whole policy gain and the genuine capital gain
  disappears. The docblock says outright that proceeds above cost are capital gains.
- Trigger: Cost R100,000, policy accumulated R40,000, tax accumulated R60,000, proceeds R120,000.
  Correct: recoupment R60,000, capital gain R20,000. Returned: `capitalGain: 0`, so the CGT-bearing
  portion is dropped from the disposal response.
- Confidence: HIGH

### [MEDIUM] Supplier statement counts draft and pending-approval bills as money owed
- File: `ap/supplierStatementService.ts:118-126`
- Bug: The invoice leg excludes only `cancelled`, so `draft`, `pending_approval` and `disputed` bills
  are added at full `total_amount`. A draft bill has no journal and no AP credit, so the statement
  cannot agree with the AP control account or with `apAgingService`, which the file's own header says
  it must mirror. Payments are correctly gated by `SETTLING_PAYMENT_STATUSES`; invoices got no gate.
- Trigger: One approved R1,000 bill plus an unapproved R10,000 draft → statement shows R11,000 owed
  against a R1,000 ledger.
- Confidence: HIGH

### [MEDIUM] Supplier statement joins the dead allocation table
- File: `ap/supplierStatementService.ts:130-132`
- Bug: Reads `supplier_payment_allocations`, which `ap/.claude.md` documents as holding zero rows in
  dev and prod; the live table every writer uses is `payment_allocations`. The
  `COALESCE(SUM(...), sp.total_amount)` fallback masks it today. One row landing in the dead table
  starts reporting partially-allocated payments at their allocated amount instead of the cash paid.
- Confidence: MEDIUM

### [MEDIUM] Monthly recurring invoices drift off month-end
- File: `ar/recurringInvoiceService.ts:158-167`
- Bug: `advanceDate` uses `d.setMonth(d.getMonth() + 1)`, which overflows rather than clamping to the
  last day of the target month.
- Trigger: A template due 2026-01-31 advances to 2026-03-03, skipping February entirely; the customer
  is not billed for one period and the schedule permanently moves to the 3rd.
- Confidence: HIGH

### [MEDIUM] Missing Netcash keys make a payment run report success
- File: `ap/netcashService.ts:58-65`
- Bug: With no `serviceKey`/`payoutsKey` the service returns `{ success: true, mock: true }`. The
  route records `status = 'submitted'` with `submitted_at = NOW()` and returns 200; `mock` is only a
  field in the body and nothing gates on it. `ap/.claude.md` states production must not gate on
  absence, and nothing enforces it.
- Trigger: Rotated or unset env vars in production. The operator sees a success toast and a submitted
  record, no money moves, and the failure is invisible until suppliers chase.
- Confidence: HIGH

### [MEDIUM] `convertToSalesOrder` has no status guard
- File: `ar/quoteConvertService.ts:24-76`
- Bug: Unlike `convertToInvoice` (which requires `accepted` and is self-limiting), this checks nothing
  beyond the quote existing. Each call mints a new SO number, inserts a full duplicate with all lines,
  and overwrites `converted_order_id`.
- Trigger: Double-click Convert to Order, or a client retry. Two live sales orders for one quote, the
  quote pointing at only the second; converting each bills the customer twice.
- Confidence: HIGH

### [MEDIUM] Dunning emails send customers a portal link that always 404s
- File: `ar/dunningService.ts:208-210`
- Bug: `{{portal_link}}` renders as `${portalBaseUrl}/portal/invoice/${ctx.invoice_id}` — the invoice
  UUID. The portal route keys on the 64-hex `portal_token` and hard-rejects anything else
  (`pages/api/portal/invoice/[token].ts:59`). The correct value comes from
  `getOrMintInvoicePortalToken`, which this path never calls. All four SA default templates embed it.
- Confidence: HIGH

### [MEDIUM] Client-supplied `bankAccountId` is posted as a GL account with no company check
- File: `loans/loanPaymentService.ts:107, 148-153`
- Bug: `resolveAccounts` takes `bankAccountIdOverride` straight from the request body and uses it as
  `glAccountId` on the credit line. The API only regex-checks the UUID shape, and `createJournalEntry`
  does not verify that the account belongs to the company. The line carries this company's
  `company_id`, so it counts in the journal but disappears from any report that joins `gl_accounts` on
  `company_id`.
- Trigger: A loan payment naming another tenant's account UUID posts, and the bank credit is invisible
  to this tenant's trial balance, which no longer foots.
- Confidence: MEDIUM

### [MEDIUM] Three-way match's caught UPDATE failure aborts the whole request
- File: `ap/supplierInvoiceWorkflowService.ts:408-424`
- Bug: The comment says failures are logged and other lines keep processing, but the statement runs on
  the shared request connection with no savepoint. Any error puts Postgres in 25P02; the catch hides
  the cause and every later statement, including the final `match_status` write, fails opaquely. The
  rest of the file uses `withSavepoint` for exactly this.
- Trigger: A line whose computed `qty_variance_pct` overflows its column precision (PO qty 1, invoice
  qty 100,000) kills the match run instead of skipping one line.
- Confidence: HIGH

### [MEDIUM] A header-only supplier invoice cannot be approved
- File: `ap/supplierInvoiceWorkflowService.ts:29-67` (`buildExpenseLines`), used at `:144`, `:219`
- Bug: Every debit derives from `invoice.items`. With no item rows it returns `[]`, and approval posts
  only DR VAT plus CR AP — short by the subtotal. Where items exist but their line totals do not sum
  to the header subtotal, the **last** line silently absorbs the entire difference rather than the
  code refusing.
- Trigger: A bill imported or captured with header amounts and no `supplier_invoice_items` rows —
  nothing in `createSupplierInvoice` forbids `items: []` — throws on the unbalanced journal with no
  actionable message. With mismatched item totals, approval succeeds and posts the wrong expense split.
- Confidence: MEDIUM

### [MEDIUM] Stock adjustment returns 404 after the row is already inserted
- File: `pages/api/accounting/stock-adjustments.ts:34-43`
- Bug: The `stock_adjustments` INSERT runs first; the ownership check is the result of the subsequent
  scoped `UPDATE products`. When that matches nothing the handler returns 404, and `withAuth` only
  rolls back on status ≥ 500.
- Trigger: POST with another tenant's `productId` → HTTP 404, yet an `ADJ-` row commits permanently
  with no stock movement and no stock change behind it, and it shows in the GET list.
- Confidence: HIGH

### [MEDIUM] Receipt application ignores allocations pending on draft payments
- File: `ar/receiptAllocationLines.ts:178-185`
- Bug: `buildLine` computes `outstandingBefore = total_amount - amount_paid` and refuses only above
  that. `createCustomerPayment` deliberately subtracts allocations already sitting on draft payments
  (`customerPaymentService.ts:117-127`) because `amount_paid` does not yet reflect them. The two
  writers disagree on the same invariant.
- Trigger: A R10,000 invoice with a R10,000 draft allocation accepts a second R10,000 from a confirmed
  receipt; confirming the draft credits R20,000 against a R10,000 debt.
- Confidence: MEDIUM

### [MEDIUM] `approveAdjustment` can post the same journal twice
- File: `items/adjustmentService.ts:91-152`
- Bug: The draft check is a plain SELECT with no `FOR UPDATE`, and the status UPDATE carries no
  `AND status = 'draft'`. The GL post also happens outside the `withTransaction` that records
  `gl_journal_entry_id`, so only the second journal id is persisted and the first becomes untracked.
- Trigger: Double-click Approve on a R10,000 adjustment. Both accounts move R20,000 with one journal
  id recorded.
- Confidence: HIGH

### [MEDIUM] Unapplied-receipts report counts draft payments as unapplied cash
- File: `ar/unappliedReceiptService.ts:160`, `:196`, `:227`
- Bug: All three queries filter `cp.status <> 'cancelled'`, which admits `draft`. A draft receipt has
  posted no journal — `receiptApplicationService.ts:93-99` refuses to apply one for that reason.
- Trigger: A saved R250,000 draft receipt with no allocations reports R250,000 of unapplied cash that
  does not exist in the GL, inflating the very reconciling figure the report exists to explain.
- Confidence: MEDIUM

### [MEDIUM] `noJournal` bucket swallows receipts whose journal predates the posting-agent stamp
- File: `ar/unappliedReceiptOrigin.ts:113-121`
- Bug: The query groups by `je.posting_agent` and the mapper treats `null` as "no journal linked".
  A receipt whose `gl_journal_entry_id` points at a real pre-stamp journal also yields NULL and is
  filed under `noJournal`. The interface comment states the two are deliberately distinct facts.
- Trigger: Journal-backed receipts are reported as having no journal at all, understating
  `notStampedAsAgent` and overstating `noJournal` — the split the file exists to make.
- Confidence: MEDIUM (reporting only)

### [MEDIUM] Portal chatbot sanitiser mangles ordinary English replies
- File: `ar/portalChatbotService.ts:105`, `:109`
- Bug: `sanitizeClientResponse` strips
  `/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b[^.!?]*/gi` — case-insensitive on the plain
  English words, and everything up to the next sentence terminator. `/\bquery\b/gi` does the same.
- Trigger: "Your invoice from March is still outstanding. Please pay by Friday." becomes
  "Your invoice Please pay by Friday." in a customer-facing reply about their account.
- Confidence: HIGH

### [MEDIUM] `createSupplierInvoice` does not verify the supplier belongs to the company
- File: `ap/supplierInvoiceService.ts:114-131`
- Bug: The supplier lookup is company-scoped but its result is used only for the duplicate
  fingerprint; a miss yields a null VAT number and the INSERT proceeds with the caller's
  `supplier_id`, whose FK is global. Read paths join suppliers without a tenancy predicate
  (`supplierInvoiceService.ts:46`, `supplierInvoicePdfBuilder.ts:38`).
- Trigger: Create a bill with another tenant's `supplierId`. Opening its PDF discloses that supplier's
  name, address, VAT number, contact and bank account across the tenant boundary.
- Confidence: MEDIUM

### [MEDIUM] Loan financial-terms edit guard misses two common cases
- File: `loans/loanService.ts:262-277` (and the identical block in `deleteLoan`, `:312-322`)
- Bug: The guard looks for posted GL lines only on the loan's `gl_account_id`. But `recordLoanPayment`
  debits `current_portion_account_id` in preference (`loanPaymentService.ts:90-93`), and a NULL
  `gl_account_id` makes the subquery yield NULL so the predicate matches nothing and the guard passes.
- Trigger: A loan reclassified to current portion with several recorded payments is still editable —
  which, combined with the schedule-cache defect, rewrites terms under already-posted money.
- Confidence: HIGH

### [MEDIUM] Loan portfolio totals come from schedule period 1
- File: `loans/loanScheduleService.ts:250-258` (used at `:225`, `:236`)
- Bug: The LATERAL orders `period ASC LIMIT 1`, taking the first schedule row — the state one month
  after origination — regardless of today's date.
- Trigger: A 60-month loan opened in 2023 reports its month-1 current portion and projected
  outstanding forever.
- Confidence: HIGH

### [MEDIUM] `closeLoanPeriod` locks the period even when every loan was skipped
- File: `loans/loanPeriodCloseService.ts:159-191`
- Bug: Loans with missing GL accounts or no schedule row are pushed to `skippedLoans` and `continue`d,
  but the `loan_period_locks` INSERT runs unconditionally afterwards, and both entry points refuse a
  locked period.
- Trigger: Close a month before schedules are computed → zero reclass entries, the period permanently
  locked, and the retry throws `Period is already locked`.
- Confidence: HIGH

### [MEDIUM] Loan compliance reads a table `recordLoanPayment` never writes
- File: `loans/loanComplianceService.ts:271-278`
- Bug: DPD's `lastPaymentDate` is `MAX(loan_gl_postings.posting_date)`. `recordLoanPayment` writes
  `loan_payments` and `gl_journal_entries` only.
- Trigger: Record twelve payments, then assess. The loan behaves as if it has never been paid.
- Confidence: HIGH

### [MEDIUM] `approveBatch` and `cancelBatch` report success when they change nothing
- File: `ap/batchPaymentService.ts:113-120`, `:188-195`
- Bug: Both return `void` and never check row counts. The batch UPDATE is guarded on `status='draft'`,
  so calling approve on an already-approved or cancelled batch updates zero rows and still logs and
  returns success. The second statement, over `supplier_payments`, is not guarded by the batch's
  status at all.
- Trigger: Approve a cancelled batch → 200, batch still cancelled, but its draft payments are now
  `approved` and eligible for processing.
- Confidence: HIGH

### [MEDIUM] Bulk recurring run catches per-element errors with no savepoint
- File: `pages/api/accounting/recurring-invoices-run.ts:86-105`
- Bug: The loop wraps each generation in try/catch, but the service uses no `withSavepoint` (unlike
  `createDraftCustomerInvoice` and `quoteConvertService`). One Postgres error aborts the transaction,
  the catch swallows it, later elements fail 25P02, and the route returns 200.
- Trigger: Ten due templates, element 3 clashes on invoice number. The route answers 200 with
  `generated: 2` and two invoice ids that do not exist, and `next_run_date` is rolled back.
- Confidence: HIGH

### [MEDIUM] Recurring and sales-order invoice numbering bypasses the company sequence
- File: `ar/recurringInvoiceService.ts:124-130`; `ar/salesOrderWorkflowService.ts:40-45`
- Bug: Both derive the next number from `MAX(CAST(SUBSTRING(...) AS INTEGER)) + 1` instead of
  `reserveNextDocumentNumber`, which `createDraftCustomerInvoice` and `quoteConvertService` use with a
  savepointed 23505 retry. Two generators for one uniqueness domain, neither of these handling 23505.
- Trigger: Two templates in one batch, or a recurring run concurrent with a UI create → 23505, which
  escapes into the caller's catch and poisons the transaction. Numbering also drifts permanently out
  of sync with the configured sequence.
- Confidence: HIGH

### [MEDIUM] `listDisputes` returns the page size as the total
- File: `ar/disputeService.ts:246`
- Bug: `total: disputes.length` counts the current LIMIT-ed page; no `COUNT(*)` is issued.
- Trigger: 300 open disputes at the default limit of 50 report `total: 50`, so any pager stops at page
  one and 250 disputes are invisible.
- Confidence: HIGH

### [MEDIUM] Invoice PDF derives every line's VAT from a header rate conversions never set
- File: `ar/invoicePdfBuilder.ts:141-155`; `quoteConvertService.ts:96-127`;
  `salesOrderWorkflowService.ts:47-72`
- Bug: The PDF ignores per-line `customer_invoice_items.tax_rate` and computes
  `lineVat = lineAmount × inv.tax_rate/100`. Both conversion paths copy per-line rates into the items
  but never write `tax_rate` on the invoice header, so it falls back to the column default while
  `tax_amount` was computed per line.
- Trigger: A quote with one 15% line (R100) and one zero-rated line (R100) prints R15 VAT on both
  lines against a R15 totals block, and labels a partly zero-rated document "VAT (15%)". An incorrect
  SARS tax invoice.
- Confidence: HIGH

### [MEDIUM] Soft-deleted items are still returned by every list query
- File: `items/itemService.ts:254-259` vs `:105,119,131,142`
- Bug: `softDeleteItem` sets `is_active = false` and never touches `deleted_at`, but `listItems`
  excludes only on `deleted_at`.
- Trigger: Delete an item, get `{deleted: true}`, and it still lists and remains selectable on invoice
  and quote line pickers.
- Confidence: HIGH

### [MEDIUM] Debtors queries drop invoices with NULL `amount_paid`
- File: `ar/debtorsManagerService.ts:90`, `:118`, `:155`, `:253`
- Bug: `ci.total_amount - ci.amount_paid` with no `COALESCE(amount_paid, 0)`. The column is nullable;
  NULL propagates, the `> 0` filter is then NULL rather than true, and the row vanishes from every
  debtors view and from `getCollectionStats`. Everywhere else in the codebase uses COALESCE here.
- Confidence: MEDIUM

### [MEDIUM] Dispute credit-note creation ignores the legacy `customer_id` column
- File: `ar/disputeService.ts:290-300` (also the joins at `:199`, `:211`, `:222`, `:233`)
- Bug: Uses bare `client_id` where CLAUDE.md requires `COALESCE(ci.client_id, ci.customer_id)`.
- Trigger: A dispute on a migrated invoice with NULL `client_id` throws
  `Cannot auto-create credit note: invoice has no client`, so it can never be resolved with credit,
  and it renders with a blank customer name in the list.
- Confidence: HIGH

### [MEDIUM] Items PUT with an explicit null crashes or stores the string `"null"`
- File: `pages/api/accounting/items.ts:141,156,157` → `items/itemService.ts:228,243,244`
- Bug: The route guards on `!== undefined`, so a JSON `null` reaches `String(null)`. `category_id`
  then binds `'null'::UUID` and Postgres raises 22P02 (500); `notes`, `image_url` and `opening_date`
  silently store the four-character text `null`. The `COALESCE(param, column)` shape also makes it
  impossible to clear any of these fields.
- Confidence: HIGH

### [MEDIUM] Mileage-trip endpoint turns a post-write failure into a 400
- File: `pages/api/accounting/expense-claims/mileage-trip.ts:92-98`
- Bug: A blanket catch returns `badRequestFromError`, but `addLine` inserts the line, then recomputes
  totals, then reads the claim. `withAuth` only rolls back on 5xx.
- Trigger: A failure after the insert reports "Request failed" while the claim silently gains a line
  whose header totals were never recomputed.
- Confidence: MEDIUM

### [MEDIUM] `GREATEST(0, …)` clamps stock while the movement ledger records the full quantity
- File: `pages/api/accounting/stock-adjustments.ts:42`
- Trigger: 10 on hand, write off 25. `current_stock` floors at 0 while `stock_adjustments` and
  `stock_movements` record 25. `products.current_stock` and the movement-derived valuation quantity
  disagree permanently, with nothing flagging it.
- Confidence: HIGH

---

## LOW

### [LOW] `getBatchById` drops the tenancy filter on an empty company id
- File: `ap/batchPaymentService.ts:48-55`. `companyId ? scoped : unscoped` — any caller passing `''`
  reads another tenant's batch header by id, and the branch buys nothing since `createBatch` always
  has a real id. Confidence HIGH.

### [LOW] Loan `curve_id` is never ownership-checked
- File: `loans/loanService.ts:207-247`, `loanScheduleService.ts:110-115`. `fetchRatePoints` queries
  `loan_rate_points` with no company scoping and no join back to the curve, unlike
  `getRatePointsForCurve` in the same module. A loan created with another tenant's curve id returns
  their negotiated rates in every schedule row. Confidence HIGH.

### [LOW] `processBatch` marks individually cancelled payments as processed
- File: `ap/batchPaymentService.ts:175-176`. The flip has no source-status predicate, so a payment
  cancelled after batch approval reads `processed` and becomes voidable as if it were live cash.
  Confidence HIGH.

### [LOW] `updatePurchaseOrder` cannot clear a field, and ignores an empty items array
- File: `ap/purchaseOrderService.ts:227-254`. Every column uses `COALESCE(param, column)`, so a null
  cannot clear `delivery_date`, `reference` or `notes` while the API reports success; `items: []`
  neither deletes lines nor recomputes totals. A cleared delivery date still prints on the supplier
  PDF. Confidence HIGH.

### [LOW] First sales order and delivery note per company are numbered `-00000`
- File: `ar/salesOrderService.ts:96-109`, `deliveryNoteService.ts:92-105`,
  `quoteConvertService.ts:32-41`. `RETURNING next_number - 1` is right on the DO UPDATE path but
  returns 0 on the initial INSERT. Cosmetic but permanent in the audit trail. Confidence HIGH.

### [LOW] Malformed inbound `[ref:…]` token crashes the dunning webhook
- File: `ar/dunningInboundParseService.ts:19`, `:55` → `dunningAdmin.ts:222`. `REF_TOKEN_RE` captures
  `[0-9a-f-]+` and validates it with an unanchored UUID regex, so a superstring passes into a
  `::uuid` cast and raises 22P02 out of a function documented as never throwing. Confidence MEDIUM.

### [LOW] Invoice header subtotal can disagree with the sum of its stored line amounts
- File: `ar/customerInvoiceCreateService.ts:74-78, 157-168`. The header rounds the sum of unrounded
  line values once, while each line amount is rounded independently. Three lines of 0.335 store 0.34
  each (1.02) against a header subtotal of 1.00. Confidence HIGH.

### [LOW] `getBundleLines` joins `items` without a tenant predicate
- File: `items/itemBundleService.ts:51`. The only current writer validates child ownership, so it is
  not exploitable through the API today, but any row written by an import or a future caller returns
  another tenant's item code, description and selling price. Confidence MEDIUM.

### [LOW] `COUNT(*)`-derived item codes collide
- File: `items/itemService.ts:150-156`. `generateItemCode` returns `ITEM-<count+1>` and `createItem`
  never dup-checks a generated code; a manually entered code of that shape, or two concurrent creates,
  hits the unique constraint as a 500 rather than a validation error. Confidence MEDIUM.

### [LOW] Expense claim numbering is COUNT-based with no retry
- File: `expense/expenseClaimService.ts:163-173`. `COUNT(*) + 1` against a
  `UNIQUE (company_id, claim_number)` with no 23505 retry, unlike `customerInvoiceCreateService`.
  Two simultaneous creates and the second errors out. Confidence MEDIUM.

### [LOW] Dry-run/live parity gap for tax-only depreciation rows
- File: `items/depreciationRunPreview.ts:94` vs `depreciationRunService.ts:174`. The preview classifies
  on `policy.monthlyDep <= 0` alone; the live run skips only when both policy and tax depreciation are
  below a cent. An asset fully depreciated on policy but still carrying tax life is reported
  differently by the two. Confidence MEDIUM.

### [LOW] `gl-postings` route does not validate the loan id
- File: `pages/api/accounting/loans/[id]/gl-postings.ts:22-31`. Unlike `payments.ts`, it passes
  `String(req.query.id)` straight into a uuid-typed query, so a non-UUID id 500s instead of 400s.
  Confidence HIGH.

### [LOW] Doc drift on the loan schedule hash
- File: `loans/.claude.md` and its `AGENTS.md` mirror claim `inputs_hash` is
  `sha256(loan + events + points)`. The code hashes the loan **id**. This is what makes the CRITICAL
  cache defect invisible to a reader. Confidence HIGH.

---

## Latent defect behind the AP import crash

`migrationApService.ts:92-99` posts DR Expense (subtotal) + DR VAT / CR AP for the **full** invoice
while also storing `amount_paid` and a `paid`/`partially_paid` status, with no offsetting DR AP for
the already-settled portion. If the `balance_due` column bug is fixed as written, every migrated
part-paid bill leaves the AP control account overstated by its `amount_paid`. The journal is also only
balanced when the CSV's `subtotal + taxAmount` exactly equals `totalAmount`; any rounding difference
in the source file makes `createJournalEntry` throw for that row.

---

## Areas read and cleared

- The point-in-time rewind machinery — `arAgingService`, `apAgingService`, `arSubledgerService`,
  `apSubledgerService`, `shared/agingRewind` — is careful and correct apart from the soft-delete
  predicate reported above. The UTC+2 clock discipline, the undated-invoice handling and the
  documented rewind limitations all check out.
- `supplierAutoAllocate` and `customerAutoAllocate` are sound apart from the `pending_approval`
  asymmetry reported above.
- `farDepreciationService` (proration, over-depreciation caps, disposal cutoff, the SARS month-after
  rule), `depreciationRunPlan`, `assetRegisterService`, the three
  `fixedAssetReconciliation*` files, `fixedAssetDisposalQueries`, `farAfsService` and
  `stockValuationService` were read in full with no findings.
- `customerInvoiceReadService`, `customerInvoiceCancelService`, `customerInvoiceApprovalService`,
  `invoiceStatusRecompute`, `creditNoteLock`, `creditNoteLinkService`, `creditNoteMapper`,
  `invoicePdfSnapshotService`, `invoicePdfService`, `quotePdfBuilder`, `smartCollectionsService` and
  `sentMirrorAdmin` are company-scoped, use relative money updates, and handle the savepoint and lock
  hazards correctly.

## Gaps

- The pure amortisation engine at `src/lib/amortisation/` is outside this scope. The PMT formula,
  zero-rate division, day-count conventions and final-instalment balancing remain unchecked.
- `inventoryService.calculateFIFO`, `calculateWeightedAverage` and the entire `assetService`
  depreciation engine have no call sites anywhere in `src/` or `pages/`. Defects in dead code were not
  reported.

---

## Files read

All 55 files in `src/modules/accounting/services/ar/`, all 26 in `ap/`, all 7 in `loans/`, all 18 in
`items/`, `expense/expenseClaimService.ts`, and each module's `.claude.md` / `AGENTS.md`.

Supporting reads: `services/shared/agingRewind.ts`, `services/shared/autoAllocateStrategy.ts`,
`services/shared/journalPeriodVisibility.ts`, `services/core/paymentLock.ts`,
`services/core/softDeleteService.ts`, `services/core/paymentVoidService.ts`,
`services/gl/journalEntryCrudService.ts`, `services/gl/systemAccountResolver.ts`,
`services/gl/glCrossModuleHooks.ts`, `utils/paymentAllocation.ts`, `src/lib/constants/invoiceStatuses.ts`.

Routes: `pages/api/accounting/{stock-adjustments, items, item-bundles, recurring-invoices-run,
recurring-invoices-action, adjustments-action, customer-payments-action, netcash/submit,
supplier-allocations, expense-claims/[id]/post, expense-claims/mileage-trip,
loans/[id]/payments, loans/[id]/gl-postings, assets/[assetId]/dispose}.ts`, and
`pages/api/portal/{auth, invoices, statement, payment-link, invoice/[token]}.ts`.

Migrations: `000_users_and_auth.sql`, `201_accounts_payable.sql`, `202_accounts_receivable.sql`,
`211`, `244b_inventory.sql`, `268_soft_delete.sql`, `362_asset_period_ledger.sql`,
`390_loans_schema.sql`, `400_loan_payments.sql`, `421`.
