# K-013 — fix

**Trigger.** `generateInvoiceFromRecurring` INSERTed a `customer_invoices` header at
`status='approved'` directly, wrote no `customer_invoice_items`, posted no journal, and then
advanced the schedule. Every recurring run left a receivable in AR with `gl_journal_entry_id`
NULL and no detail behind it. The schedule UPDATE was also keyed on `id` alone.

**Before.** approved header, 0 line items, 0 journals, schedule advanced regardless.
**After.** header inserted at `'draft'`, one `customer_invoice_items` row per template line, then
`approveCustomerInvoice` — the canonical path that runs the status CAS, posts DR AR / CR Revenue /
CR VAT Output and seals the PDF. The schedule advances only after that returns, and its UPDATE now
carries `AND company_id`. A template with zero lines is refused before anything is written.
Header + lines + approve run inside one `withSavepoint('recurring_invoice_gen')`, because the batch
runner (`recurring-invoices-run.ts:89`) catches per template and carries on inside the shared
request transaction: without it a failed template's half-built invoice would be COMMITted on the
route's 200, and the caught Postgres error would poison every later item with 25P02.

**Files.** `src/modules/accounting/services/ar/recurringInvoiceService.ts` (only production file).

**Tests.** `tests/integration/k013-recurring-invoice-no-lines-no-gl.int.test.ts` — 4 tests, real
Postgres (disposable fixture DB), all passing. Covers: lines written and journal posted, journal
balanced with the receivable leg equal to the invoice total (1150) and revenue/VAT legs at
1000/150, schedule advanced once; empty template refused with the schedule untouched; another
tenant cannot run the template; a failure at approval rolls the header and its lines back inside a
real request transaction that stays usable. Mutation-proof: see `green.log` (M1/M2/M3).

**Migration.** None. **Rollback.** Revert the commit; no schema or data change.

**Historical-data impact.** Existing invoices minted by past recurring runs are still in AR with no
journal and no lines. Read-only probe:
```sql
SELECT ci.company_id, count(*) AS invoices, sum(ci.total_amount) AS receivable
FROM customer_invoices ci
WHERE ci.gl_journal_entry_id IS NULL
  AND ci.status IN ('approved','sent','partially_paid','paid')
  AND NOT EXISTS (SELECT 1 FROM customer_invoice_items i WHERE i.invoice_id = ci.id)
GROUP BY 1 ORDER BY 3 DESC;
```
Back-posting those journals is a separate exercise: it must use each invoice's own date and period,
and VAT output landing in closed VAT periods needs a decision before any write.

**Limits.** Not fixed here: the batch runner still reports per-template failures only in an
`errors[]` array on a 200 response. Routing through the canonical path means a run now fails when
the fiscal period is closed or a system account is unmapped, where it previously "succeeded"
silently — that is the intended behaviour change and callers will start seeing those errors.
