# K-063 — a supplier payment settles a bill that never credited AP

**Claim.** `supplierAllocationLines.ts:29` has no status guard, so a payment
relieves AP for a bill that never credited it.

**Corrected trigger.** There *is* a guard —
`UNALLOCATABLE_STATUSES = new Set(['cancelled','draft'])` — and it is
incomplete. `supplier_invoices_status_check` also allows `pending_approval` and
`disputed`, and AP is credited only by `approveSupplierInvoice`
(`supplierInvoiceWorkflowService.ts:173` `postJournalEntry`). A
`pending_approval` bill therefore has `gl_journal_entry_id` NULL and no AP
credit, yet passes the gate and takes the payment. `recomputeInvoiceStatus`
leaves the status alone because `pending_approval` is outside `BALANCE_DERIVED`
(`invoiceStatusRecompute.ts:74`), so the bill reads unapproved and fully paid at
the same time. `disputed` is the same hole.

**Disposition: confirmed.**

**Evidence.**
- Files unchanged between `5661d6f0` and `origin/master`; status constraint read
  from the fixture schema. Reachable from `supplierPaymentApplicationService.ts:109`
  and `supplierBankPaymentService.ts:124`.
- RED test: `tests/integration/k063-supplier-payment-settles-unapproved-bill.int.test.ts`.
  A R1,000 `pending_approval` bill with no journal, and a `processed` R1,000
  payment, run through `planSupplierPaymentApplication` +
  `applySupplierPaymentPlan` inside an `als` request transaction.
  Expected a rejection and `amount_paid` 0; got no error and `amount_paid` 1000
  with `gl_journal_entry_id` still NULL. 1 test, 1 failed. Output: `red.log`.

**Proposed minimal fix.** Line 29: invert the set — allow only
`BALANCE_DERIVED`, so a status added later fails closed. The AR twin
`receiptAllocationLines.ts` needs the same check.

**Historical-data impact.** The payment's DR Accounts Payable has no matching
credit, so AP control is understated and the bill is invisible in AP aging while
cash has left. Read-only detection:

```sql
SELECT si.company_id, si.id, si.invoice_number, si.status, si.amount_paid
FROM supplier_invoices si
WHERE si.status IN ('pending_approval','disputed','draft')
  AND COALESCE(si.amount_paid,0) > 0;
```
Not run — production is out of scope. Any hit needs a correcting journal.

**Risks.** The tighter gate rejects in-flight allocations against
`pending_approval` bills — intended, but user-visible.
