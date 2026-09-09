# K-012 — fix: credit the receipt, not its allocated part

**Trigger.** A confirmed customer receipt that is only partly matched to invoices.
`fetchStatementData` selected `COALESCE(SUM(cpa.amount_allocated), cp.total_amount)`; `SUM` is NULL
only when a receipt has zero allocation rows, so the fallback never fired for a partial one.

**Before.** R100 received, R40 allocated → the emailed statement credited R40 and showed R60 still
owed on money already banked. `summary.totalPaid` and the running balance carried the same
understatement.

**After.** The receipt is credited at `cp.total_amount`. The allocation join and GROUP BY are gone —
allocation is internal matching, a statement is an account-level document. The excluded-receipt
entry now also reports the amount received rather than the allocated part.

**Files.** `src/modules/accounting/services/ar/statementEmailService.ts` (payments query + the two
`pmt.amount_allocated` reads, renamed to `amount_received`).

**Divergence, out of scope.** `pages/api/accounting/customer-statement.ts` (the on-screen/PDF route)
carries the identical `COALESCE(SUM(cpa.amount_allocated), cp.total_amount)` in BOTH its detail
query (:96-105) and its headline-totals aggregate (:142-152). It is the same defect on the same
basis and is NOT fixed here. Until it is, the screen and the email will disagree for a partly
allocated receipt.

**Tests** (real DB, disposable fixture).
- `tests/integration/k012-statement-partial-receipt-credit.int.test.ts` — 1 test (the validator's RED).
- `tests/integration/k012-statement-receipt-credit-adjacent.int.test.ts` — 5 tests: unallocated
  receipt, fully allocated receipt credited once, a receipt under another `company_id` with the same
  `client_id`, a draft receipt excluded at the amount received, an after-as-at receipt plus totals.
- 6/6 pass. Mutation-proof (`green.log`): restoring the COALESCE reddens 1; dropping the
  `company_id` predicate reddens 2; restoring the fix returns 6/6.

**Migration / rollback.** None. Revert the commit to roll back.

**Historical-data impact.** Nothing in the ledger is wrong — the defect is in an emitted document.
Every statement emailed while a receipt was partly allocated overstated the balance by the
unallocated remainder; remediation is re-sending. Read-only probe for currently exposed customers:
```sql
SELECT cp.company_id, cp.client_id, cp.payment_number, cp.total_amount,
       COALESCE(SUM(cpa.amount_allocated), 0) AS allocated
FROM customer_payments cp
LEFT JOIN customer_payment_allocations cpa ON cpa.payment_id = cp.id
WHERE cp.status IN ('confirmed','reconciled')
GROUP BY 1,2,3,4
HAVING COALESCE(SUM(cpa.amount_allocated), 0) BETWEEN 0.01 AND cp.total_amount - 0.01;
```

**Limits.** The statement balance will now disagree with an allocation-driven aging report by the
unallocated cash held. That disagreement is correct but is not labelled on the document; labelling
it is a template change nobody asked for here. `customer_payment_allocations` has no `company_id`
column, so the removed join never had a tenant predicate — removing it removes the question.
