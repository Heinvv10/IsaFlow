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

---

## Blind review of ade12166 — MEDIUM-1 and LOW-2 (both fixed)

**MEDIUM-1.** Scoping the customers join by tenant on an INNER join turned a mislabelled invoice
into a silently omitted one, which is the same defect class K-093 exists to fix: the report stopped
footing to the ledger by the value of the drifted invoice. Worse, the suite pinned the omission as
correct — its oracle was a hand-copy of the route's own join, including the new tenant predicate,
so oracle and route excluded the same rows and could never disagree.

**Disposition (fixed).** The customers side is now a LEFT JOIN with
`COALESCE(c.name, 'Unknown customer')` in the select and in the GROUP BY, so a drifted or missing
customer row is named honestly and its money is still counted. The other tenant's customer NAME is
still never printed, which was the point of the tenant predicate. Test 1's oracle now reads
`customer_invoices` with NO join at all, so it is independent of the route's join; test 3 asserts
the drifted invoice appears as `Unknown customer` at its full value instead of asserting it is
absent. Mutation M10: restoring the inner join turns 3 of the 5 tests red.

**LOW-2 (fixed).** `customer_invoices.amount_paid` is nullable, `SUM` skips a NULL addend, and the
outer `COALESCE(..., 0)` only covered the all-NULL case — so an invoice with a NULL `amount_paid`
contributed nothing at all to `outstanding`. Legacy rows, which this fix exists to pull in, are
exactly the ones most likely to predate the column default. Now
`SUM(ci.total_amount - COALESCE(ci.amount_paid, 0))`, and `payments_received` COALESCEs inside the
SUM for the same reason. A fixture invoice with `amount_paid` NULL and a fifth test pin it;
mutation M11 removes the inner COALESCE and that test goes red.

**Historical-data impact.** No stored row changes. `total_sales` and the invoice count rise by any
drifted invoice previously dropped, and `outstanding` rises by the total of any invoice with a NULL
`amount_paid`. The drift query already in this file finds the first set; for the second:
```sql
SELECT company_id, count(*), SUM(total_amount)
FROM customer_invoices WHERE amount_paid IS NULL AND status <> 'cancelled'
GROUP BY company_id;
```
