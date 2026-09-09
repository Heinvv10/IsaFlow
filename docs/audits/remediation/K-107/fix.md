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
number and two suppliers issuing `INV-001` is ordinary. FAIL-CLOSED — it will not build over
existing duplicates. Rollback: `DROP INDEX uq_supplier_invoices_supplier_number;`.

**Historical impact.** Daily/weekly AP templates already duplicated bills. Read-only probe
(NOT run against production):
```sql
SELECT company_id, supplier_id, invoice_number, count(*), sum(total_amount)
FROM supplier_invoices
WHERE deleted_at IS NULL AND invoice_number LIKE 'RSINV-%'
GROUP BY 1,2,3 HAVING count(*) > 1;
```
Clean these before applying 646. Monthly/quarterly templates are unaffected.

**Limits.** Existing `RINV-<slug>-<YYYYMM>` and `RSINV-…` rows are left alone; only new runs use
the sequence. The company `recurring_invoice` counter starts at its seed, so it may sit below
legacy numbers — the AR retry loop absorbs that, the AP path will refuse and needs a manual
counter bump.
