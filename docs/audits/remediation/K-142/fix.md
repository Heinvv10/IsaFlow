# K-142 — a part-paid bill must be matched on what is still owed

**Trigger.** Any bank payment settling the remainder of a supplier invoice that
already carries an `amount_paid`.

**Before.** `fetchSupplierInvoiceCandidates` selected `si.total_amount` and used
that gross for the ORDER BY, the score, the offered candidate amount, the
"Exact amount match" reason and the combo pool, while `status IN ('approved',
'partially_paid')` deliberately admitted part-paid bills. A R300 settlement of a
R1,000 bill already R700 paid was offered at R1,000 and outranked by an unrelated
R1,000 bill, so the operator was steered to the wrong bill.

**After.** The supplier arm mirrors the customer arm in the same file: it selects
`si.amount_paid`, orders by `ABS(total_amount - COALESCE(amount_paid,0) - amount)`
and uses `total_amount - (amount_paid || 0)` everywhere the gross was used.

**Files.** `src/modules/accounting/services/bank/bankMatchDbQueries.ts`.

**Tests.** `tests/integration/k142-supplier-match-scores-gross.int.test.ts` — 6
passed against a real database. Mutation proof in `green.log`.

**Migration.** None.

**Historical-data impact.** Nothing wrong is written by this code — it only ranks
suggestions. The consequence is misallocated payments an operator was steered
into. Read-only exposure count (not run here):
`SELECT COUNT(*) FROM supplier_invoices
 WHERE status = 'partially_paid' AND COALESCE(amount_paid,0) > 0;`

**Limits.** Candidate ordering changes for every supplier match, so the
reconciliation screen's suggestions move. That is the intended correction, but it
is user-visible. `fetchPurchaseOrderCandidates` still scores `po.total` gross and
is untouched: `purchase_orders` has no paid-amount column (verified against the
fixture schema — only `subtotal` and `total`), so there is nothing to subtract.
