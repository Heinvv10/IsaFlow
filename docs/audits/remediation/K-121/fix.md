# K-121 — convertToSalesOrder had no status guard

**Trigger.** `quoteConvertService.convertToSalesOrder` checked only that the quote existed. A
double-click or a client retry reserved a second SO number, inserted a full duplicate order with
every line, and overwrote `converted_order_id` so the quote pointed only at the second order. Its
sibling `convertToInvoice` was already self-limiting on `status !== 'accepted'`.

**Before / after.** The terminal status write became the guard and moved BEFORE anything is
minted, predicated on an ALLOW-LIST of convertible statuses:
```sql
UPDATE customer_quotes SET status = 'converted_to_order', updated_at = NOW()
WHERE id = $1 AND company_id = $2 AND status = ANY(ARRAY['accepted','sent']) RETURNING id
```
Zero rows returned raises `QuoteNotConvertibleError`, carrying the current status and any existing
order id, before the sequence is touched and before any status is rewritten. The later write now
only sets `converted_order_id`.

**Why an allow-list.** `customer_quotes_status_check` permits draft, sent, accepted, rejected,
declined, expired, converted and converted_to_order, so a "not already converted_to_order" guard
still let six of the eight through. The dangerous one is `converted` — a quote already turned into
an INVOICE. Converting it to an order silently rewrote its status, so the invoiced state vanished
from the quote while `converted_invoice_id` still pointed at the invoice, and that order could be
confirmed and invoiced again: the same quote billed twice.

**Files.** `src/modules/accounting/services/ar/quoteConvertService.ts`.

**Tests.** `tests/integration/k121-quote-convert-to-order-no-status-guard.int.test.ts` (1 — the
second call is refused with the first call's order id, exactly one order exists),
`tests/integration/k121-quote-convert-adjacent.int.test.ts` (2 — two concurrent conversions produce
exactly one sales order and one refusal; a conversion asked for under the wrong tenant writes
nothing), `tests/integration/k121-quote-convert-status-allowlist.int.test.ts` (9 — every refused
status keeps its own status and creates no order, both allowed statuses convert once, and an
invoiced quote keeps its invoice link). Mutation proof in `green.log` (M1, M6).

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
`convert-to-order` (the validation note named a non-existent path). A missing quote is still 404; a
refusal is now 409 carrying `quoteStatus` and the existing `salesOrderId`. Nothing is written
before the guard refuses, so a 4xx here commits no partial work. The quotes list page navigates to
that order on a 409 instead of alerting the user that their quote does not exist.

**Limits.** Any UI that re-POSTs the conversion to "refresh" an order now gets a 409 rather than a
duplicate order. The guard does not clean up orders already duplicated, and it does not repair a
quote whose invoiced status was already overwritten — the probe above finds those.
