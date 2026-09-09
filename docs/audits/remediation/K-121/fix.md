# K-121 — convertToSalesOrder had no status guard

**Trigger.** `quoteConvertService.convertToSalesOrder` checked only that the quote existed. A
double-click or a client retry reserved a second SO number, inserted a full duplicate order with
every line, and overwrote `converted_order_id` so the quote pointed only at the second order. Its
sibling `convertToInvoice` was already self-limiting on `status !== 'accepted'`.

**Before / after.** The terminal status write became the guard and moved BEFORE anything is
minted:
```sql
UPDATE customer_quotes SET status = 'converted_to_order', updated_at = NOW()
WHERE id = $1 AND company_id = $2 AND status <> 'converted_to_order' RETURNING id
```
Zero rows returned means another caller already claimed the quote, and the function returns null
before the sequence is touched. The later write now only sets `converted_order_id`.

**Files.** `src/modules/accounting/services/ar/quoteConvertService.ts`.

**Tests.** `tests/integration/k121-quote-convert-to-order-no-status-guard.int.test.ts` (1 — second
call returns null, exactly one order, converted_order_id points at it),
`tests/integration/k121-quote-convert-adjacent.int.test.ts` (2 — two concurrent conversions
produce exactly one sales order; a conversion asked for under the wrong tenant writes nothing and
leaves the quote 'accepted'). Mutation proof in `green.log` (M1).

**Migration.** None.

**Historical impact.** Duplicate sales orders may already exist. Read-only probe (NOT run against
production):
```sql
SELECT so.company_id, so.reference AS quote_number, count(*) AS orders
FROM customer_sales_orders so
JOIN customer_quotes q ON q.company_id = so.company_id AND q.quote_number = so.reference
GROUP BY so.company_id, so.reference HAVING count(*) > 1;
```
Cross-check `customer_sales_orders.invoice_id IS NOT NULL` on the duplicates: a duplicate that was
itself invoiced billed the customer twice.

**Caller.** The only route is `pages/api/accounting/customer-quotes-action.ts`, action
`convert-to-order` (the validation note named a non-existent path). It maps null to 404, which now
also covers "already converted"; its resource label became `Unconverted quote` so a double-click
does not read as a missing record.

**Limits.** Any UI that re-POSTs the conversion to "refresh" an order now receives that 404
instead of a duplicate order. The guard does not clean up orders already duplicated.
