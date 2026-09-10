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
| `batch-payments-action.ts:55` `err.message === 'Batch not found'` | **Row added in round 9** — the round-8 sweep read it and left it, but did not record it. Exact equality, so immune to the substring class by construction, and `processBatch` throws it before its first write. Left. |
| `customer-sales-orders-action.ts:51` `err.message === 'Sales order not found'` | **Row added in round 9**, same reason: exact equality, and `convertSalesOrderToInvoice:57` throws it pre-write. Left. |
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

# Round 9 (R-060) — the recovery that ate the error, the 409 that should be a 503, and the census RECORD

The round-8 blind review scored `2e0ae4f36` at **3 LOW, no HIGH, no MEDIUM**, and
re-derived every round-8 claim independently (8/8 mutations red, both round-8
corrections upheld on evidence). These three close the branch.

## LOW-1 — `claimUnderLockTimeout`'s recovery destroyed the error it was recovering from

`src/modules/accounting/services/core/documentClaimLock.ts`

The catch block's comment asserted that "any OTHER failure out of the claim — a
23505, a CHECK violation — leaves the transaction usable". **It does not.** In
Postgres *every* SQL error aborts the transaction, not only 55P03. So on a
23505 / 23514 / 23503 / 22P02 out of a claim the recovery
`SET LOCAL lock_timeout = DEFAULT` raised **25P02** itself, and *that* rejection
— not `err` — left the catch block. The operator and Sentry saw
`current transaction is aborted` instead of the constraint that actually fired,
on all seven claiming write paths (supplier payment, sales order, quote ×2,
write-off, adjustment, UIF, tax directive).

Not a ledger risk — the outcome is still ≥500, so `withAuth` ROLLBACKs — but it
is this codebase's known class: *a caught SQL error still poisons the
transaction; best-effort SQL after a failure needs its own guard, and catching
alone lies.*

**Fix.** The restore is now attempted inside its own `try`, and a failure of the
restore is swallowed in favour of `err`. It is still attempted, because `claim`
can also fail as a plain JS throw on a still-usable transaction — and there the
restore is the thing that stops the 5s ceiling leaking onto the rest of the
request. The comment is corrected to say which case is which.

`reserveNextDocumentNumber` (`companySettingsService.ts:185-196`) does **not**
carry this bug — its throw is a JS throw on a usable transaction and its catch
issues no query — and `recurringTemplateLock.ts:81-86` does not either: its
catch issues no recovery statement at all.

**And the unit test could not have caught it.** The old case mocked
`client.query` with `vi.fn().mockResolvedValue(undefined)` — a client that never
rejects — so `.rejects.toBe(boom)` was the only outcome it could produce. A test
that converts "we did not check" into "we verified". It is replaced by two: one
where the claim fails as a JS throw and the restore succeeds, and one where the
restore itself rejects with 25P02, asserting the 23505 is what surfaces. Plus a
**real-connection** proof in `k107-claim-lock-timeout.int.test.ts` that drives a
genuine FK violation through `claimUnderLockTimeout` on a live pool client and
asserts `code === '23503'` and no `current transaction is aborted` in the
message.

## LOW-2 — a 55P03 answered 409 on one route where its three siblings answer 503

`pages/api/accounting/recurring-transactions-execute.ts`

`RecurringTemplateLockTimeoutError` is raised from Postgres 55P03
(`recurringTemplateLock.ts:82-85`) exactly like `DocumentNumberLockTimeoutError`,
`TimeEntryLockTimeoutError` and `DocumentClaimLockTimeoutError` — and
`src/lib/apiDocumentLock.ts` states the rule for that class in its own header:
503, never a 4xx, because a 4xx asks `withAuth` to COMMIT a transaction that
cannot commit. This route answered `apiResponse.conflict`.

No corruption: `lockRecurringTransactionTemplate` is the first statement in
`executeRecurring`, nothing is written, and `COMMIT` on an aborted transaction
returns `ROLLBACK` without error. What was lost is `Retry-After: 2` and
consistency — a client that retries every other contended write path on a 503
would not retry this one.

**Fix, in the direction the contract already documents** (one way, not both):
the class is registered in `respondIfLockTimeout`, the route's 409 branch and
its now-orphaned import are gone, and the rethrow reaches `withErrorHandler`,
which answers 503 + `Retry-After`. The class's own doc comment said "the route
may answer it with a 4xx" — corrected to match. `apiDocumentLock`'s header now
says four classes, not three.

## LOW-3 — the census SET was right; its RECORD was not

The round-8 blind review walked all of `src/` and `pages/` independently and
confirmed the set: nothing the round-8 enumeration missed. What was wrong is
what fix.md wrote down. Two defects in the record, both corrected here.

**(a) 39 was the count of CALLERS, recorded as if it were the count of posters.**
Measured at `2e0ae4f36` (`git grep -l`, `src/**` + `pages/**`, `.ts`/`.tsx`):

| Set | Count | What it is |
|---|---|---|
| `postJournalEntry(` | **39** | files that CALL it (incl. the one that defines it, `journalEntryPostingService.ts`) — the round-8 number |
| `postJournalEntry` | **58** | files that MENTION it; the extra 19 name it only in prose/comments |
| direct `gl_journal_*` writers that never mention it | **+2** | `pages/api/accounting/bank-transfers.ts`, `gl/assetDepreciationPosting.ts` |
| **ledger-writing universe (this file's r9 scope)** | **60** | INSERT-only scope: files that call `postJournalEntry` or `INSERT INTO gl_journal_*` directly |

**Round 9's 60 was itself an INSERT-only scope, not the full ledger-writing
universe.** A case-insensitive `(insert into|update) gl_journal_(entries|lines)`
over `src/**`+`pages/**` (r11 blind review) finds four more files that write the
journal tables directly and never mention `postJournalEntry` — three are
`UPDATE`, one path is reached only through comments in two other files that were
checked and excluded:

| File | Write | Guard |
|---|---|---|
| `gl/accountMergeService.ts:70` | `UPDATE gl_journal_lines SET gl_account_id` | `lockGlAccountsForUpdate` taken first (:94) — clean |
| `gl/journalEntryReversalClaim.ts:114,158` | `UPDATE gl_journal_entries SET reversed_by/at` | is itself the claim — clean |
| `pages/api/accounting/provisional/[jeId]/attach.ts:59` | `UPDATE gl_journal_entries SET source_document_id` | metadata only, no status check-then-act |
| `capture/evidenceAttachmentService.ts:102` | same | metadata only, no status check-then-act |

(`src/lib/mcp/tools/writeReclassification.ts` and
`gl/reclassification/journals.ts` match the `UPDATE gl_journal_lines` pattern
only in a doc comment describing what they deliberately do NOT do — not
counted.) None of the four is an unguarded check-then-act, so no code defect —
but the 60 above is not the full universe until these are added:

| Set | Count | What it is |
|---|---|---|
| **ledger-writing universe** | **64** | 60 (INSERT-scope) + the 4 `UPDATE`-only direct writers above |

The next census must start from **64**, and state its scope (does it include
metadata-only `UPDATE`s that never touch balance-bearing columns, or only
writes that move an amount/account/status?) rather than repeating an
unqualified count.

Enumerations at `<scratchpad>/agents/fix-k107m/{callers39,mentions58}.txt` and
`<scratchpad>/agents/fix-k107n/update-writers.txt` (this round).

**(b) 21 of those 60 appeared nowhere in this file.** The next census could not
tell whether they had been read and cleared or never read — the exact failure
that cost rounds 6 and 8. Each is read and dispositioned here.

Mention-only, and cleared — no status check-then-act ahead of a ledger write:

| File | Why not open |
|---|---|
| `pages/api/accounting/run-depreciation.ts` | Route shell; delegates to `depreciationRunService`, whose already-posted guard refuses before writing. |
| `pages/api/accounting/bank-transfers.ts` | Direct `gl_journal_*` INSERT, but it creates a NEW transfer from validated input — there is no prior status to read. |
| `gl/assetDepreciationPosting.ts` | Direct INSERT; called only through `postDualDepreciationToLedger`, guarded by `depreciationRunQueries.alreadyPosted` + `resolvePeriod`'s `status !== 'open'` refusal. |
| `src/lib/mcp/tools/bulkApprovePeriods.ts` | Read-only verdicts (`SELECT` at :99); writes nothing. |
| `afs/changesInEquityService.ts` | Reporting; the mention is a comment. No `INSERT`/`UPDATE` in the file. |
| `ap/supplierBankPaymentService.ts` | Its own `status !== 'imported'` read (:87-88) is a pre-validation OUTSIDE any lock — but `allocateTransaction` re-reads the row under `lockBankTransactionForUpdate` and refuses at `bank/bankAllocationService.ts:106-108`, so the outcome is safe. |
| `ar/receiptMatchConfirmService.ts` | Same path, same lock, same shape. |
| `ar/creditNoteCancelService.ts` | Both rows read `FOR UPDATE` (:170) before the write. |
| `gl/closeRun/closeRunProposalBuilder.ts` | Pure builder; writes nothing (its `proposal.status` read feeds a return value). |
| `gl/fiscalPeriodAutoCreate.ts` | Creates periods, posts nothing. |
| `gl/journalEntryCrudService.ts` | The canonical `createJournalEntry`; INSERTs at `draft`, so the status gate is `postJournalEntry`'s, downstream. |
| `gl/journalEntryReversalDate.ts` | Pure date resolution. |
| `gl/journalEntryService.ts` | 26-line re-export barrel. |
| `gl/periodStatusService.ts` | Read-only `SELECT status FROM fiscal_periods`. |
| `gl/recurringJournalGuards.ts` | The guards themselves — `readTemplateForUpdate` is `FOR UPDATE` (:98). |
| `gl/yearEndJournalPoster.ts` | Direct INSERT, but the entry number carries `uq_gl_je_company_entry_number` and the run refuses on 23505 (`isClosingNumberConflict`); `lockYear` reads its own row count back rather than assuming it. |
| `items/depreciationRunQueries.ts` | The guard queries (`alreadyPosted`, `alreadyInSubledger`, `resolvePeriod`). Read-only. |
| `items/depreciationRunService.ts` | Refuses before writing on a closed period and on an already-posted number; both from `depreciationRunQueries`. |
| `shared/journalPeriodVisibility.ts` | Read-only. |
| `admin/services/sageMigrationCommitService.ts` | Operator-run migration commit; `UPDATE … SET status='posted'` is keyed on the id it just INSERTed in the same call — nothing else can be racing that row. |
| `onboarding/services/tenantProvisioningService.ts` | Provisioning; posts no journal. |

### New to the register, NOT fixed here

Two of the 21 are **not** clean, and are registered rather than marked cleared —
the same grade and the same shape as `loanPaymentService.recordLoanPayment`
already carries:

| File :: symbol | Risk |
|---|---|
| `reports/vatSubmissionService.ts` :: `submitVATReturn` | **MEDIUM.** Reads `vat_returns` for a `status='submitted'` row (:219), then posts the VAT201 journal, then INSERTs the `vat_returns` row LAST (:325). `vat_returns_company_id_period_start_period_end_key` (UNIQUE on `company_id, period_start, period_end`, confirmed on the fixture schema) makes the OUTCOME safe — but **not** the way this row first said. Measured with two interleaved pool clients (r11 blind review): the loser dies earlier than the `vat_returns` INSERT, on `uq_gl_je_company_entry_number`, **inside `createJournalEntry`'s `sql.transaction` SAVEPOINT** (`gl/journalEntryCrudService.ts:244`) — so the loser's OUTER transaction is not aborted, only the savepoint unwinds, and its journal never lands. The route's `catch` calls `apiResponse.badRequestFromError` (`pages/api/accounting/vat-returns/index.ts:64`), which returns **400**, not an opaque 500 — and `withAuth` COMMITs a 4xx returned after a write, which is safe here only because nothing was written before the savepoint failed. The read is still decorative under concurrency; a refusal raised before the first posting remains the fix registered below. |
| `loans/loanPeriodCloseService.ts` :: `closeLoanPeriod` | **MEDIUM.** `isPeriodLocked(companyId, yyyymm)` read first, then a loop posting one reclassification journal per active loan, then `INSERT INTO loan_period_locks` LAST. `loan_period_locks_pkey` on `(company_id, yyyymm)` makes the outcome safe — same measured mechanism as above: the loser dies on `uq_gl_je_company_entry_number` inside `createJournalEntry`'s SAVEPOINT, not on `loan_period_locks_pkey`, so only that one journal's savepoint unwinds. The route has no `catch` around this call, so an uncaught error still reaches the framework 500 → `withAuth` ROLLBACKs the whole outer transaction — that is what keeps loans 1..N-1's already-posted journals from stranding today. If a future round wraps this route in a `catch` that answers a 4xx (the same shape LOW-2 just removed from the recurring-execute route, and the same shape this row's VAT sibling has), loans 1..N-1's journals would COMMIT live while loan N is refused — safe today is conditional on the route staying catch-less, not on the unique key. |

Both belong to the same class the round-8 fix applied to `applyTaxDirective`:
take the claim FIRST, then post. Registered for a later round, not fixed here —
this round is the closing round for the LOWs the r9 review raised, and neither
of these is one of them.

## Round 9 files

- `src/modules/accounting/services/core/documentClaimLock.ts` — guarded recovery, corrected comment.
- `src/lib/apiDocumentLock.ts` — `RecurringTemplateLockTimeoutError` registered; header says four.
- `src/modules/accounting/services/core/recurringTemplateLock.ts` — the class's doc comment corrected to 503.
- `pages/api/accounting/recurring-transactions-execute.ts` — 409 branch and orphaned import removed.
- `docs/audits/remediation/K-107/fix.md` — the two classifier rows, and this section.

## Round 9 tests

- `tests/unit/services/core/documentClaimLock.test.ts` — the un-failable case replaced by two: a JS throw where the restore succeeds, and a 25P02 rejection of the restore where the 23505 must survive.
- `tests/integration/k107-claim-lock-timeout.int.test.ts` (+1) — the same, on a REAL connection, driving a genuine FK violation.
- `tests/unit/lib/apiDocumentLock.test.ts` (+1 case) — `RecurringTemplateLockTimeoutError` → 503 + `Retry-After: 2`.
- `tests/unit/api/recurringExecuteNo4xxAfterWrite.test.ts` — the 409 assertion replaced by "rethrows, answers nothing".

## Round 9 mutation proof (file copies in `<scratchpad>/agents/fix-k107m`, restored; `git diff --stat -- src pages` clean after)

| # | Production line reverted | Went RED |
|---|---|---|
| M1 | the `try`/`catch` around the recovery removed | `documentClaimLock.test.ts` — `Expected "23505" / Received "25P02"` (1 failed / 4 passed) |
| M2 | the 409 branch re-added to the execute route | `recurringExecuteNo4xxAfterWrite` — the rethrow assertion (1 failed / 5 passed) |
| M3 | `RecurringTemplateLockTimeoutError` unregistered from `respondIfLockTimeout` | `apiDocumentLock.test.ts` — returned false, no 503 (1 failed / 4 passed) |
| M4 | M1 again, against the integration test | `k107-claim-lock-timeout.int.test.ts` — `Received "25P02"`, and the message matched `/current transaction is aborted/` |

## Round 9 migration

**None.** No schema change; the two newly registered sites lean on indexes that
already exist (`vat_returns_company_id_period_start_period_end_key`,
`loan_period_locks_pkey`).

## Round 9 historical impact

**None to correct.** LOW-1 changed which error text an operator sees on a failed
claim — no row was ever written differently. LOW-2 changed a status code on a
path that had written nothing when it fired. The two newly registered MEDIUMs
are index-protected, so no duplicate VAT201 journal and no duplicate loan
reclassification can exist from them; the pre-existing rule holds that whether
any tenant has one from some OTHER cause is a data question this branch does not
answer.

## Round 10 — documentation only, no production code touched

The r11 blind review scored `610bb7659` at 0 HIGH / 0 MEDIUM / 1 LOW
(documentation only) and stated code is DONE. This round closes that LOW and
one prose error the same review flagged, plus records the missing
integration-suite measurement for `610bb7659`. No file under `src/` or `pages/`
changed.

**LOW-1 closed.** §LOW-3(a) above now states the census was an INSERT-only
scope (60) and adds the 4 `UPDATE`-only direct writers the r11 review found
(`accountMergeService.ts`, `journalEntryReversalClaim.ts`,
`provisional/[jeId]/attach.ts`, `evidenceAttachmentService.ts`) — universe now
**64**, scope stated explicitly so the next census doesn't repeat an unqualified
count. All four re-confirmed clean (lock held first, or is itself the claim, or
metadata-only). Grep re-run this round (`(insert into|update)
gl_journal_(entries|lines)`, case-insensitive) independently reproduces the same
4 files; `writeReclassification.ts` and `reclassification/journals.ts` confirmed
to match in a doc comment only, not code.

**Wording error fixed.** The §LOW-3(b) row for `ap/supplierBankPaymentService.ts`
said its `status !== 'imported'` read is "inside that lock" — false; the read at
`:87-88` is a pre-validation outside any lock. Corrected to point at the actual
safety mechanism: `allocateTransaction` re-reads under
`lockBankTransactionForUpdate` and refuses at
`bank/bankAllocationService.ts:106-108`.

**R-061 / R-062 mechanism corrected.** Both rows said the loser "23505s" and
"aborts its transaction" on the sites' own unique keys
(`vat_returns_company_id_period_start_period_end_key`,
`loan_period_locks_pkey`). Measured with two interleaved pool clients: the loser
actually dies earlier, on `uq_gl_je_company_entry_number`, inside
`createJournalEntry`'s `sql.transaction` SAVEPOINT
(`gl/journalEntryCrudService.ts:244`) — so only the savepoint unwinds, not the
outer transaction. For VAT this means the route's `badRequestFromError`
(`vat-returns/index.ts:64`) returns a real **400** that `withAuth` COMMITs, not
an opaque 500. For the loan close, safety today depends on the route having no
`catch` (uncaught error → framework 500 → `withAuth` ROLLBACKs everything); a
future `catch`-and-4xx on that route would strand loans 1..N-1's journals live.
Both rows now state the measured mechanism and this conditional. R-061/R-062
themselves stay registered; the R-register text is the orchestrator's to
correct, not this file's job beyond matching it.

**Integration suite — the r11 measurement that was never recorded.** r11's
review left `INTEGRATION_PLACEHOLDER` — its run never finished. Re-run this
round in the foreground against `610bb7659` (unchanged tip; this round is
docs-only, no recompile needed). `uptime` showed load average 35–50 (many
concurrent agents on this box), so the suite was run TWICE in full to check
for load-induced noise, plus the odd-looking failures were re-run alone:

```
source <scratchpad>/fixture.env && bunx vitest run --config vitest.integration.config.ts --no-file-parallelism
# Run 1 (09:17): Test Files 33 failed | 194 passed (227)  Tests 16 failed | 1063 passed | 168 skipped (1247)
# Run 2 (09:22): Test Files 33 failed | 194 passed (227)  Tests 16 failed | 1063 passed | 168 skipped (1247)
```

Both runs agree on the final tallies: **16 failed / 1063 passed / 168 skipped**,
matching the count prior rounds recorded. Under this load, well over 16 files
throw a setup-time error (connection resets / FK-constraint races from
concurrent fixture writers) during the run, but by the end only 16 tests remain
failed in both independent runs — those transient file-level crashes are noise
from the shared box, not new failures; `grep` of both full logs for
`k107|k120|k121|documentClaimLock|recurringTemplateLock|apiDocumentLock`
against `^ FAIL ` lines returns nothing in either run.

Re-ran the four odd-looking names the r11 reviewer flagged, alone, together
(`--no-file-parallelism`, unaffected by the other agents' load once isolated to
5 files):

```
tests/integration/k019-import-autolink-double-bind.int.test.ts
tests/integration/k019-transfer-relink-double-bind.int.test.ts
tests/integration/k-035-webhook-redelivery-discarded.int.test.ts
tests/integration/opening-balances-postgres.int.test.ts
tests/integration/financialFiguresScoping.int.test.ts
Test Files  5 failed (5)   Tests  9 failed | 36 passed (45)
```

All 5 fail alone too — not a parallelism artifact. `git diff 9cbb75393
610bb7659 --stat` over exactly these 5 files is **empty**: byte-identical to
merge-base, so the branch changed nothing in them. All settle as pre-existing,
unrelated to K-107/K-120/K-121:
- `k019-*-double-bind.int.test.ts` (×2), `opening-balances-postgres.int.test.ts`:
  fixture-data race — `insert or update on table "gl_journal_lines" violates
  foreign key constraint "gl_journal_lines_account_company_fk"` — a seeded
  cross-company account reference the fixture setup itself creates, not a
  behaviour the K-107/120/121 branch touches.
- `k-035-webhook-redelivery-discarded.int.test.ts`: pre-existing webhook
  idempotency assertion failure (`expected 'completed' to be 'pending'`),
  unrelated module.
- `financialFiguresScoping.int.test.ts`: pre-existing Brightsphere data-defect
  pin (fix.md elsewhere documents this as a known, tracked data issue, not a
  code defect).

### Round 10 files

- `docs/audits/remediation/K-107/fix.md` — this section, the LOW-1 census
  correction, the supplierBankPaymentService wording fix, and the R-061/R-062
  mechanism correction.

### Round 10 tests / mutation

None — no production code changed, so nothing to mutate.

### Round 10 migration

None.

### Round 10 historical impact

None — no code changed.
