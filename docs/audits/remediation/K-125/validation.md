# K-125 — debtors queries drop invoices with NULL amount_paid

Baseline: origin/master `31fc2f1062d228f6ebf43049338ecb41767002d0`.

**Claim.** Arithmetic on a NULL amount_paid yields NULL, removing the invoice from the result.

**Corrected trigger.** The arithmetic is confirmed against the real schema, but reachability is NOT.
`customer_invoices.amount_paid` is `numeric(15,2)` NULLABLE with DEFAULT 0, so a NULL is storable
and behaves exactly as claimed. I traced every writer of the column and none can produce a NULL:
all 14 INSERT sites either omit it (taking the default) or coalesce (`migrationImportService.ts:143`
`${inv.amountPaid ?? 0}`), and every UPDATE is `amount_paid + n`, `GREATEST(...)` or a
`Number(...)` result. So this is a latent hazard reachable by direct SQL, a restore, or a future
nullable write path — not a defect any current application flow triggers.

**Disposition: confirmed** (defect reproduced; severity reduces to defensive hardening unless the
impact SQL below finds NULL rows in production).

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ar/debtorsManagerService.ts` :90, :118, :155, :253 —
  `ci.total_amount - ci.amount_paid` with no COALESCE, including in the `> 0` filter.
- `\d customer_invoices`: `amount_paid | numeric(15,2) | | | 0` (nullable).
- RED: `tests/integration/k125-debtors-null-amount-paid.int.test.ts` — 1 failed (4 assertions).
  One approved R1,150 invoice with `amount_paid = NULL`: `getDebtorsSummary` returns [],
  `getDebtorDetail` returns [], `getCollectionStats.totalOutstanding` is 0.

**Reachability.** `pages/api/accounting/ar/debtors*` under `withAuth`, given a NULL row exists.

**Proposed minimal fix (1 file).**
Wrap all four sites as `(ci.total_amount - COALESCE(ci.amount_paid, 0))`, matching the rest of the
codebase. Optionally follow with a migration setting `amount_paid` NOT NULL DEFAULT 0 after
back-filling, which removes the class rather than the instance.

**Historical-data impact.** Read-only, per company:
```sql
SELECT company_id, count(*) AS null_amount_paid, sum(total_amount) AS hidden_receivable
FROM customer_invoices
WHERE amount_paid IS NULL AND deleted_at IS NULL
  AND status IN ('approved','sent','partially_paid','overdue')
GROUP BY company_id;
```
Any row returned is receivable that has been invisible in every debtors view and in the collection
stats. NOT run against production — production must not be queried from this worktree.

**Risks.** None material; COALESCE cannot change the result for a non-NULL row.
