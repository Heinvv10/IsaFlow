# K-126 — invoice PDF prints each line's own VAT rate

**Trigger.** The candidate claim ("every line's VAT prints as zero") is refuted by the schema:
`customer_invoices.tax_rate` defaults to 15.00 and the builder read `Number(inv.tax_rate || 15)`.
The real defect is the mirror image, confirmed in validation.md: `invoicePdfBuilder.ts` applied ONE
header rate to EVERY line and ignored `customer_invoice_items.tax_rate`, which both conversion
paths (quoteConvertService, salesOrderWorkflowService) populate per line. A part zero-rated
invoice printed 15% VAT against the zero-rated line, so the VAT column no longer footed to the
tax_amount in the totals block — an incorrect SARS tax invoice.

**Before / after.** Before: line VAT = line amount x header rate, totals label always `VAT (n%)`.
After: line VAT = line amount x that line's `tax_rate`, falling back to the header rate when the
line carries none; the totals label drops the percentage to plain `VAT` when the lines carry more
than one distinct rate, because `VAT (15%)` is a false statement about a mixed-rate invoice.

**Files.** `src/modules/accounting/services/ar/invoicePdfBuilder.ts` (1 file, no new imports).
The `|| 15` -> `?? 15` on the header rate is defensive only: pg returns `numeric(5,2)` as the
string `'0.00'`, which is truthy, so the two operators are equivalent today. It is pinned by a
characterisation test rather than a red-on-master one.

**Tests.** `tests/integration/k126-invoice-pdf-line-vat-header-rate.int.test.ts` — 5 tests on real
Postgres, driving `generateInvoicePdf` and parsing the emitted content stream. Mixed-rate column
and its footing, mixed-rate totals label, legacy lines with no rate falling back to the header,
a header rate of zero staying zero, and a second tenant refused. Mutation proof: reverting the
production change turns tests 1 and 2 red; reverting only `?? 15` to `|| 15` changes nothing,
which is why that half is documented as defensive.

**Migration.** None. No schema or data change.

**Historical-data impact.** No stored row is wrong: the header `tax_amount` is correct and the GL
is posted from it. The damage is confined to documents already rendered and to sealed snapshots.
Read-only impact query (do not run against production without approval):
```sql
SELECT ci.company_id, ci.id, count(DISTINCT it.tax_rate) AS distinct_rates
FROM customer_invoices ci JOIN customer_invoice_items it ON it.invoice_id = ci.id
GROUP BY ci.company_id, ci.id HAVING count(DISTINCT it.tax_rate) > 1;
```
Those invoices were issued with an overstated per-line VAT column and may need reissue.

**Limits.** `invoicePdfSnapshotService` treats a sealed snapshot as evidence; snapshots sealed
before this fix keep the wrong column and are not rewritten here. Re-sealing is a separate,
deliberate decision. The totals block itself was always correct and is unchanged.
