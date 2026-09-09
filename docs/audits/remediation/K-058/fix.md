# K-058 — fix

**Trigger.** A `customer_invoices` row with a NULL `client_id` (legacy/import-era;
`client_id` is NULLABLE, `customer_id` is NOT NULL). The debtors dashboard keys on
`ci.client_id` alone, so such a row matches nothing in the INNER JOIN to `customers`
and is dropped silently, while `getARAging` reads the same invoice through
`COALESCE(ci.client_id, ci.customer_id)` and counts it.

**Before.** Debtors summary, overdue list, debtor drill-down and the collection-stats
customer count all omitted NULL-`client_id` invoices. Dashboard and AR aging disagreed
about the same book (R1,000 vs R1,750 in the fixture). No warning, no excluded-row count.

**After.** All four sites use `COALESCE(ci.client_id, ci.customer_id)`, the repo-wide
read pattern. Dashboard totals now equal AR aging. `COALESCE` keeps `client_id`
precedence, so an invoice whose `client_id` differs from its `customer_id` still groups
under `client_id` and no debtor row is duplicated. Response contracts unchanged: the
`clientId` field is still one UUID that `getDebtorDetail` accepts.

**Files.**
- `src/modules/accounting/services/ar/debtorsManagerService.ts` — 7 lines:
  `getDebtorsSummary` projection/join/GROUP BY, `getDebtorDetail` predicate,
  `getOverdueInvoices` projection/join, `getCollectionStats` `COUNT(DISTINCT ...)`.

**Tests.** `tests/integration/k058-debtors-drops-null-client-id.int.test.ts` — 7 tests
against the real schema (2 pre-existing RED + 1 control, plus 4 adjacent cases:
`client_id` precedence over `customer_id`, drill-down by the summary's `clientId`,
collection-stats customer count, second-company isolation). 7/7 pass; 6 go RED when the
production change is reverted (see `green.log`). Full unit suite 9434 passed.

**Migration / rollback.** None. Read-side only; revert the commit to roll back.

**Historical-data impact.** No writes, no backfill: previously hidden invoices become
visible, so debtor totals rise toward the aging figure. Count of affected rows
(read-only, not run here — production is out of scope):

```sql
SELECT company_id, count(*) AS invoices,
       sum(total_amount - COALESCE(amount_paid, 0)) AS newly_visible_outstanding
FROM customer_invoices
WHERE client_id IS NULL
  AND status IN ('approved', 'sent', 'partially_paid', 'overdue')
  AND (total_amount - COALESCE(amount_paid, 0)) > 0
GROUP BY company_id;
```

**Limits.** Rows whose `customer_id` points at a customer in another company would still
be dropped by the join; the tenant filter is on `ci.company_id` only, unchanged here.
Backfilling `client_id` on the writers is a separate decision and was not done.
