# K-036 — Paystack invoice payments never reach the general ledger

**Claim (AA C19):** the webhook and the verify route update `amount_paid` only, creating no payment row and no journal.

**Corrected trigger:** for `purpose = 'customer_invoice'`, `handleChargeSuccess` updates `customer_invoices.amount_paid`/`status` and returns (`git show ebeac9ca:pages/api/webhooks/paystack.ts` lines 227-240). The return-page fallback repeats exactly the same single UPDATE (`.../pages/api/portal/payments/paystack/verify.ts` lines 80-96). Neither writes a `customer_payments` row, a `customer_payment_allocations` row, or a journal. The canonical path does all three: `confirmCustomerPayment` posts `DR Bank / CR Receivable` via `createJournalEntry` + `postJournalEntry`, then updates `amount_paid` and stamps `gl_journal_entry_id` (`src/modules/accounting/services/ar/customerPaymentAllocationService.ts` lines 32-96). Net effect: the invoice reads paid, accounts receivable stays overstated by the full amount, and the bank account is never debited — the trial balance no longer agrees with the AR aging.

**Disposition: confirmed.**

**Reachability:** public webhook (`/api/webhooks/paystack`) and public verify route (`/api/portal/payments/paystack/verify`), both fed by the customer portal pay-now flow (`pages/api/accounting/customer-invoices/[id]/pay-now.ts`, `pages/api/portal/payments/paystack/create.ts`).

**Evidence**
- RED `tests/integration/k-036-paystack-invoice-payment-not-in-gl.int.test.ts` on the disposable production schema, `verifyTransaction` mocked and `chargeAuthorization` stubbed to throw (no network; the webhook route calls neither). `bun run test:integration -- <file>` → **2 failed / 2** (`red.log`).
  - both paths leave `amount_paid = 1150.00` and `status = 'paid'` (asserted and passing);
  - both leave zero rows in `customer_payments` and zero in `gl_journal_entries`.
- Both files unchanged 5661d6f0..ebeac9ca.

**Proposed minimal fix**
1. Extract the invoice-settlement write into one service, e.g. `recordGatewayInvoiceReceipt(companyId, invoiceId, amountRand, reference)` in `src/modules/accounting/services/ar/`.
2. Have it call `createCustomerPayment` (method `'card'`, bank account from `getSystemAccount('bank', companyId)`, allocation = the invoice) then `confirmCustomerPayment`, so the existing GL posting and `amount_paid` update are reused rather than duplicated. `customer_payments.created_by` is NOT NULL and a webhook has no user, so the service needs a system actor id (the invoice's `created_by` is the cheapest correct choice) plus `postingAgent` set for the audit trail.
3. Replace the raw `UPDATE customer_invoices` in both call sites with that service, guarded for idempotency on `paystack_payment_requests.paystack_reference`.
4. Run it inside the transaction added for K-035 fix 3, so a GL failure does not leave the invoice marked paid.

**Historical-data impact:** every completed Paystack invoice receipt is missing from the ledger. Sum below is the amount by which AR is overstated and bank understated.
```sql
SELECT pr.company_id, count(*) AS receipts, sum(pr.amount_cents)/100.0 AS unposted_rand,
       min(pr.completed_at) AS first_at, max(pr.completed_at) AS last_at
FROM paystack_payment_requests pr
JOIN customer_invoices ci ON ci.id = pr.customer_invoice_id
WHERE pr.purpose = 'customer_invoice' AND pr.status = 'completed'
GROUP BY pr.company_id;
```
Backfill must post one journal per historical receipt into an open fiscal period, not restate closed ones.

**Risks:** the fix makes a public webhook a GL writer — it needs the `receivable` and `bank` system accounts resolved for the company, and `confirmCustomerPayment` throws when the bank account is missing, which would turn a settled card payment into a 500 and (before K-035's fix) a dropped event. Land K-035 first. Per the repo's adversarial-review rule, any PR writing `gl_journal_entries` gets a policy-break review round.
