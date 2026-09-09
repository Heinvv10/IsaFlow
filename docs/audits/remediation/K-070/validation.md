# K-070 — Customer-rule auto-post writes no AR subledger row

**Claim.** The rule credits AR in the GL but never records a customer payment or
allocation, so the subledger and GL diverge.

**Corrected trigger.** `autoPostRuleLine` posts its own journal instead of
calling `allocateTransaction`. For `allocType='customer'` on a deposit,
`buildAutoCreateLines` debits the bank and credits Accounts Receivable
(bankRulesMatchingHelpers.ts:144-151). The document block that follows the bank
UPDATE is gated `if (allocType === 'supplier' && supplierId && !isDeposit)`
(bankRuleAutoPostLine.ts:244) and calls `recordSupplierBankPayment`. There is no
customer counterpart: `autoApplyCustomerReceipt` (ar/customerAutoAllocate.ts) is
imported by `bankAllocationService` — the ATTENDED path — and by nothing here.
The comment at lines 231-236 records the AP half of this being fixed; the AR
mirror was left standing.

**Disposition: CONFIRMED.**

**Evidence.** Read at origin/master, which includes the K-016/K-017 merges
(`dd4ae108`, `f82f9e88`); those changed VAT resolution on this file and left the
document gate untouched. RED test
`tests/integration/k070-customer-rule-no-ar-subledger.int.test.ts` against real
PostgreSQL: **1 test, 1 failed**. The rule posted (`outcome.kind === 'posted'`)
and the AR control account was credited the full 5000 — that assertion passed —
while `customer_payments` for the company holds **0** rows and the customer's
open invoice `amount_paid` never moved.

**Reachability.** `bankRulesMatchingService.applyRules`, the unattended bank-rule
sweep, for every rule whose `allocation_type` is `customer`.

**Proposed fix.** Mirror the supplier arm inside the same `if (bankLineRows[0])`
block: for `allocType === 'customer' && customerId && isDeposit`, insert the
`customer_payments` row for the cash (the AR twin of
`recordSupplierBankPayment`) and then run `autoApplyCustomerReceipt` under the
customer's `auto_allocate_strategy`. That needs `customerId` added to
`AutoPostLineInput` and threaded from the sweep, exactly as `supplierId` was.
Do not catch — a caught write here is a partial commit reported as success.

**Historical-data impact.** Every customer-rule auto-post credited AR with no
receipt behind it: the AR control account is understated relative to the open
invoices, the customer still reads as owing, and the cash is unreachable by
`list_unapplied_receipts`. Read-only probe (NOT run):

```sql
SELECT bt.id, bt.transaction_date, bt.amount, bt.allocated_entity_name
FROM bank_transactions bt
LEFT JOIN customer_payments cp ON cp.gl_journal_entry_id = (
  SELECT jl.journal_entry_id FROM gl_journal_lines jl WHERE jl.id = bt.matched_journal_line_id)
WHERE bt.allocation_type = 'customer' AND bt.allocation_rule_id IS NOT NULL
  AND bt.amount > 0 AND cp.id IS NULL;
```
This is the AR mirror of the AP backfill in `project_ap_payment_document_backfill`.

**Risks.** Creating the receipt makes the cash applicable, which will move
`amount_paid` on invoices that have read as open for months — the correction is
right but it changes reported aging, so it belongs behind a dated backfill, not
a silent sweep.
