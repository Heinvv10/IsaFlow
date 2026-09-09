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
precedence per invoice, so an invoice whose `client_id` differs from its `customer_id`
still groups under `client_id`. (Per *debtor* the grouping can still split: a debtor with
some invoices carrying `client_id = X, customer_id = Y` and others carrying
`client_id = NULL, customer_id = Y` occupies two summary rows, X and Y. That matches what
AR aging shows for the same book, so the surfaces still agree.) Response contracts
unchanged: `clientId` is still one UUID that `getDebtorDetail` accepts.

Both joins to `customers` are also tenant-scoped now (`AND c.company_id = ci.company_id`).
Neither `client_id` (no FK at all) nor `customer_id` (FK to `customers(id)`, not
tenant-scoped) is constrained to the invoice's own company, so an id pointing at another
company's customer previously joined and rendered that customer's NAME on this company's
dashboard. Coalescing widened the class of rows that could do it, since NULL-`client_id`
rows now join on `customer_id`. Scoped, such a row is dropped instead of named.
`getCollectionStats.clientCount` uses the same tenant-scoped test via
`FILTER (WHERE EXISTS ...)`, so the tile counts exactly the debtors the table lists.

**Files.**
- `src/modules/accounting/services/ar/debtorsManagerService.ts` — 7 lines:
  `getDebtorsSummary` projection/join/GROUP BY, `getDebtorDetail` predicate,
  `getOverdueInvoices` projection/join, `getCollectionStats` `COUNT(DISTINCT ...)`;
  plus `AND c.company_id = ci.company_id` on both `customers` joins and the matching
  `EXISTS` guard on `clientCount`.

**Tests.** `tests/integration/k058-debtors-drops-null-client-id.int.test.ts` — 8 tests
against the real schema (2 pre-existing RED + 1 control, plus 5 adjacent cases:
`client_id` precedence over `customer_id`, drill-down by the summary's `clientId`,
collection-stats customer count, second-company isolation, and a company-A invoice whose
`customer_id` points at company B's customer, which must yield no name). 8/8 pass. Three
mutations recorded in `green.log`: reverting the whole change turns 6 RED, removing only
the tenant predicate on the joins turns 5 RED, removing only the `clientCount` guard turns
2 RED.

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

**Limits.**
- A row naming a foreign customer is now dropped from the summary and the overdue list,
  but its money still counts in `getCollectionStats.totalOutstanding`, which has no join.
  That is deliberate: the amount is this company's, only the foreign NAME is withheld.
  `getARAging` joins `customers` unscoped, so it would still render that name; scoping it
  is a change to a different service and was left alone.
- None of the four queries filters `deleted_at`. Adding it here alone would re-open the
  very disagreement this fix closes, because `arAgingService` does not filter it either,
  and the repo's own predicate is `(deleted_at IS NULL OR deleted_at > NOW())`, not a
  plain `IS NULL`. Soft-delete handling across AR reads is a separate decision.
- Backfilling `client_id` on the writers is a separate decision and was not done.
