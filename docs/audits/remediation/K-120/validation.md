# K-120 — recurring and sales-order invoice numbering bypasses the company sequence

Baseline: origin/master `31fc2f1062d228f6ebf43049338ecb41767002d0`. Files unchanged 5661d6f0..origin/master.

**Claim.** Both paths build their own number instead of using the company sequence, so numbers
collide with normal invoices.

**Corrected trigger.** Two generators share one uniqueness domain
(`uq_customer_invoices_company_number`), but they do NOT collide by string: the sequence pads to 7
(`ensureDocumentNumbers`, companySettingsService.ts:52) while both MAX() paths pad to 5. What is
reproduced is that the company's configured counter never advances and the two paths mint different
formats for the same document type, so the number shown in company settings is wrong and invoice
numbering drifts permanently. The 23505 half of the claim was NOT reproduced (see Risks).

**Disposition: confirmed** (sequence bypass + format divergence).

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ar/salesOrderWorkflowService.ts` :40-45 —
  `MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)) + 1`, 5-pad, no savepoint, no 23505 retry.
- `recurringInvoiceService.ts` :182-187 — same shape (`LIKE 'INV-%'` instead of the regex).
- `customerInvoiceCreateService.ts:121` and `quoteConvertService.ts:93` use
  `reserveNextDocumentNumber(companyId, 'customer_invoice')` with a savepointed 23505 retry.
- RED: `tests/integration/k120-invoice-numbering-bypasses-sequence.int.test.ts` — 1 failed, 1 passed.
  `next_number` stays 1 after a conversion (expected 2); minted `INV-00001` vs sequence `INV-0000001`.

**Reachability.** `pages/api/accounting/sales-orders/[id]/invoice.ts` and the recurring run
endpoint, both under `withAuth`. No status or feature gate.

**Proposed minimal fix (3 files).**
1. `salesOrderWorkflowService.ts`: replace the MAX() block with
   `reserveNextDocumentNumber(companyId, 'customer_invoice')`, wrapping the INSERT in the same
   `withSavepoint` + 23505-retry loop as `quoteConvertService.convertToInvoice`.
2. `recurringInvoiceService.ts`: same replacement; it is already inside `withSavepoint`, so it
   needs the retry loop only.
3. No migration. Leave existing INV-xxxxx rows alone; the sequence should be advanced past the
   highest existing number once per company at fix time.

**Historical-data impact.** Numbers already minted stay valid (unique per company). The risk is the
counter now sitting BELOW live invoice numbers, so the first sequence-based create after the fix
can clash. Read-only check per company:
```sql
SELECT ci.company_id, MAX(CAST(SUBSTRING(ci.invoice_number FROM '[0-9]+$') AS INTEGER)) AS max_used,
       d.next_number
FROM customer_invoices ci
JOIN company_document_numbers d
  ON d.company_id = ci.company_id AND d.document_type = 'customer_invoice'
WHERE ci.invoice_number ~ '^INV-?[0-9]+$'
GROUP BY ci.company_id, d.next_number
HAVING MAX(CAST(SUBSTRING(ci.invoice_number FROM '[0-9]+$') AS INTEGER)) >= d.next_number;
```

**Risks.** The concurrent-23505 path could not be demonstrated: the integration harness serialises
both conversions on one pooled connection, so the second MAX() already sees the first INSERT. The
race remains plausible across separate requests but is unproven here.
