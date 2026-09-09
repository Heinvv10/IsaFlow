# K-116 — receipt application ignores allocations pending on draft payments

**Claim.** Draft payment allocations are excluded from the applied total, so the same invoice balance
can be claimed twice.

**Corrected trigger.** Precisely: `fetchInvoiceCandidates` scopes `already_allocated` to
`cpa.payment_id = <this payment>`, so allocations on OTHER payments — draft or otherwise — are
invisible; `buildLine` then measures against `total_amount - amount_paid`, which no draft has moved.

**Disposition: confirmed.**

## Evidence
- Baseline `origin/master` = `31fc2f10`; `git diff HEAD origin/master -- receiptAllocationLines.ts`
  and `-- customerPaymentService.ts` are both empty.
- `receiptAllocationLines.ts:141-146` — the `already_allocated` subquery, scoped by `payment_id`.
- `:178-185` — `outstandingBefore = round2(total - amount_paid)`; the only refusal is above that.
- `customerPaymentService.ts:117-133` — the OTHER writer subtracts `SUM(amount_allocated)` over every
  `customer_payments` row at `status = 'draft'`, with a comment saying why. The two disagree.
- RED: `tests/integration/k116-draft-allocation-double-claim.int.test.ts` — 1 test, 1 failed.
  A R10,000 invoice already carrying a R10,000 draft allocation: `planAllocationLines` plans
  `R10000 against R10000 "outstanding"` instead of refusing. Log: `red.log`.

## Reachability
`planAllocationLines` is the shared planner for `receiptApplicationService`,
`receiptMatchConfirmService`, and the MCP allocation routes (`allocationApplyRoute`,
`bulkAllocationSkip`). Every receipt-application entry point takes this path.

## Proposed minimal fix
`src/modules/accounting/services/ar/receiptAllocationLines.ts`
1. Add a second aggregate to `fetchInvoiceCandidates`: `pending_on_drafts`, summing
   `customer_payment_allocations` joined to `customer_payments` at `status = 'draft'` and
   `cp.company_id = ${companyId}`, EXCLUDING `cpa.payment_id = ${paymentId}` so a payment's own
   pending rows are not double-counted.
2. In `buildLine`, subtract it: `outstandingBefore = round2(total - amount_paid - pendingOnDrafts)`.
3. Name the draft in the refusal message, as `createCustomerPayment` already does.

## Historical-data impact
Real and material: an invoice can carry `amount_paid > total_amount` once a draft that was
double-claimed is confirmed. Read-only detection (NOT run against production):
```sql
SELECT company_id, id, invoice_number, total_amount, amount_paid
FROM customer_invoices
WHERE COALESCE(amount_paid, 0) > total_amount + 0.01;
```
plus the still-open exposure:
```sql
SELECT ci.company_id, ci.id, ci.total_amount, ci.amount_paid,
       SUM(cpa.amount_allocated) AS pending_on_drafts
FROM customer_invoices ci
JOIN customer_payment_allocations cpa ON cpa.invoice_id = ci.id
JOIN customer_payments cp ON cp.id = cpa.payment_id AND cp.company_id = ci.company_id
WHERE cp.status = 'draft'
GROUP BY 1,2,3,4
HAVING COALESCE(ci.amount_paid,0) + SUM(cpa.amount_allocated) > ci.total_amount + 0.01;
```

## Risks
Tightening this refuses allocations that succeed today, including inside MCP bulk runs — the guard
fails in both directions if `pending_on_drafts` accidentally includes the current payment's own rows.
The `EXCLUDING` clause in step 1 is the part to review hardest.
