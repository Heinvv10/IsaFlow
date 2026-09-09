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
from past double-runs are not cleaned up by this change — count them read-only with:
```sql
SELECT company_id, supplier_id, invoice_date, total_amount, count(*)
FROM supplier_invoices
WHERE reference = 'AUTO-REC' AND deleted_at IS NULL
GROUP BY 1,2,3,4 HAVING count(*) > 1;
```
