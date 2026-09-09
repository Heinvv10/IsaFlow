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
