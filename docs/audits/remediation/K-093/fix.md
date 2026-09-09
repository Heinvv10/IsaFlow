# K-093 fix — sales by customer resolves the customer the way the rest of the repo does

**Trigger.** `pages/api/accounting/reports/sales-by-customer.ts` joined
`customers c ON c.id = ci.client_id` and grouped on `ci.client_id`.
`customer_invoices.customer_id` is NOT NULL and `client_id` is nullable, so the legacy
shape is `client_id IS NULL`. An inner join on a NULL key drops the row before the
aggregate sees it — the report omitted the invoice rather than attributing it to
"unknown". The customers side also carried no tenant scope.

**Before / after.** Fixture: one modern invoice R1,000 (both columns set), one legacy
R2,500 (`client_id` NULL), one legacy R700 dated on the `to` boundary. Before: 1 invoice,
R1,000 reported against a ledger of R4,200. After: 3 invoices, R4,200, in both the JSON
and the CSV download.

**Files.** `pages/api/accounting/reports/sales-by-customer.ts` — select, join and
GROUP BY now use `COALESCE(ci.client_id, ci.customer_id)`, and the join adds
`c.company_id = ci.company_id`.

**Tests.** `tests/integration/k093-sales-by-customer-legacy-customer-id.int.test.ts`,
4 tests, real Postgres against the route itself: the legacy invoice is reported; a
cancelled legacy invoice and one dated a day past `to` stay excluded while the invoice
dated exactly on `to` is included; a drifted invoice pointing at another tenant's customer
row does not name that customer; the CSV download carries the same rows.

**Mutation check.** Reverting the route to `origin/master` turns 3 of 4 red. Deleting only
`AND c.company_id = ci.company_id` turns all 4 red. Restored, 4 pass.

**Migration / rollback.** None. Revert the commit.

**Historical-data impact.** Read path — no stored row is wrong; every figure the report
ever showed was understated. Size it read-only, and check the disagreement case before
shipping:

```sql
SELECT company_id, COUNT(*) AS invoices_hidden,
       COALESCE(SUM(total_amount), 0) AS sales_hidden
FROM   customer_invoices
WHERE  client_id IS NULL AND status <> 'cancelled'
GROUP  BY company_id ORDER BY sales_hidden DESC;

SELECT company_id, COUNT(*) AS both_set_and_disagreeing
FROM   customer_invoices
WHERE  client_id IS NOT NULL AND client_id <> customer_id
GROUP  BY company_id;
```

**Limits.** Where both columns are set and disagree, COALESCE keeps `client_id`, i.e.
today's attribution. The new tenant guard drops any invoice whose customer row belongs to
another company; that is data drift and should be zero, so the second query above is worth
running before the deploy.
