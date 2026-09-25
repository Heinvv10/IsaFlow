# R-053 residual — archive step 6 vs the NO ACTION FKs

**Status:** not built. It needs Hein's design decision (below).
**Measured:** 2026-09-25 on origin/master `4faf25ed7`, using the disposable fixture. Production was not queried. See `red.log`.

## What was measured

- **The service.** `executeArchive` (`core/archiveExecutionService.ts`, step 6) still fails with
  `23503 customer_payment_allocations_invoice_id_fkey` for a company that has one settled invoice.
  `k071-archive-delete-order.int.test.ts` "R-053 residual" passes, and that test is shaped to pass
  only while the defect is present. A PAID invoice always has an allocation row, because the
  allocation is what made it paid. So the archive cannot finish for any company that has real
  settled data.
- **The route.** The failure cannot be reached through any route. `POST /api/accounting/data-archiving`
  has answered 403 for every role since 2026-09-24 (#506, `820f3c5b0`, switched off by Hein) and
  never calls the service. `tests/unit/api/dataArchivingExecuteDisabled.test.ts` pins that 3/3.
  `executeArchive` has no other caller in `pages/`, `src/` or `scripts/`. A red test through the
  real route is therefore impossible. The only red is the service-level test above.
- **The FK count.** The fixture has **37** NO ACTION FKs into the five relations step 6 deletes, not
  38. R-101's migration 694 made the Sage staging link `ON DELETE SET NULL`. By parent:
  - `gl_journal_entries`: 25
  - `customer_invoices`: 6
  - `supplier_invoices`: 3
  - `gl_journal_lines`: 2
  - `bank_transactions`: 1

  The full list is in `red.log`. The children include `customer_payments`, `supplier_payments`, both
  allocation tables, `credit_notes`, `vat_returns`, `vat_adjustments`, `payroll_run_headers`,
  `tax_directive_payments`, `loan_payments`, `asset_disposals`, `intercompany_transactions` and
  `customer_write_offs`.

## Why this is not a code fix

The goal named two options: fix the delete order and delete the dependent rows, or refuse the
blocked sets up front. Neither is decidable in code.

1. **Delete the dependent rows.** The archive would widen from 5 relations to about 30. It would
   then delete payments, allocations, credit notes, VAT returns, payroll run headers and tax-directive
   payments before the cutoff. None of these has an `archive_*` table. And #506 switched archiving
   off because no report reads the archive tables at all, so every pre-cutoff trial balance, balance
   sheet and VAT201 would change. Deleting 25 more kinds of financial record makes that worse. It is
   a retention and report-continuity design, not a delete order.
2. **Refuse blocked sets up front.** This is safe, but on real books it archives almost nothing:
   - every paid invoice has an allocation;
   - every posted payment journal has a payment row;
   - every VAT-return journal has a `vat_returns` row.

   It would also re-enable a feature that is off for a different and still-open reason.

Either way, the fix only matters once archiving is re-enabled. Re-enabling it needs the design #506
asked for, for example closing-balance roll-forward journals written before the delete. That design
decides which records leave the live tables, and that in turn decides what step 6 must delete or
refuse. Building either option now would build against a design that does not exist yet.

## Question for Hein

Should archiving stay off, with R-053's residual folded into the archive redesign (roll-forward
journals + which record kinds may leave the live tables)? **Recommended: yes.** The residual is then
closed by the redesign's own work, not built now. A decision to re-enable archiving soon would change
this recommendation. That would make "refuse blocked sets up front" worth building first as a cheap
safe guard.

## Census SQL for Hein (read-only, production; never run from here)

```sql
-- 1. Has any archive run ever completed, or even been attempted? (Expected: none completed.)
SELECT company_id, status, count(*), min(started_at), max(started_at)
FROM archive_runs GROUP BY 1, 2 ORDER BY 1, 2;

-- 2. Rows sitting in archive tables (expected zero; non-zero means history left the live ledger).
SELECT 'je' AS t, count(*) FROM archive_gl_journal_entries
UNION ALL SELECT 'ci', count(*) FROM archive_customer_invoices
UNION ALL SELECT 'si', count(*) FROM archive_supplier_invoices
UNION ALL SELECT 'jl', count(*) FROM archive_gl_journal_lines
UNION ALL SELECT 'bt', count(*) FROM archive_bank_transactions;
```
