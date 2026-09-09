# K-125 — debtors views no longer drop invoices with a NULL amount_paid

**Trigger.** `customer_invoices.amount_paid` is `numeric(15,2)` NULLABLE (default 0).
`debtorsManagerService` computed `ci.total_amount - ci.amount_paid` with no COALESCE, so a NULL
propagated: every aging bucket became NULL and the `> 0` filter evaluated to NULL rather than true,
removing the invoice from every debtors view and from the collection stats.

**Before.** One approved R1,150 invoice with `amount_paid = NULL`: `getDebtorsSummary` returned [],
`getDebtorDetail` returned [], `getOverdueInvoices` returned [], `getCollectionStats.totalOutstanding`
was 0 — receivable silently invisible.
**After.** All ten arithmetic sites are `(ci.total_amount - COALESCE(ci.amount_paid, 0))`, including the
`> 0` predicates and the collected-total in the collection-rate query. COALESCE cannot change the
result for a non-NULL row, so no existing behaviour moves.

**Files.** `src/modules/accounting/services/ar/debtorsManagerService.ts` (294 lines, unchanged count —
existing lines widened, none added).

**Tests.** `tests/integration/k125-debtors-null-amount-paid.int.test.ts` — 6 passed (real DB):
NULL-paid invoice owes its full total across summary/detail/stats; it lists as overdue with
`amountPaid` 0; collection rate is 0 when every `amount_paid` is NULL; a partly paid invoice still
nets off (1150 + 750); a fully settled invoice is still excluded; another tenant sees nothing.
Mutation check: reverting the file to origin/master → 4 failed.

**Migration / rollback.** None. Revert the commit. A follow-up migration back-filling and setting
`amount_paid NOT NULL DEFAULT 0` would remove the class rather than the instance; not done here.

**Historical-data impact.** No row is wrong; rows were hidden from reads. Read-only, per company
(NOT run against production):
```sql
SELECT company_id, count(*) AS null_amount_paid, sum(total_amount) AS hidden_receivable
FROM customer_invoices
WHERE amount_paid IS NULL AND deleted_at IS NULL
  AND status IN ('approved','sent','partially_paid','overdue')
GROUP BY company_id;
```

**Limits.** The validator traced all 14 writers and found none that can store a NULL today, so this
is defensive hardening against direct SQL, a restore, or a future nullable write path — unless the
impact SQL above returns rows.

## Round 2 (blind review M4)
Scope widened from `debtorsManagerService.ts` to every site the review named: the AR aging report
(rows, `> 0` filter and bucket SUM), the AFS receivables and payables disclosure notes, the custom
report balance expressions for both customer and supplier invoices, and the bank-match candidate
ordering. `emailNotificationService.ts:63` already coalesced in JS and needed no change.
`tests/integration/k125b-null-amount-paid-report-parity.int.test.ts` asserts the aging report and
the debtors page now agree on the same data.
