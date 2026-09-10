# K-107 — recurring invoice numbers were constant for a calendar month

**Trigger.** `recurringTransactionService.executeRecurring` built the number as
`RINV-<name-slug>-<YYYYMM>` (customer) and `RSINV-<name-slug>-<YYYYMM>` (supplier) from
`new Date().toISOString().slice(0,7)`. A daily or weekly template therefore minted the SAME
number on every run inside a month.

**Before / after.**
- Customer side: second run of the month hit `uq_customer_invoices_company_number` and 500'd.
  Now the number comes from `reserveNextDocumentNumber(companyId, 'customer_invoice')` — the SAME
  sequence every other writer of that table uses, not a second one — with a savepointed 23505
  retry for a clash with a legacy number.
- Supplier side: no unique index existed, so every run minted an identical bill — same
  `invoice_number`, same `duplicate_fingerprint` — inflating payables and input VAT. Now the
  number comes from the `supplier_invoice` sequence, and migration 646 makes a repeat fail loudly.
  It retries exactly as the customer side does (see **Both branches retry** below).

**Files.** `src/modules/accounting/services/core/recurringTransactionService.ts`;
`scripts/migrations/sql/646_supplier_invoice_number_unique.sql`.

**Tests.** `tests/integration/k107-recurring-invoice-number-collision.int.test.ts` (2),
`tests/integration/k107-recurring-number-sequence-adjacent.int.test.ts` (3 — both entity types
plus other-tenant isolation, two suppliers sharing one document number, soft-deleted recapture).
Mutation proof in `green.log` (M4, M5).

**Migration.** 646 adds `uq_supplier_invoices_supplier_number` on
`(company_id, supplier_id, invoice_number) WHERE deleted_at IS NULL AND invoice_number <> ''`.
The domain is per supplier, not per company: `invoice_number` is the supplier's own document
number and two suppliers issuing `INV-001` is ordinary. The migration runs the pre-flight ITSELF
and aborts naming the offending groups, rather than leaving the operator to decode a
`CREATE INDEX` "Key ... is duplicated" detail that shows only the first collision. Rollback:
`DROP INDEX uq_supplier_invoices_supplier_number;`.

**Historical impact.** Daily/weekly AP templates already duplicated bills, and duplicates from any
other origin — manual capture, Sage sync, PO conversion, import — block the index just as hard.
The probe must therefore be EXACTLY the index predicate and grouping, with no `RSINV-` filter
(an earlier draft had one and reported all-clear on a database the index then refused).
Read-only, NOT run against production:
```sql
SELECT company_id, supplier_id, invoice_number, count(*), sum(total_amount)
FROM supplier_invoices
WHERE deleted_at IS NULL AND invoice_number <> ''
GROUP BY 1,2,3 HAVING count(*) > 1;
```
Clean these before applying 646. Monthly/quarterly templates are unaffected.

**Both branches retry.** The AP INSERT is savepointed with the same bounded 23505 retry as the AR
one, through `insertWithReservedNumber`. It first had none, on the reasoning that a clash means the
bill is already captured — true of `RSINV-<slug>-<YYYYMM>`, false of a number this system mints.
One pre-existing `SIV0000001` would have disabled that company's AP templates permanently: the
route answered 4xx, `withAuth` committed an aborted transaction, the reservation rolled back, and
the next run reserved the same number again. The route now answers 4xx only for the pre-write
"no such active template" case and lets everything else become a 500, so the transaction rolls back.

**Limits.** Existing `RINV-<slug>-<YYYYMM>` and `RSINV-…` rows are left alone; only new runs use
the sequence, so one template's history is split across two number formats and the chronological
order of a company's invoice numbers does not match issue order for those rows. Invoice creation
is now serialised per company for the whole request transaction (the counter row lock is held to
COMMIT, where the old `MAX()` read blocked nothing) — measured at 927 ms for three 300 ms
transactions.

---

## Round 3 — the 9 blind-review findings (review-k107-r2.md)

**H1 — the fix removed the only barrier against a repeat recurring run. FIXED.**
`executeRecurring` read the template without `FOR UPDATE` and never consulted `next_run_date`; it
only advanced it at the end. Under the old month-constant number a second AR run in the same month
died on the unique index — an accident, and one that also broke genuine daily templates. With a
sequence number a double-click, a client retry or a re-POST would have minted a second real
customer invoice AND a second supplier bill, silently. New `recurringTemplateLock.ts` takes the row
under `FOR UPDATE` with a 5 s `lock_timeout` and computes `is_due` in the same statement;
`executeRecurring` refuses a not-due template with `RecurringTemplateNotDueError`, raised before the
first write, which the route answers 409 (`nextRunDate` in `error.details`). Same shape as
`recurringInvoiceService`. The guard is proved in BOTH directions: an immediate second run is
refused with nothing minted and no number burned, and a genuinely due run the next day succeeds in
the same calendar month with a distinct number (the original K-107 claim). The race between them is
proved with two pool clients in two open transactions — B parks on A's row for 300 ms, then reads
the advanced date and is refused.

**M1 — the orphaned `recurring_invoice` / RINV sequence. FIXED.** Nothing reserves from it, but the
settings editor still showed a RINV row whose prefix and next-number the user could edit to no
effect. `getDocumentNumbers` now filters it and the PUT refuses it up front (before the first write,
because `withAuth` COMMITs on a 4xx). It is dropped from `DEFAULT_DOC_NUMBERS` but the existing row
is hidden, NOT deleted: it carries the historical counter for the `RINV-…` documents that exist.

**M2 — fix.md's Before/after described code that was not shipped. FIXED** (the two bullets above).

**L1 — the fifth copy of the retry loop. FIXED**: `quoteConvertService.convertToInvoice` now uses
`insertWithReservedNumber` instead of its own `quote_conv_inv_${attempt}` loop.
**L2 — `draft` quotes can no longer convert to a sales order. ACCEPTED**, deliberate and covered by
`k121-quote-convert-status-allowlist` (9 cases); the list page only offers the button for
`accepted`, so there is no in-app regression. Recorded as an API contract narrowing.
**L3 — per-company serialisation of invoice creation. ACCEPTED**, recorded under Limits above.
**L4 — migration prefix 646 rather than 627. ACCEPTED**: the prefix is assigned by the remediation
programme's shared register to avoid collisions between parallel branches; ordering is unaffected.
**L5 — the stale `RINV-` mirror test. FIXED**: `BL-53-57-insert-not-null-fixes.test.ts` asserts the
sequence format it now INSERTs; the NOT-NULL coverage it exists for is unchanged.
**L6 — header with no lines. FIXED**: both branches write `customer_invoice_items` /
`supplier_invoice_items` from `templateData.lines`, INSIDE the savepointed attempt so a 23505 on the
number takes the lines with the header. Templates that predate the field carry only the aggregate
and still run. Both documents are asserted to foot: sum(lines) = header subtotal, sum(line tax) =
header tax, subtotal + tax = total.

**Round 3 files.** New: `src/modules/accounting/services/core/recurringTemplateLock.ts`,
`recurringTransactionInvoices.ts` (the AR/AP branches, split out to keep
`recurringTransactionService.ts` under the 300-line cap). Changed: `recurringTransactionService.ts`,
`recurringTransactionErrors.ts`, `companySettingsService.ts`, `companyService.ts`,
`quoteConvertService.ts`, `documentNumberRetry.ts`,
`pages/api/accounting/recurring-transactions-execute.ts`, `pages/api/accounting/company-settings.ts`.

**Round 3 tests.** `k107-recurring-invoice-number-collision.int.test.ts` (4, rewritten — it
previously asserted the double-execution as correct), `k107-recurring-number-sequence-adjacent`
(5), `k107-ap-recurring-number-clash` (3), `tests/unit/api/recurringExecuteNo4xxAfterWrite` (5),
`tests/unit/api/companySettingsRetiredDocumentType` (3, new),
`tests/unit/services/core/retiredDocumentNumberType` (3, new). Mutation proof M10-M13 in green.log.

**Round 3 historical impact.** No migration and no data change. Templates whose `next_run_date` is
in the past run once and then advance as before; a template with a NULL `next_run_date` still runs
(the column is nullable and unscheduled templates must stay runnable). Existing duplicate documents
from past double-runs are not cleaned up by this change. The query below is the AUTO-REC SUBSET,
not the deploy pre-flight for migration 646 — that one is under **Historical impact** above and
mirrors the index predicate exactly. Read-only:
```sql
SELECT company_id, supplier_id, invoice_date, total_amount, count(*)
FROM supplier_invoices
WHERE reference = 'AUTO-REC' AND deleted_at IS NULL
GROUP BY 1,2,3,4 HAVING count(*) > 1;
```

---

## Round 4 — the 7 blind-review findings (review-k107-r3.md)

**HIGH-1 — `convertToInvoice` kept the check-then-act round 3 fixed next door. FIXED.**
`quote.status !== 'accepted'` was read and then the invoice was minted: two concurrent calls both
read 'accepted' and both billed the customer, with `converted_invoice_id` pointing at one of the
two. Now a status-predicated claiming `UPDATE ... WHERE status='accepted' RETURNING id` runs BEFORE
the sequence is touched; the loser re-reads and gets `QuoteNotInvoiceableError` carrying the
winner's invoice id, which the route answers 409. Same remedy, same shape as `convertToSalesOrder`.

**The sibling sweep the finding asked for — and what it caught.** Every mint path was read, not
just the named function: the five callers of `insertWithReservedNumber` plus every convert /
transition path in `src/modules/accounting/services`. `salesOrderWorkflowService.
convertSalesOrderToInvoice` had the IDENTICAL defect (read `status !== 'confirmed'`, then mint) and
is reachable from the sales-order screen's "Invoice" action. FIXED the same way
(`SalesOrderNotInvoiceableError`, 409). `recurringInvoiceService.runOneTemplate` and
`executeRecurring` were already guarded by their row locks; nothing else mints under a status read.
Its route also caught EVERYTHING into `badRequestFromError` — a 4xx after a write, which `withAuth`
COMMITs — so it now maps only the two pre-write refusals and rethrows the rest.

**MEDIUM-1 — the recurring documents did not foot; only the fixture did. FIXED.**
`headerTotals` (new `recurringTemplateLines.ts`) DERIVES subtotal/tax/total from the lines when the
template has any, and refuses a stored aggregate that disagrees by more than 1c/line (capped at
R1.00) with `RecurringTemplateTotalsMismatchError` — raised before the first write, answered 400.
Templates that predate the `lines` field still run on their aggregate. The footing test now uses a
template with NO stored aggregate, so it fails if the derivation is removed; the round-3 assertion
could not, because its fixture agreed with itself.

**MEDIUM-2 — every `auto_post` template raised a 500 on every run. FIXED.**
`status = 'posted'` is not a value either CHECK permits. Both branches now call the canonical
approve path (`approveCustomerInvoice` / `approveSupplierInvoice`), which sets a legal status AND
posts the journal — setting a bare 'approved' would put the document in AR/AP with no GL behind it.
Covered by the first two tests in `k107-recurring-autopost-and-footing`, which assert the status,
a non-null `gl_journal_entry_id`, and a balanced journal agreeing with the document total.

**MEDIUM-3 — existing duplicates uncounted, and 646 is fail-closed. PARTIALLY ACTIONED.**
The Round-3 query is now labelled: it is the AUTO-REC subset, NOT the deploy pre-flight. The
pre-flight is the query under **Historical impact** above, which mirrors the index predicate and
grouping exactly. It has NOT been run: this programme's agents are forbidden from querying
production, even read-only. **OPERATOR ACTION BEFORE DEPLOY:** run it, record the count here, and
clean any groups it returns — otherwise migration 646 aborts and the deploy fails.

**LOW-1 — the retry swallowed any 23505. FIXED.** `insertWithReservedNumber` now takes the
numbering index name and renumbers only for a clash on THAT constraint; anything else is rethrown
with one reservation spent instead of five. Four call sites updated;
`tests/unit/services/core/documentNumberRetry.test.ts` (4) pins both directions.

**LOW-2 — prefix 646 leaves 627–645 unused. ACCEPTED**, no change wanted on this branch (the
reviewer's own ruling); the ordering hazard is recorded in the programme's prefix register.
**LOW-3 — `BL-53-57-insert-not-null-fixes.test.ts` is 361 lines. ACCEPTED**, inherited and not
touched this round; split by fixture group when it is next edited.

**L3 caveat — the counter row had no `lock_timeout`. FIXED.** `reserveNextDocumentNumber` now sets
`SET LOCAL lock_timeout = '5s'` (the programme's standard, restored to DEFAULT on the success path
only) and raises `DocumentNumberLockTimeoutError` instead of hanging behind a stuck holder.
Serialisation itself is unchanged and still accepted under **Limits**.

**Round 4 files.** New: `src/modules/accounting/services/core/recurringTemplateLines.ts`. Changed:
`quoteConvertService.ts`, `salesOrderWorkflowService.ts`, `recurringInvoiceService.ts`,
`recurringTransactionInvoices.ts`, `recurringTransactionErrors.ts`, `documentNumberRetry.ts`,
`companySettingsService.ts`, `pages/api/accounting/{customer-quotes-action,
customer-sales-orders-action,recurring-transactions-execute}.ts`.

**Round 4 tests.** `tests/integration/k121-convert-double-mint.int.test.ts` (5),
`k107-recurring-autopost-and-footing.int.test.ts` (4),
`k107-document-number-lock-timeout.int.test.ts` (2), `tests/unit/api/
convertActionsNo4xxAfterWrite.test.ts` (4), `tests/unit/services/core/documentNumberRetry.test.ts`
(4), plus one case added to `recurringExecuteNo4xxAfterWrite` (6). Mutation proof M14–M19 in
green.log. Full unit suite with the fixture env unset: 9565 passed / 243 skipped, 0 failed.

**Round 4 historical impact.** No migration and no data change. API contract narrowings: converting
a non-accepted quote answers 409 (was 400) and a missing quote 404; invoicing a non-confirmed sales
order answers 409 (was 400). Documents already minted by a double-convert are NOT cleaned up — the
duplicate is a real invoice that has to be credit-noted, not deleted. Read-only probes, NOT run
against production:
```sql
-- quotes that produced more than one invoice
SELECT q.company_id, q.id, q.quote_number, count(*) AS invoices
FROM customer_quotes q JOIN customer_invoices ci
  ON ci.company_id = q.company_id AND ci.notes = 'Converted from ' || q.quote_number
WHERE ci.deleted_at IS NULL GROUP BY 1,2,3 HAVING count(*) > 1;
-- sales orders that produced more than one invoice
SELECT so.company_id, so.id, so.order_number, count(*) AS invoices
FROM customer_sales_orders so JOIN customer_invoices ci
  ON ci.company_id = so.company_id AND ci.notes = 'Converted from ' || so.order_number
WHERE ci.deleted_at IS NULL GROUP BY 1,2,3 HAVING count(*) > 1;
```
Auto-post templates have never produced a document (the 23514 rolled every run back), so there is
no auto-posted history to correct.

---

# Round 5 (R-044) — the census the round-4 sweep's generalisation missed

Round 4's three named items (K-107 / K-120 / K-121) were confirmed closed by the blind review and
all six of its mutations go red. What follows is the review's own census, plus mine, and the
survivors both found. Every finding below is PRE-EXISTING and outside the three item numbers.

## Findings from review-k107-r4

| # | Site | Disposition |
|---|---|---|
| HIGH-1 | `quoteService.nextQuoteNumber` — `SELECT quote_number FROM customer_quotes ORDER BY created_at DESC LIMIT 1`, **no `company_id` at all** | FIXED. Reserves from the company's `quotation` sequence via `insertWithReservedNumber`; header AND lines now inside the savepoint so a retry orphans no lines. Migration **666** adds `uq_customer_quotes_company_number`. |
| HIGH-2 | `practiceWipService.generateWipInvoice` + `pages/api/accounting/time-entries-invoice.ts` — status read, then mint, `markEntriesBilled`'s row count discarded, retry on `msg.includes('unique')` with no savepoint | FIXED. `lockTimeEntries` (FOR UPDATE, 5s `lock_timeout`, typed error) before the eligibility read; both mint through `insertWithReservedNumber`; the claim is predicated and its row count is checked (`TimeEntriesNotClaimedError`). |
| MEDIUM-1 | `customerInvoiceCreateService` kept a sixth inline reserve-and-retry loop, renumbering on ANY 23505 | FIXED. Replaced with `insertWithReservedNumber`; only `uq_customer_invoices_company_number` renumbers. |
| MEDIUM-2 | `pages/api/accounting/purchase-orders.ts` — `COUNT(*)+1` against `UNIQUE(company_id, po_number)`, no retry | FIXED. Reserves from the `purchase_order` sequence; `generatePONumber` removed (its only caller). |
| LOW-1 | `DocumentNumberLockTimeoutError` reached no route; user saw a masked 500 | FIXED. `src/lib/apiDocumentLock.ts` maps all three lock-timeout errors to **503 + `Retry-After: 2`**, wired into `withErrorHandler` and the time-entries route. 503, not 4xx: 55P03 leaves the tx aborted and `withAuth` COMMITs below 500. |
| LOW-2 | claiming UPDATEs had no `lock_timeout`, and sat in front of the one thing that did | FIXED. `documentClaimLock.claimUnderLockTimeout` — same 5s and typed error as `recurringTemplateLock`; used by both quote converts, the sales-order convert and the payment batch. |
| LOW-3 | `reserveNextDocumentNumber` leaked the 5s ceiling on the "no config" throw | FIXED. Restored before that throw (not on the 55P03 path, which must not run another statement). |
| LOW-4 | `supplier-returns.ts` minted `DR-` from `COUNT(*)+1` with no index behind it | FIXED. Reserves from the `supplier_return` sequence. Siblings: `expenseClaimService`, `assets.ts` → MAX; `inventoryService` see census. |
| LOW-5 | auto-post test did not assert `fiscal_period_id` | FIXED in `k107-recurring-autopost-and-footing` (`journalOf` asserts non-null). |

## My own census

**(a) numbering / minting queries missing a `company_id` filter** — enumerated by call site over every
`padStart` document-number construction and every `insertWithReservedNumber` /
`reserveNextDocumentNumber` caller in `src/modules/**` and `pages/api/**`.

| Site | Verdict |
|---|---|
| `quoteService.nextQuoteNumber` | **the only one** — fixed (HIGH-1) |
| `admin/invoiceService` `INV-YYYYMM-` | global by design (platform billing, not tenant data); COUNT→MAX fixed |
| every other generator | company-scoped already |

**(b) check-then-act on a status without a lock or a predicated claim** — enumerated over every file
that reads a status in JS *and* inserts a document or a journal.

| Site | Verdict |
|---|---|
| `batchPaymentService.processBatch` | **NEW HIGH — FIXED.** Read `status !== 'approved'`, then created and POSTED DR AP / CR Bank for the batch, incremented `amount_paid` on every invoice, then rewrote the batch with `WHERE id = $1` (no status, no `company_id`). Two clicks = two journals, bank credited twice, supplier ledger overstated. Now a status-predicated claim under `claimUnderLockTimeout`, `BatchNotProcessableError` for the loser, `company_id` on the final UPDATE, and the route maps only the pre-write refusals to 4xx (it answered every failure with a 400, which `withAuth` COMMITs). |
| `salesOrderService.updateSalesOrder` | **NEW MEDIUM — FIXED.** Header UPDATE was predicated but its row count discarded; the item DELETE + re-INSERT ran anyway, so a request beaten by a confirm rewrote the lines of an already-billed order. Returns null on zero rows. |
| `time-entries-invoice.ts` vs the practice WIP path | **NEW MEDIUM — FIXED.** The two subsystems use different columns: WIP sets `status='billed'` + `billed_at` and leaves `invoiced` false, and this route read only `invoiced = false` — so entries the practice screen had already invoiced were billed a second time, **serially, with no concurrency**. `billed_at IS NULL` added to the read and the claim. |
| `itemService.generateItemCode` | FIXED (COUNT→MAX; no unique index, so it was a silent duplicate). |
| `quoteConvertService`, `salesOrderWorkflowService`, `recurringInvoice/Transaction`, `goodsReceivedService`, `deliveryNoteService`, `purchaseOrderService`, `creditNoteService`, `supplier-invoices.ts`, `bankAllocationService`, `sageImportService` | already guarded (claim, `FOR UPDATE`, advisory lock or atomic counter) |
| `pages/api/accounting/products.ts` `generateProductCode(cat, 0)` | **NOT FIXED — unreachable.** `validateProduct` rejects a blank `code` with a 422 before the generator runs, so the "every product gets PRD-0001" bug cannot be triggered through the route. Reported, not patched. |
| `procurementService.generateGRNNumber` | dead — no non-test caller (`goodsReceivedService` has its own atomic counter). Mentioned, not deleted. |
| `inventoryService.generateProductCode` | only caller is the unreachable one above. |

## Round 5 files

`src/lib/apiDocumentLock.ts`, `src/lib/api-error-handler.ts`,
`src/modules/accounting/services/core/documentClaimLock.ts`,
`src/modules/accounting/services/practice/timeEntryLock.ts`, `practice/practiceWipService.ts`,
`ar/quoteService.ts`, `ar/quoteConvertService.ts`, `ar/salesOrderWorkflowService.ts`,
`ar/salesOrderService.ts`, `ar/customerInvoiceCreateService.ts`, `ap/batchPaymentService.ts`,
`ap/procurementService.ts`, `core/companySettingsService.ts`, `core/documentNumberRetry.ts`,
`expense/expenseClaimService.ts`, `items/itemService.ts`, `src/modules/admin/services/invoiceService.ts`,
`pages/api/accounting/{assets,projects,purchase-orders,supplier-returns,time-entries-invoice,
batch-payments-action}.ts`, `scripts/migrations/sql/666_customer_quote_number_unique.sql`.

## Round 5 tests

New: `k107-quote-number-tenant-scope` (5), `k107-wip-invoice-double-bill` (5),
`k107-time-entries-invoice-route` (5), `k107-count-plus-one-numbering` (6),
`k107-claim-lock-timeout` (2), `k107-batch-payment-double-post` (4),
`k107-sales-order-line-rewrite` (3), `tests/unit/lib/apiDocumentLock.test.ts` (4).
Whole K-107/120/121 integration set: **19 files, 71 passed**. Full unit suite with the fixture env
UNSET: **9569 passed / 243 skipped / 0 failed**. `tsc --noEmit` and `eslint` on every changed file:
clean. Mutation proof M20–M34 in green.log — every one red, including the two that need their guard
removed *as well as* the lock to show a real double-bill (M21+M22, M23+M24), which is the honest
statement that the count check is defence in depth behind the row lock, not the primary guard.

## Round 5 migration and historical impact

**666** `uq_customer_quotes_company_number`, total (no `deleted_at` on `customer_quotes`). It
detects the same index by COLUMN SET, so it is a no-op where K-060's
`uq_customer_quotes_company_quote_number` already exists, and the service accepts either name when
it renumbers. All three paths proven against the fixture DB inside a rolled-back transaction:
no-op, create, and refuse-with-named-groups. Rollback: `DROP INDEX uq_customer_quotes_company_number`.

Existing rows may be wrong in three ways. Read-only probes, **NOT run against production**:
```sql
-- 1. quote numbers a company issued twice (the unscoped nextQuoteNumber). 666 refuses on these.
SELECT company_id, quote_number, count(*) FROM customer_quotes
 GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 3 DESC;
-- 2. time entries billed on two customer invoices (WIP path + time-entries route)
SELECT te.company_id, te.id, te.invoice_id, te.billed_at, te.invoiced
  FROM time_entries te
 WHERE te.billed_at IS NOT NULL AND te.invoiced = true;   -- both subsystems claimed it
-- 3. payment batches processed more than once (two journals for one batch)
SELECT b.company_id, b.id, b.batch_number, count(je.id) AS journals
  FROM supplier_payment_batches b
  JOIN gl_journal_entries je
    ON je.company_id = b.company_id AND je.source = 'auto_batch_payment'
   AND je.description = 'Supplier batch payment ' || b.batch_number
 GROUP BY 1,2,3 HAVING count(je.id) > 1;
```
Nothing is auto-corrected. A duplicate invoice is a real document that must be credit-noted, and a
duplicated batch journal must be reversed by a journal, not deleted.

## Limits

- The `admin/invoiceService` COUNT→MAX fix has no test: the admin billing module has no integration
  harness here, and it is covered only by `tsc` and `eslint`. Stated rather than implied.
- `TimeEntriesNotClaimedError` and the sales-order row-count check are unreachable while their row
  locks hold; they are proved by removing the lock as well (M21+M22, M23+M24), not on their own.
- The concurrency assertions (`settled === false` after 300ms) are timing-sensitive under heavy
  parallel-agent load on this box; one such flake was seen and did not reproduce in three reruns.

---

# Round 6 — the four census survivors (review-k107-r5.md)

The round-5 blind review found four sites the round-5 census missed: three
check-then-act-on-status approvals that post to the ledger, and one document
number minted from `COUNT(*)+1`. All four are fixed with the remedy this branch
already carries — a status-predicated claim under a row lock, taken after the
last read-only step and before the first ledger write, with the claiming
UPDATE's row count checked and the loser refused with a typed error.

| Finding | Disposition |
|---|---|
| `supplierPaymentWorkflowService.processSupplierPayment` | **HIGH — FIXED.** `processBatch`'s singular twin. Read `payment.status !== 'approved'` in JS, then created and POSTED DR AP / CR Bank for the full amount, incremented `amount_paid` on every allocated bill, and rewrote the payment row with no status predicate. Now a status-predicated claim under `claimUnderLockTimeout`, `SupplierPaymentNotProcessableError` for the loser (raised before the first posting), and the final UPDATE writes only `gl_journal_entry_id`. Route maps only pre-write refusals to 4xx. |
| `writeOffService.approveWriteOff` | **HIGH — FIXED.** Same shape: read `status !== 'draft'`, then posted DR Bad Debt / CR AR plus the §22(3) VAT recovery and added the amount to the invoice's `amount_paid`. Now claimed; `WriteOffNotApprovableError`. |
| `adjustmentService.approveAdjustment` | **HIGH — FIXED.** Same shape, posting to AR or AP. Now claimed; `AdjustmentNotApprovableError`. The separate `withTransaction` around the final UPDATE is gone — a second connection could not see the claim; the link write now runs on the request transaction. |
| `pages/api/accounting/stock-adjustments.ts` | **MEDIUM — FIXED.** Minted `ADJ-${COUNT(*)+1}` with no unique index: silent duplicates after any deletion and under concurrency. Now `insertWithReservedNumber` off the company's atomic `stock_adjustment` counter, with migration **671** adding `uq_stock_adjustments_company_number`. Two adjacent defects on the same path are fixed because the fix moved them: the product-ownership check now runs **before** the first write (it answered 404 after the INSERT, and `withAuth` COMMITs a 4xx), and the `stock_movements` INSERT no longer names a `company_id` column that table has never had — it raised 42703 on **every** adjustment, so this route has never once written a row. Adding that column is K-085's; movements stay tenant-scoped through `products`, as `stockValuationService` documents. |

Also carried in this round, from the round-5 review's remaining M/L: `claimUnderLockTimeout` now
**refuses** outside a request transaction (`ClaimOutsideTransactionError`) instead of claiming
without one — an autocommitted claim cannot be rolled back with the posting that follows it — and
restores `lock_timeout` on the non-55P03 error path, where the transaction is still usable and the
5s ceiling would otherwise leak onto every later statement. `companySettingsService` gains the
`stock_adjustment` / `ADJ` default. `assetService.assetNumberPrefix` replaces the
`generateAssetNumber(cat, 0).split('-')[0]` prefix trick in `assets.ts`. `expenseClaimService`,
`itemService` and `practiceWipService` carry corrected comments only — each now states plainly that
MAX+1 without a savepointed retry 23505s into a 500 rather than duplicating, and that the WIP row
count is defence in depth behind `lockTimeEntries`, not the primary guard.

## Round 6 files

`src/modules/accounting/services/ap/supplierPaymentWorkflowService.ts`,
`ar/writeOffService.ts`, `items/adjustmentService.ts`, `items/assetService.ts`,
`core/documentClaimLock.ts`, `core/companySettingsService.ts`, `expense/expenseClaimService.ts`,
`items/itemService.ts`, `practice/practiceWipService.ts`,
`pages/api/accounting/{stock-adjustments,assets,supplier-payments-action,write-offs-action,adjustments-action}.ts`,
`scripts/migrations/sql/671_stock_adjustment_number_unique.sql`.

## Round 6 tests

New: `k107-supplier-payment-double-post` (5), `k107-write-off-double-post` (5),
`k107-adjustment-double-post` (5), `k107-stock-adjustment-numbering` (4),
`tests/unit/services/core/documentClaimLock.test.ts` (4),
`tests/unit/api/approveActionsNo4xxAfterWrite.test.ts` (6). Each of the three double-post files
proves the guard by OUTCOME — the bank/AR GL measured off posted journal lines, not a journal
count — under **two interleaved pool clients AND two sequential attempts**, plus the legitimate
path, a never-approved document, and another tenant's document.

Whole K-107/K-120/K-121 integration set: **23 files, 90 passed**. Full unit suite with the fixture
env UNSET: **807 files, 9579 passed / 243 skipped / 0 failed**. `tsc --noEmit`: clean. `eslint` on
every changed `src/` and `pages/` file: clean. Mutation proof M35–M41 in green.log, each applied
alone from a file copy and restored; all red.

**One correction, carried into green.log.** Its first draft of M35/M36/M37 read "bank credited
2300.00" / "AR credited twice", which is not what those runs report. Under each mutation the
assertions that go red are the **typed-error** ones — the loser stops refusing — while the GL
delta assertions still pass, because the concurrent case rolls its loser back by design. The
double post is real and was measured directly, but separately: a standalone probe on the fixture DB
with M35 applied returned `bank=2300.00, amount_paid=2300.00` and two posted journals for one
1150.00 payment. Stated rather than left to imply a measurement the suite did not make.

## Round 6 migration

**671** `uq_stock_adjustments_company_number` on `(company_id, adjustment_number)`, total (no
`deleted_at` on `stock_adjustments`). Detects an equivalent index by COLUMN SET, so it is a no-op
against a differently-named one from a parallel branch. All three paths run against the fixture DB:
create (the index is present), no-op (`NOTICE … already enforces …`), and refuse — the refusal
proved inside a rolled-back transaction with the index dropped and a duplicate pair inserted, which
named the offending group and aborted. Rollback: `DROP INDEX uq_stock_adjustments_company_number`.

**OPERATOR ACTION.** Duplicates are the expected case on any tenant that has ever deleted a stock
adjustment. Read-only probe, **NOT run against production**:
```sql
SELECT company_id, adjustment_number, count(*) FROM stock_adjustments
 GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 3 DESC;
```
Renumber the extras before deploying 671; nothing is auto-corrected.

Historical impact of the three claims: a document processed or approved twice leaves **two posted
journals** for one document with only the later `gl_journal_entry_id` on the row, so the first is
unreachable from the document. Read-only probes, **NOT run against production**:
```sql
-- supplier payments processed more than once
SELECT p.company_id, p.id, p.payment_number, count(je.id) AS journals
  FROM supplier_payments p
  JOIN gl_journal_entries je ON je.company_id = p.company_id
   AND je.source = 'auto_supplier_payment'
   AND je.description = 'Supplier payment ' || p.payment_number
 GROUP BY 1,2,3 HAVING count(je.id) > 1;
-- write-offs / adjustments whose subledger moved twice for one document
SELECT wo.company_id, wo.id, wo.amount, ci.amount_paid, ci.total_amount
  FROM customer_write_offs wo JOIN customer_invoices ci ON ci.id = wo.invoice_id
 WHERE wo.status = 'approved' AND ci.amount_paid > ci.total_amount + 0.01;
```

## Round 6 limits

- The three double-post files prove the refusal by typed error and the legitimate path by outcome.
  The concurrent case necessarily rolls its loser back, so the GL delta there measures the winner
  only; the sequential case is what carries the outcome. See the M35 correction above.
- Migration 671's create path is proven by the index existing on the fixture DB after the run, not
  by a fresh create in this session — it was already created by the round's earlier work; the
  refuse and no-op paths were run here.
- `assets.ts`, `expenseClaimService`, `itemService` and `admin/invoiceService` are MAX+1 against a
  real unique index with **no savepointed retry**: concurrent creates 23505 into a 500 rather than
  duplicating. That is the correct trade and is now stated in each comment, but it is not a retry
  and is not fixed here.

---

# Register item — the complete inventory of what this branch did NOT fix

Enumerated from the ledger writers (every service calling `createJournalEntry` / `postJournalEntry`
or writing `amount_paid`) and from the tables (every unique index on a document-number column,
read off the fixture schema), not by grepping for the predicate — a census by predicate cannot find
the code missing it. Each row below was read in the source and its guard, or absence of one,
confirmed by eye. Nothing here is fixed on this branch.

## A. Check-then-act on status, still open

| File :: symbol | Risk |
|---|---|
| `ar/customerPaymentAllocationService.ts` :: `confirmCustomerPayment` | **HIGH.** The AR twin of `processSupplierPayment`, unfixed: reads `status !== 'draft'`, posts DR Bank / CR AR, increments `amount_paid` on every allocation, then rewrites `customer_payments` with no status predicate and its row count discarded. Two confirms debit the bank twice. |
| `ar/customerPaymentAllocationService.ts` :: `cancelCustomerPayment` | **HIGH.** Mirror image: reads `status !== 'confirmed'`, then decrements `amount_paid` on every allocation and rewrites the payment unpredicated. Two cancels un-apply the receipt twice. |
| `reports/vatAdjustmentService.ts` :: `approveVATAdjustment` | **HIGH.** Byte-for-byte the shape just fixed in `adjustmentService`: reads `status !== 'draft'`, posts the VAT journal, then rewrites `vat_adjustments` unpredicated. |
| `capture/provisionalPostingService.ts` :: `postProvisional` | **MEDIUM.** Reads `bank_transactions.status !== 'imported'`, posts the provisional journal, then sets `status='provisional'` unpredicated — two runs post two provisional journals for one bank line. |
| `gl/recurringJournalService.ts` :: `generateJournalFromRecurring` | **MEDIUM.** Reads `status !== 'active'`, posts the journal, then `UPDATE recurring_journals … WHERE id = ${id}` — no status predicate **and no `company_id`**, which is a tenancy defect in its own right. Two runs post the recurrence twice and double `run_count`. |
| `gl/journalEntryPostingService.ts` :: `postJournalEntry` | **MEDIUM.** Reads `entry.status !== 'draft'`, then `SET status='posted' … WHERE id AND company_id` with no status predicate and the row count discarded. Every service above posts through it, so it is the last line that could refuse a double post and it does not. |
| `ar/creditNoteCancelService.ts` :: `cancelCreditNote` | **LOW-MEDIUM.** Reads `status` in ('approved','applied'), un-applies `amount_paid` (that UPDATE **is** guarded by `AND amount_paid >= ${unapply}` and its row count checked, which is what bounds the damage), then flips `credit_notes.status` unpredicated. |

Verified **not** open, and why, so the next census does not re-open them: `approveSupplierInvoice`
(`lockSupplierInvoiceForUpdate` before the status read), `expenseClaimService.postClaimToGl`
(`SELECT … FOR UPDATE` before the status read), `creditNoteCancelService.applyCreditNoteToInvoice`
and `customerInvoiceCancelService.cancelCustomerInvoice` (both `FOR UPDATE`),
`customerPaymentAllocationService.postCustomerInvoiceToGL` (early-returns on an existing
`gl_journal_entry_id`), and the seven already carrying predicated claims on this branch
(`processBatch`, `processSupplierPayment`, `voidSupplierPayment`, `approveCreditNote`,
`approveWriteOff`, `approveAdjustment`, `reverseJournalEntry`).

## B. Numbering — unscoped, non-atomic, or unindexed

| File :: symbol | Risk |
|---|---|
| DB trigger `trg_cp_payment_number` on `customer_payments`; `trg_sp_payment_number` on `supplier_payments` | **HIGH.** Both mint `CP-/SP-<year>-<MAX+1>` from a `SELECT MAX(...)` inside a `BEFORE INSERT` trigger under READ COMMITTED, and **neither table carries any unique index on `(company_id, payment_number)`** (checked against the fixture schema: `supplier_payments` has only its pkey; `customer_payments` has its pkey and `ux_customer_payments_card_reference`). Two concurrent payments in one company and year get the **same** number, silently — the exact class fixed for stock adjustments here, on the two tables that carry money. |
| `ap/purchaseOrderService.ts` :: `generateOrderNumber` | **LOW.** The counter UPDATE is atomic, but the zero-row branch (first-ever PO for a company) does an `ON CONFLICT DO NOTHING` insert and returns a hard-coded `PO-0000001`: two concurrent first POs both return it and the second 23505s on `purchase_orders_company_id_po_number_key`. No retry. |
| `ar/deliveryNoteService.ts` :: `nextDeliveryNoteNumber`; `ar/salesOrderService.ts` :: `nextOrderNumber` | **LOW.** Atomic upsert on `company_document_numbers`, but both ignore the counter row's `padding` column (hard-coded `padStart(5)`) and both fall back to a fixed `DN-00001` / `SO-00001` on zero rows, which can duplicate against an existing row. |
| `pages/api/accounting/assets.ts`; `expense/expenseClaimService.ts` :: `nextClaimNumber`; `items/itemService.ts` :: `generateItemCode`; `admin/services/invoiceService.ts` | **LOW.** MAX+1 against a real unique index, no savepointed retry — concurrent creates 23505 into a 500. Correct trade, not a retry. Now stated in each comment. |
| `ap/procurementService.ts` :: `generateGRNNumber` | **NONE — dead.** No non-test caller; `goodsReceivedService` has its own atomic counter. Mentioned, not deleted. |
| `pages/api/accounting/products.ts` :: `generateProductCode`; `items/inventoryService.ts` :: `generateProductCode` | **NONE — unreachable.** `validateProduct` rejects a blank `code` with a 422 before the generator runs (carried over from round 5). |

## Round 7 — the dead MAX()+1 generator is deleted

Deleted `src/modules/accounting/services/practice/wipInvoiceNumber.ts` (`insertWipInvoice`) and
`tests/unit/services/practice/wipInvoiceNumber.test.ts`, and removed the do-not-call note the file's
existence had required in `practice/.claude.md`.

The semantic merge (`18e522a20`) moved `generateWipInvoice` onto `insertWithReservedNumber` and left
`insertWipInvoice` in the tree, unused, flagged do-not-call. That was the right call *for a merge* —
you do not delete master's work while reconciling it — but it is wrong for this branch. This branch's
entire subject is that `MAX(invoice_number)+1` numbering is unsafe, and section B above registers
`trg_cp_payment_number` / `trg_sp_payment_number` as **live** instances of that same class on the two
tables that carry money. Shipping a branch that argues the class is a defect while leaving a dead,
working, importable implementation of it in `services/practice/` is a landmine for the next writer who
needs an invoice number and greps for one: a do-not-call comment is weaker than the file not existing.

Confirmed unreferenced before deleting — the only mentions in the tree were its own unit test, the two
doc mirrors, and the historical `K-040/fix.md` record (left as-is; it describes what K-040 did).
Nothing in `src/` or `pages/` imported it.

Re-proved by outcome on the tree after the deletion (integration, `--no-file-parallelism`) — see the
proof block below.

---

# Round 8 — the unanchored regex, and the two directories the census never walked

Findings from the round-7 blind review (1 HIGH, plus the census gap). The review
file itself was lost with `/tmp` when the server restarted; the HIGH and the
census gap are reproduced from the task brief and were each re-confirmed in the
source before being fixed. The remaining MEDIUMs and LOWs of that review could
**not** be recovered — neither `fix.md` nor `green.log` records them, and
nothing else in the tree does. They are not restated here rather than invented.

## HIGH-1 — `/not found$/` also matched 'Bank account not found'

`supplier-payments-action.ts` classified a not-found by matching the END of the
message. `processSupplierPayment` throws `Payment <id> not found` BEFORE any
write, but it also throws `'Bank account not found'` at line 104 — **after** the
status-predicated claim at line 86 has already flipped the payment to
'processed'. That message matched too, so the route answered 404, and `withAuth`
COMMITs anything below 500: the payment was left `'processed'` with no journal
and **no way to retry**, because every retry path is the claim it had already
taken. The realistic trigger is not exotic — a `bankAccountId` belonging to
another tenant is filtered out by the company-scoped lookup, which is exactly
what `supplierPaymentWorkflowService.test.ts`'s "fails closed when the bank
account does not belong to the company" already exercised.

The two twins fixed in the same commit (`972870495`) used start-anchored
regexes (`/^Adjustment not found/`, `/^Write-off not found/`). This one did not,
inside that same commit.

**Fix.** A typed `SupplierPaymentNotFoundError`, raised by `approveSupplierPayment`,
`processSupplierPayment` and `voidSupplierPaymentInner` — all three before any
write — and matched by the route with `instanceof`. Pattern matching is gone
from that classifier entirely. 'Bank account not found' is now untyped, falls
through to `throw err`, and `withErrorHandler` answers 500, which ROLLBACKs the
claim with it.

**Sweep of the branch for the same class.** Every `pages/**` and `src/**` file
changed by this branch, scanned for a message-shaped classifier
(`.test(`, `.match(`, `.includes(`, `startsWith(`, `endsWith(`, `new RegExp(`
applied to an error message). Four hits, one of them the defect:

| Site | Verdict |
|---|---|
| `supplier-payments-action.ts:63` `/not found$/` | **THE DEFECT — fixed** (typed). |
| `supplier-payments-action.ts:68` `startsWith('Cannot approve payment with status')` | Start-anchored, and `approveSupplierPayment` raises it before its UPDATE. Left. |
| `adjustments-action.ts:50` `/^Adjustment not found/` | Start-anchored. Left. |
| `write-offs-action.ts:58` `/^Write-off not found/` | Start-anchored. Left. |
| `documentNumberRetry.ts:56` | Matches an exact `constraint` NAME against an allowlist, not a message. Not this class. |
| `apiDocumentLock.ts`, `api-error-handler.ts` | Already `instanceof` on the three typed lock classes. Not this class. |

## The census: the set it looked at was the thing that was wrong

The round-6 enumeration walked `services/{ap,ar,gl,items,core,expense,capture,reports,practice}`
and missed `services/payroll` and `services/loans` entirely — so
`applyTaxDirective` and `markUifDeclarationPaid` were absent from §A, not
because they were classified as safe but because they were never read.

**This run's method and its walk set.** Enumerated from the CONSUMERS — every
file in `src/**` or `pages/**` calling `postJournalEntry(` — 39 of them, listed
in `<scratchpad>/agents/fix-k107j/posters.txt`. That set was then classified by
reading each file's status logic. The walk was over **all 155 directories
containing a `.ts`/`.tsx` under `src/`** (`dirs-walked.txt`), which includes
every service directory:

> `afs · annotations · ap · ar · bank · capture · commentary · core · dashboard ·
> expense · gl · items · loans · packs · payroll · practice · reconciliation ·
> reports · share · shared · workbench`

plus `src/lib/mcp/tools`, `src/modules/admin`, and `pages/api/accounting/**`.
The 39 posters land in 8 service directories, 2 `pages/api` routes, 2 MCP tools.

### Fixed in this round

| File :: symbol | What it was |
|---|---|
| `payroll/uifPaymentService.ts` :: `markUifDeclarationPaid` | **HIGH.** Read `decl.status` in JS, posted DR 2150 UIF Payable / CR Bank, then rewrote `uif_declarations` with **no** status predicate and its row count discarded. `uif_declarations` carries no protection of its own. Two concurrent `markPaid` PATCHes both read 'submitted', both posted and **both COMMITted** — the bank credited twice for one UI-19, one journal id orphaned. Now takes a status-predicated claim under `claimUnderLockTimeout` before the first posting; the loser re-reads and stays idempotent when the winner already paid, and refuses otherwise. |
| `payroll/taxDirectivePaymentService.ts` :: `applyTaxDirective` | **MEDIUM.** SELECTed `tax_directive_payments` for an existing row, then posted DR 5200 / CR 2140 / CR bank and INSERTed the payment **last**. The payment row now IS the claim (`ON CONFLICT (company_id, tax_directive_id) DO NOTHING`, rowcount checked), taken before the first posting, with `journal_entry_id` linked after. |
| `payroll/taxDirectivePaymentService.ts` :: `glByCode`; `loans/loanPaymentService.ts` :: `glByCode` | **HIGH (dead route).** Both selected `gl_accounts WHERE ... code = $2`. There is no `code` column on `gl_accounts` — it is `account_code` — so every call raised 42703, which also poisons the request transaction. `applyTaxDirective` calls it unconditionally for GL 5200 and 2140: **the tax-directive apply route had never once succeeded.** In `loanPaymentService` it is only the fallback when the loan has no `interest_expense_account_id` or bank account, so it turned a recoverable configuration case into an opaque 500. Same class as the `stock_movements` `company_id` 42703 round 6 found. |

**Correction to the review's premise on the directive.** The brief recorded
"no unique index on `tax_directive_payments`". There is one: migration 403
creates the table with `UNIQUE (company_id, tax_directive_id)`, confirmed on the
fixture schema as
`tax_directive_payments_company_id_tax_directive_id_key`. So the pre-fix code
did **not** double-post under concurrency — the loser's 23505 aborted its
transaction and unwound its own posted journal. What was wrong is what the fix
addresses: the guard was decorative, the refusal arrived only after a journal
had been posted, and the caller got an opaque 500 instead of a refusal raised
before the first posting. The finding is upheld at MEDIUM, not HIGH, on measured
evidence rather than on the stated premise.

### New to the register, NOT fixed here

Turned up by this run and absent from §A. Each was read in the source.

| File :: symbol | Risk |
|---|---|
| `pages/api/accounting/capture/[id]/post-expense.ts` | **HIGH.** Reads `event.event_status === 'posted'` and answers 400, then creates and submits an expense claim (which posts), then sets `capture_events.status='posted'` with **no** status predicate. No row lock, no claim. Two concurrent posts of one captured document create two expense claims and two journals. The `withTransaction` hazard on those stamps was already fixed here; the check-then-act was not. |
| `loans/loanPaymentService.ts` :: `recordLoanPayment` | **MEDIUM.** Reads `loanRow.status !== 'active'`, then SELECTs `loan_payments` for the period, then posts and INSERTs last — the same shape as `applyTaxDirective` before this round. `idx_loan_payments_period_once` (partial UNIQUE on `company_id, loan_id, period_number`) makes the outcome safe, so the loser 23505s into a 500 rather than duplicating; the read is decorative under concurrency. The `periodNumber`-omitted path skips the idempotency SELECT entirely and relies on the index alone. |
| `bank/bankReconciliationService.ts` :: `completeReconciliation` | **MEDIUM.** Reads `recon.status === 'completed'`, then flips `bank_transactions` to 'reconciled' and `bank_reconciliations` to 'completed' — the header UPDATE has no status predicate and its row count is discarded. Both run inside `withTransaction`, a **separate pool client with its own COMMIT**, so they survive a rollback of the request transaction: the same hazard `post-expense.ts` carries a comment about having fixed. Two concurrent completes both pass the read and both stamp `completed_by` / `completed_at`. |
| `gl/closeRun/closeRunService.ts` :: `completeCloseRun` | **LOW.** Reads `existing.run.status !== 'open'`, then `updateCloseRunStatus`. The repo UPDATE **is** predicated (`AND status = 'open'`, closeRunRepo:218) and every proposal transition is too (:171, :188), so nothing double-posts. What is unguarded is the row count: it is discarded, so a losing concurrent complete writes a second `close_run` audit row against a run it did not complete. Register, not a ledger risk. |
| `expense/expenseClaimService.ts` :: `submitClaim` / `approveClaim` / `rejectClaim` | **LOW.** Read-then-unpredicated-UPDATE on `expense_claims.status`. None of the three posts to the ledger — `postClaimToGl` does, and that one is `FOR UPDATE`-protected — so a lost race changes a workflow status, not the books. |
| `core/sageImportService.ts` | **LOW.** Selects `migration_status = 'pending'` and updates row by row with no predicate on the re-read. Two concurrent imports of one batch could import a line twice; it is an operator-run migration path, not a user route. |

Re-confirmed **not** open on this pass, so the next census does not re-open them:
`bankAllocationService` (`FOR UPDATE` at :103 before the status read),
`bankRuleAutoPostLine` (`locked` row read `FOR UPDATE`),
`creditNoteApproveService` (`FOR UPDATE` plus a `status='draft'` predicate on the flip),
`recurringJournalService.generateJournalFromRecurring` (`FOR UPDATE` held, claim predicated — §A's MEDIUM stands only for the missing `company_id` on that UPDATE),
`writeJournals`/`writeOpeningBalance` MCP tools (post through `postJournalEntry`, so they inherit §A's entry
for it and add nothing new),
`payrollJournalPostingService`, `loanGlPostingService`, `glImportExecuteService`,
`openingBalancePostingService`, `reclassification/post`, `migrationApService`,
`migrationImportService`, `migrationOpeningBalanceService`, `gatewayFeeService`,
`drcVatService`, `journal-entries-action`, `receipt-to-journal` (no status
check-then-act: they either post unconditionally from validated input or are
guarded by a predicated UPDATE whose row count is checked).

## Round 8 files

- `pages/api/accounting/supplier-payments-action.ts` — typed classifier.
- `src/modules/accounting/services/ap/supplierPaymentWorkflowService.ts` — `SupplierPaymentNotFoundError`, thrown at all three pre-write sites.
- `src/modules/accounting/services/payroll/uifPaymentService.ts` — **new**; `markUifDeclarationPaid` split out of `uifDeclarationService.ts`, which the claim would have pushed to 321 lines over the 300 ceiling. Not re-exported from there: that would be an import cycle, since the mapper and the result type still live in the declaration service, so `pages/api/payroll/uif/[id].ts` imports it directly. `mapDeclaration` is exported as `mapUifDeclaration`.
- `src/modules/accounting/services/payroll/uifDeclarationService.ts` — 244 lines; the four imports the move orphaned are removed.
- `src/modules/accounting/services/payroll/taxDirectivePaymentService.ts` — `TaxDirectiveAlreadyAppliedError`, the INSERT as claim, `account_code`.
- `src/modules/accounting/services/loans/loanPaymentService.ts` — `account_code`.

## Round 8 tests

- `tests/integration/k107-payroll-liability-double-post.int.test.ts` (7) — UIF and directive, each under two interleaved pool clients AND two sequential attempts, measured on the **bank GL** rather than a journal count; plus the legitimate path (balanced, non-null `fiscal_period_id`), the draft refusal, and other-tenant isolation.
- `tests/integration/k107-loan-payment-gl-fallback.int.test.ts` (1) — a loan with neither `interest_expense_account_id` nor `bank_account_id`, so both `glByCode` fallbacks are reached; asserts the journal lines land on 5700 and 1110, which is what the 42703 made impossible.
- `tests/integration/k107-supplier-payment-double-post.int.test.ts` (+1, and one assertion strengthened) — the post-claim 'Bank account not found' forced with a foreign-tenant bank account: the payment is left `'approved'` with a null `gl_journal_entry_id` and a null `processed_at`, the bank GL unmoved, and **the same payment then processes on the retry**. The other-tenant test now asserts the typed class rather than matching `/not found/`.
- `tests/unit/api/approveActionsNo4xxAfterWrite.test.ts` (+2) — the route answers 404 for the typed pre-write miss and **rethrows** 'Bank account not found'.

## Round 8 mutation proof (file copies in `<scratchpad>/agents/fix-k107j/backup`, restored and diffed clean)

| # | Production line reverted | Went RED |
|---|---|---|
| M1 | route classifier back to `/not found$/` | `approveActionsNo4xxAfterWrite` — "does NOT answer 404 for the post-claim Bank account not found" (1 failed / 7 passed) |
| M2 | `SupplierPaymentNotFoundError` back to `new Error('Payment … not found')` | `k107-supplier-payment-double-post` — other-tenant `toBeInstanceOf` (1 failed / 5 passed) |
| M3 | `AND status = 'submitted'` dropped from the UIF claim | `k107-payroll-liability-double-post` — sequential markPaid, and the draft refusal (2 failed / 5 passed) |
| M4 | `ON CONFLICT … DO NOTHING` dropped from the directive claim | same file — both DIRECTIVE concurrency tests (2 failed / 5 passed) |
| M5 | `loanPaymentService` `account_code` back to `code` | `k107-loan-payment-gl-fallback` — `column "code" does not exist` (1 failed / 1) |
| M6 | `taxDirectivePaymentService` `account_code` back to `code` | `k107-payroll-liability-double-post` — all three DIRECTIVE tests, `column "code" does not exist` |

## Round 8 migration

**None.** Every table this round touches already carries the index the fix leans
on: `tax_directive_payments_company_id_tax_directive_id_key` from migration 403,
and `uif_declarations` is claimed on its own `status` column. No new prefix was
reserved.

## Round 8 historical impact

- **Tax directives: nothing to correct.** `glByCode`'s 42703 means
  `applyTaxDirective` has never completed on any tenant — `tax_directive_payments`
  can only be empty, and no directive journal exists to be wrong. The fix
  *enables* the route rather than correcting its output. Worth stating plainly:
  the first successful apply in production will be the first ever.
- **UIF declarations:** a double-post requires two concurrent `markPaid` PATCHes
  on one declaration. Whether any tenant has a duplicated DR 2150 / CR bank pair
  is a data question this branch does not answer and does not correct. The query
  to settle it is `uif_declarations` joined to posted `auto_payroll` journals for
  the same period with more than one match — **not run here.**
- **Supplier payments stranded by HIGH-1:** a payment reading `'processed'` with
  a NULL `gl_journal_entry_id` is the signature. **Not queried on production
  here.** That census belongs with whoever runs the fix in prod.
