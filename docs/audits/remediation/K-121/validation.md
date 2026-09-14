# K-121 — convertToSalesOrder has no status guard

Baseline: origin/master `31fc2f1062d228f6ebf43049338ecb41767002d0`.

**Claim.** A quote can be converted repeatedly and regardless of status, creating duplicate sales orders.

**Corrected trigger.** Confirmed as written. quoteConvertService.ts:29-31 checks only that the quote
exists; its sibling `convertToInvoice` (:84) returns null unless `status === 'accepted'` and is
therefore self-limiting. Each call reserves a new SO number from the company sequence, inserts a
full duplicate order with all lines, and overwrites `converted_order_id`.

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ar/quoteConvertService.ts` :24-76.
- RED: `tests/integration/k121-quote-convert-to-order-no-status-guard.int.test.ts` — 1 failed
  (3 assertions): 2 sales orders exist after two calls, `converted_order_id` points at the second,
  and the second call returned a result instead of null. Order status was 'draft' then
  'converted_to_order' — neither is refused.

**Reachability.** `pages/api/accounting/quotes/[id]/convert-to-order.ts` under `withAuth`. A
double-click or a client retry is enough; no concurrency needed.

**Proposed minimal fix (1 file).**
In `convertToSalesOrder`, after `getQuote`, mirror `convertToInvoice`: return null unless the
quote's status is convertible, and make the terminal write the guard —
`UPDATE customer_quotes SET status='converted_to_order', converted_order_id=... WHERE id=... AND
company_id=... AND status <> 'converted_to_order' RETURNING id`, moved BEFORE the order INSERT so a
zero-row result short-circuits. That closes both the repeat call and the double-click.

**Historical-data impact.** Duplicate sales orders may already exist. Read-only:
```sql
SELECT so.company_id, so.reference AS quote_number, count(*) AS orders
FROM customer_sales_orders so
JOIN customer_quotes q ON q.company_id = so.company_id AND q.quote_number = so.reference
GROUP BY so.company_id, so.reference HAVING count(*) > 1;
```
A duplicate that was itself invoiced bills the customer twice; cross-check
`customer_sales_orders.invoice_id IS NOT NULL` on the duplicates.

**Risks.** Any UI that re-POSTs conversion to "refresh" an order would start receiving null. Grep
of callers shows one route only, so the blast radius is that route's error handling.
