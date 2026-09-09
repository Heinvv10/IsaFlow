# K-107 — recurring invoice numbers were constant for a calendar month

**Trigger.** `recurringTransactionService.executeRecurring` built the number as
`RINV-<name-slug>-<YYYYMM>` (customer) and `RSINV-<name-slug>-<YYYYMM>` (supplier) from
`new Date().toISOString().slice(0,7)`. A daily or weekly template therefore minted the SAME
number on every run inside a month.

**Before / after.**
- Customer side: second run of the month hit `uq_customer_invoices_company_number` and 500'd.
  Now the number comes from `reserveNextDocumentNumber(companyId, 'recurring_invoice')` (prefix
  `RINV`, the existing configured sequence), with a savepointed 23505 retry for a clash with a
  legacy number.
- Supplier side: no unique index existed, so every run minted an identical bill — same
  `invoice_number`, same `duplicate_fingerprint` — inflating payables and input VAT. Now the
  number comes from the `supplier_invoice` sequence, and migration 646 makes a repeat fail loudly.
  Deliberately no retry there: on AP a clash means the bill is already captured.

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
the sequence. The AR branch mints from `customer_invoice`, the same sequence every other writer of
that table uses, so the seeded `recurring_invoice` document type (prefix `RINV`) is now unused by
this runner — left in place, not deleted.
