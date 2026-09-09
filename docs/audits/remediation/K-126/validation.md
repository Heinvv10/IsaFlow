# K-126 — invoice PDF derives every line's VAT from a header rate

Baseline: origin/master `31fc2f1062d228f6ebf43049338ecb41767002d0`.

**Claim (candidate JSON).** "Conversions never populate the header VAT rate, so every line's VAT
prints as zero."

**Corrected trigger.** The stated symptom is wrong and is refuted by the schema:
`customer_invoices.tax_rate` has DEFAULT 15.00, so an unset header rate falls back to 15, not 0 —
and `invoicePdfBuilder.ts:141` additionally reads `Number(inv.tax_rate || 15)`. Nothing prints as
zero. The real defect is the opposite: the PDF applies ONE header rate to EVERY line and ignores
`customer_invoice_items.tax_rate`, which both conversion paths do populate per line. A part
zero-rated invoice therefore prints 15% VAT against a zero-rated line and the VAT column no longer
foots to the totals block. That is an incorrect SARS tax invoice.

**Disposition: confirmed** (on the corrected trigger).

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ar/invoicePdfBuilder.ts` :141-155.
- Per-line rates ARE written: quoteConvertService.ts:122-127, salesOrderWorkflowService.ts:63-72.
  Neither writes the header `tax_rate`; recurringInvoiceService.ts:214 writes a single header rate.
- RED: `tests/integration/k126-invoice-pdf-line-vat-header-rate.int.test.ts` — 1 failed
  (2 assertions). Invoice with a R100 @15% line and a R100 @0% line, header `tax_amount` R15:
  the extracted PDF text shows `R 15.00` in the VAT cell of BOTH lines, so the column sums to
  R30 against a R15 totals block.

**Reachability.** `pages/api/accounting/ar/invoice/[id]/pdf.ts` and the customer-facing
`pages/api/portal/invoice/[token]/pdf.ts`; also sealed by `invoicePdfSnapshotService.ts`.

**Proposed minimal fix (1 file).**
Replace `const invTaxRate = Number(inv.tax_rate || 15)` with a per-row read:
`const rate = item.tax_rate != null ? Number(item.tax_rate) : Number(inv.tax_rate ?? 15)`, and
compute `lineVat` from it. Label the totals row 'VAT' rather than 'VAT (15%)' when the lines carry
more than one distinct rate.

**Historical-data impact.** No stored row is wrong — `tax_amount` on the header is correct and the
GL is posted from it. The damage is in documents already sent and in any sealed snapshot:
```sql
SELECT ci.company_id, count(DISTINCT ci.id) AS mixed_rate_invoices
FROM customer_invoices ci JOIN customer_invoice_items it ON it.invoice_id = ci.id
GROUP BY ci.company_id, ci.id HAVING count(DISTINCT it.tax_rate) > 1;
```
Those invoices were issued with an overstated per-line VAT column and may need reissue.

**Risks.** Snapshot hashes change for any invoice re-rendered after the fix; `invoicePdfSnapshotService`
treats a snapshot as sealed evidence, so re-sealing must be a deliberate, separate decision.
