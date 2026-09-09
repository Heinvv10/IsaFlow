# K-120 — sales-order and recurring invoice numbering bypassed the company sequence

**Trigger.** `salesOrderWorkflowService.convertSalesOrderToInvoice` and
`recurringInvoiceService.runOneTemplate` each minted their own number from
`MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)) + 1`, padded to 5. The company
sequence (`company_document_numbers`, padding 7) never advanced, so the counter shown in company
settings sat permanently behind live invoice numbers and two formats existed for one document type
inside one uniqueness domain (`uq_customer_invoices_company_number`).

**Before / after.** Both paths now call `reserveNextDocumentNumber(companyId, 'customer_invoice')`,
the same generator `customerInvoiceCreateService` and `quoteConvertService.convertToInvoice` use.
The sales-order path wraps its INSERT in `withSavepoint` with a 23505 retry (5 attempts, reserving
a fresh number each time) so a clash with a legacy `INV-00001`-style number costs one number
instead of poisoning the request transaction. The recurring path is already inside the template's
savepoint.

**Files.** `src/modules/accounting/services/ar/salesOrderWorkflowService.ts`,
`src/modules/accounting/services/ar/recurringInvoiceService.ts`.

**Tests.** `tests/integration/k120-invoice-numbering-bypasses-sequence.int.test.ts` (2),
`tests/integration/k120-invoice-sequence-adjacent.int.test.ts` (3 — two consecutive numbers with
the other tenant's counter untouched, retry past a legacy-held number without poisoning the
transaction, recurring runner on the same sequence),
`tests/integration/k120-invoice-number-concurrency.int.test.ts` (1 — two open transactions on two
pool clients). Mutation proof in `green.log` (M2, M3, M7).

**Migration.** None.

**Historical impact.** Numbers already minted stay valid and unique per company. The live risk is
a counter now sitting BELOW existing numbers, which the retry loop absorbs but which wastes
numbers. Read-only probe (NOT run against production):
```sql
SELECT ci.company_id,
       MAX(CAST(SUBSTRING(ci.invoice_number FROM '[0-9]+$') AS INTEGER)) AS max_used,
       d.next_number
FROM customer_invoices ci
JOIN company_document_numbers d
  ON d.company_id = ci.company_id AND d.document_type = 'customer_invoice'
WHERE ci.invoice_number ~ '^INV-?[0-9]+$'
GROUP BY ci.company_id, d.next_number
HAVING MAX(CAST(SUBSTRING(ci.invoice_number FROM '[0-9]+$') AS INTEGER)) >= d.next_number;
```
Advance `next_number` past `max_used` once per affected company.

**Concurrency, now proven.** The original validation could not demonstrate the race because the
harness serialised both conversions on one pooled connection. Two clients in two open transactions
show the real behaviour: `reserveNextDocumentNumber`'s `UPDATE ... RETURNING` takes a row lock, so
the second reservation BLOCKS for as long as the first transaction stays open and then takes the
next number. The concurrent collision is closed outright, not retried past; the retry loop exists
only for a clash with a number some legacy row already holds.

**Limits.** Both paths now hold the `company_document_numbers` row lock for the rest of the
request, where the old `MAX()` read blocked nothing. This matches what `customerInvoiceCreateService`
already did, so it is consistent rather than novel — but it serialises conversions per company, and
a future bulk-conversion feature has to account for that.

**Shared helper.** The reserve-and-retry loop lives in
`src/modules/accounting/services/core/documentNumberRetry.ts`, used by both paths here and by the
recurring-transaction runner (K-107), rather than copied three times.
