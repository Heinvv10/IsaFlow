# K-093 — sales by customer joins on client_id only

**Claim.** Legacy `customer_id` invoices are silently excluded from sales totals.

**Corrected trigger.** `pages/api/accounting/reports/sales-by-customer.ts:33` reads
`JOIN customers c ON c.id = ci.client_id` and groups on `ci.client_id`. In the production
schema `customer_invoices.customer_id` is **NOT NULL** and `client_id` is **nullable**, so the
legacy shape is `client_id IS NULL`. An inner join on a NULL key drops the row before the
aggregate ever sees it — the report does not attribute the invoice to "unknown", it omits it.
The repo rule (`CLAUDE.md`, "Customer invoices") is `COALESCE(ci.client_id, ci.customer_id)`
for exactly this reason.

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:pages/api/accounting/reports/sales-by-customer.ts` lines 25–40.
- Fixture schema: `\d customer_invoices` — `customer_id uuid NOT NULL`, `client_id uuid` (null),
  FK `customer_invoices_customer_id_fkey → customers(id)`; `client_id` carries no FK.
- Executed: `tests/integration/k093-sales-by-customer-legacy-customer-id.int.test.ts`. It seeds
  one modern invoice (R1,000, both columns set) and one legacy invoice (R2,500, `client_id`
  NULL) and drives the real route with the auth wrapper neutralised. 1 test, 1 failed:
  `expected 1 to be 2` invoices; reported sales R1,000 against a ledger total of R3,500.
  `red.log` in this directory.

**Reachability.** `GET /api/accounting/reports/sales-by-customer`, `withAuth` +
`withWriteAccess`. Both the JSON and the `?format=csv` download come from the same rows.

**Proposed minimal fix.** In the same query, replace the join and grouping key:
`JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id`,
and `GROUP BY COALESCE(ci.client_id, ci.customer_id), c.name` with the same expression aliased
as `client_id`. Adding `c.company_id = ci.company_id` costs nothing and closes a second gap:
the customers side of the join is currently unscoped by tenant.

**Historical-data impact.** No stored row is wrong — every figure this report has ever shown
was understated. Anyone who reconciled sales-by-customer against the income statement or the
AR aging saw a difference they could not explain. Size it read-only per tenant:

```sql
SELECT company_id,
       COUNT(*)                                   AS invoices_hidden,
       COALESCE(SUM(total_amount), 0)             AS sales_hidden
FROM   customer_invoices
WHERE  client_id IS NULL
  AND  status <> 'cancelled'
GROUP  BY company_id
ORDER  BY sales_hidden DESC;
```

**Risks.** Totals rise on any tenant with legacy rows, which will look like a regression to
whoever last exported the report. If both columns are populated and *disagree* on some rows,
COALESCE keeps `client_id`, i.e. today's attribution — worth checking that count
(`WHERE client_id IS NOT NULL AND client_id <> customer_id`) before shipping.
