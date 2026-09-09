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

Both joins to `customers` are also tenant-scoped now (`AND c.company_id = ci.company_id`)
and made OUTER. Neither `client_id` (no FK at all) nor `customer_id` (FK to `customers(id)`,
not tenant-scoped) is constrained to the invoice's own company, so an id pointing at another
company's customer previously joined and rendered that customer's NAME on this company's
dashboard. Coalescing widened the class of rows that could do it, since NULL-`client_id`
rows now join on `customer_id`. The `LEFT JOIN` plus a `COALESCE` on the name withholds the
foreign name — the actual leak — while keeping the row and its amount, which is this
company's own AR, visible. The placeholder carries the first 8 characters of the unresolved
id, so two debtors that cannot be named stay distinguishable in the table and in the
dashboard's client-side name search, without disclosing anything about either. Dropping the row instead would have re-created the very
defect K-058 is about: money not shown, not totalled, not reported as excluded. The outer
join also re-admits orphan `client_id` values, same argument. `clientCount` is a plain
`COUNT(DISTINCT COALESCE(ci.client_id, ci.customer_id))`: with an outer join every debtor
group is listed, the collection-stats `WHERE` is identical to the summary `WHERE`, and
`customer_id` is NOT NULL, so the tile equals `summary.length` by construction.

**Files.**
- `src/modules/accounting/services/ar/debtorsManagerService.ts` — 7 lines:
  `getDebtorsSummary` projection/join/GROUP BY, `getDebtorDetail` predicate,
  `getOverdueInvoices` projection/join, `getCollectionStats` `COUNT(DISTINCT ...)`;
  plus `AND c.company_id = ci.company_id` on both `customers` joins, both joins made
  `LEFT JOIN`, and both name projections wrapped in
  `COALESCE(c.name, 'Unknown customer ' || left(COALESCE(ci.client_id, ci.customer_id)::text, 8))`.

**Tests.** `tests/integration/k058-debtors-drops-null-client-id.int.test.ts` — 11 tests
against the real schema. Two pre-existing RED + 1 control, plus 8 adjacent cases:
`client_id` precedence over `customer_id`, drill-down by the summary's `clientId`,
collection-stats customer count, second-company isolation, a company-A invoice whose
`customer_id` points at company B's customer (row and money visible, name not),
stat-tile/table agreement on both count and total, two un-nameable debtors of a third
company rendering distinguishably, and the aging divergence recorded under Limits below,
asserted rather than only written down. The debtors-vs-aging test calls `getARAging` and
compares the two totals; it no longer compares against a constant. 11/11 pass. Five
mutations recorded in `green.log` §10b, each restored, file byte-identical afterwards:
`LEFT JOIN`→`JOIN` 7 RED, `COALESCE(client_id, customer_id)`→`client_id` 6 RED, tenant
predicate dropped 2 RED, id fragment removed from the placeholder 2 RED, `DISTINCT` dropped
from `clientCount` 2 RED. Full unit suite with `DATABASE_URL` unset: 9434 passed, 0 failed.

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
- A row naming a foreign customer renders as `Unknown customer <id8>` rather than being
  dropped, so the debtors table, the overdue list and `getCollectionStats` all agree on
  the same money. The placeholder is not an excluded-row alert — an operator sees an
  unnamed debtor, which is a data-quality signal, not a reconciliation break.
- **The debtors dashboard and AR aging still disagree on one input, in the opposite
  direction to the original defect.** `arAgingService.ts:49` joins `customers` with an
  UNSCOPED INNER JOIN. An id matching no `customers` row at all — possible because
  `client_id` carries no foreign key — is now listed by the debtors dashboard and is still
  dropped by aging; before this change both surfaces dropped it, so they agreed. Aging also
  still renders the foreign customer's NAME, since its unscoped join resolves it. Both
  halves are asserted in the test named "records the one case where debtors and AR aging
  still disagree", so a future change to either surface fails there rather than drifting
  silently. Not fixed here: `arAgingService.ts` is K-053's file and is being edited on a
  parallel branch, so scoping and outer-joining it belongs there, not in this commit.
- None of the four queries filters `deleted_at`. Adding it here alone would re-open the
  very disagreement this fix closes, because `arAgingService` does not filter it either,
  and the repo's own predicate is `(deleted_at IS NULL OR deleted_at > NOW())`, not a
  plain `IS NULL`. Soft-delete handling across AR reads is a separate decision.
- Backfilling `client_id` on the writers is a separate decision and was not done.
