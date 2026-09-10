# K-142 — supplier match candidates score the gross total

**Claim.** "The score ignores amount_paid, so part-paid bills never match their remaining balance."

**Disposition: confirmed** (exactly as claimed).

**Evidence.**
- `fetchSupplierInvoiceCandidates` (`src/modules/accounting/services/bank/bankMatchDbQueries.ts:51-85`,
  origin/master) selects `si.total_amount`, orders by `ABS(si.total_amount - ${absAmount})`, and
  uses that value for `scoreAmount`, the candidate `amount`, the "Exact amount match" reason and the
  combo pool. `status IN ('approved','partially_paid')` (line 56) deliberately admits part-paid
  bills. `supplier_invoices.amount_paid` exists (confirmed against the fixture schema) and is never
  read here.
- The customer arm of the SAME FILE does it correctly: `ORDER BY ABS(ci.total_amount -
  ci.amount_paid - …)` (line 111) and `balance = total_amount - amount_paid` (line 127). The
  asymmetry inside one file is the disconfirmation-proof evidence.
- Repo rule (`feedback: no balance_due column`): outstanding = `total_amount - COALESCE(amount_paid,0)`.
- RED: `tests/integration/k142-supplier-match-scores-gross.int.test.ts` — 3 failed of 3. A R1,000 bill
  with R700 paid is offered at R1,000 for a R300 payment and is called an "Exact amount match" for a
  R1,000 payment. Log: `red.log`.

**Reachability.** The bank-match candidate list behind the reconciliation screen; every settlement of
a part-paid bill.

**Proposed minimal fix.** Mirror the customer arm: select `si.amount_paid`, compute
`balance = Number(row.total_amount) - Number(row.amount_paid || 0)`, use `balance` for the ORDER BY,
`scoreAmount`, `amount`, the exact-amount test and the combo pool. `fetchPurchaseOrderCandidates`
(line 148) has the same gross-only shape against `po.total` — check whether POs track a paid amount
before touching it.

**Historical-data impact.** Nothing wrong is written by this code; it only ranks suggestions. The
consequence is operators steered to the wrong bill, which shows up as misallocated payments. Census
of the exposure, read-only:
`SELECT COUNT(*) FROM supplier_invoices WHERE status = 'partially_paid' AND COALESCE(amount_paid,0) > 0;`

**Risks.** Candidate ordering changes for every supplier match, so the reconciliation screen's
suggestions will move. That is the intended correction, but it is user-visible.
