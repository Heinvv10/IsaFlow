# K-012 — emailed statement credits only the allocated part of a receipt

**Claim (audit A C10):** `COALESCE(SUM(allocated), total)` fires only on zero allocations, so a
partial receipt's unapplied remainder is dropped from the statement.

**Disposition: confirmed** (as stated).

**Mechanism.** `fetchStatementData`
(`git show ebeac9ca:src/modules/accounting/services/ar/statementEmailService.ts`, lines 128-137)
selects `COALESCE(SUM(cpa.amount_allocated), cp.total_amount) AS amount_allocated` over a LEFT JOIN
to `customer_payment_allocations`. `SUM` returns NULL only when the receipt has no allocation rows,
so the fallback to `total_amount` never fires for a partially allocated receipt. The value flows
straight into the statement line's credit (:190) and into `summary.totalPaid` and the running
balance (:232-238). Money the customer paid but the business has not yet allocated is omitted from
a document emailed to that customer, overstating the balance owed.

**Reachability.** `fetchStatementData` is the fetcher for the customer-statement email send path in
the same module; the payload is what gets rendered and mailed. File unchanged between 5661d6f0 and
ebeac9ca.

**Evidence.** RED test `tests/integration/k012-statement-partial-receipt-credit.int.test.ts`
(1 test / 1 failed — `docs/audits/remediation/K-012/red.log`). One R100 invoice, one confirmed R100
receipt with a single R40 allocation. Expected credit R100 and closing balance 0; actual
`expected 40 to be 100`, leaving the emailed statement showing R60 still owed against money already
received.

**Proposed minimal fix** (`statementEmailService.ts:128-137`):
- Credit the receipt itself: select `cp.total_amount AS amount_received` and drop the join and
  GROUP BY entirely, since allocation is an internal matching detail and the statement is an
  account-level document.
- If the allocated split is still wanted for display, keep the SUM as a separate column and use
  `cp.total_amount` for the credit, never the COALESCE.
- Note the allocation join carries no tenant predicate; `customer_payment_allocations` has no
  `company_id` column, so this is a schema limitation, not a fixable filter — removing the join
  removes the question.

**Historical-data impact.** Every statement emailed while a receipt was partly allocated
overstated the balance by the unallocated remainder. Nothing in the ledger is wrong; the defect is
in the emitted document, so remediation is re-sending affected statements. Read-only probe for
customers currently exposed:
```sql
SELECT cp.company_id, cp.client_id, cp.payment_number, cp.total_amount,
       COALESCE(SUM(cpa.amount_allocated), 0) AS allocated
FROM customer_payments cp
LEFT JOIN customer_payment_allocations cpa ON cpa.payment_id = cp.id
WHERE cp.status IN ('confirmed','reconciled')
GROUP BY 1,2,3,4
HAVING COALESCE(SUM(cpa.amount_allocated), 0) BETWEEN 0.01 AND cp.total_amount - 0.01;
```

**Risks.** Crediting the full receipt makes the statement balance disagree with an aging report
that is allocation-driven; that disagreement is correct (unallocated cash is genuinely held), but
it should be labelled on the document so a reader is not left reconciling two numbers.
