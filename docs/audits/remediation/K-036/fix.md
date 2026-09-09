# K-036 fix — Paystack invoice payments now reach the general ledger

**Trigger.** For `purpose = 'customer_invoice'`, both the webhook's charge.success
branch and the portal return-page verify fallback applied the receipt with a bare
`UPDATE customer_invoices SET amount_paid/status`. Neither wrote a `customer_payments`
row, an allocation, or a journal, so the invoice read paid while accounts receivable
stayed overstated by the full amount and the bank account was never debited — the trial
balance stopped agreeing with the AR aging.

**Before / after.**
- Before: invoice `amount_paid` = total, `status` = paid, zero `customer_payments`,
  zero `gl_journal_entries`.
- After: both paths call `recordGatewayInvoiceReceipt`, which runs the canonical AR path
  (`createCustomerPayment` + `confirmCustomerPayment`): one confirmed `customer_payments`
  row (method `card`, `bank_reference` = the Paystack reference, `bank_account_id` from the
  `bank` system account) allocated to the invoice, and one posted journal DR Bank /
  CR Receivable stamped `posting_agent = system:paystack-receipt:v1` with
  `gl_journal_entry_id` on the payment. Both call sites run inside one transaction
  (`withPublicRouteTransaction`), so a GL failure cannot leave the invoice marked paid.

**Idempotency.** Guarded on `customer_payments.bank_reference = <paystack reference>`
(status <> cancelled), and enforced by migration 619's partial unique index behind it.
Whichever of webhook and verify arrives second records nothing, and a webhook redelivery
records nothing. A settlement LARGER than the invoice balance is banked in full: the whole
receipt is debited to bank and credited to the customer, the invoice absorbs only what it
owed, and the remainder stays as an unapplied receipt. Truncating it would drop real cash.

**Actor.** `customer_payments.created_by` is NOT NULL and a gateway callback has no user,
so the invoice's own `created_by` is used — resolved through `resolveUserUuid`, because that
column is `varchar` while the payment's is `uuid` and an imported author would otherwise
abort the insert. Stamped `system:paystack-receipt:v1`, never `human:<userId>`.

**Dating and fees.** The receipt is dated `paid_at`, not processing time, so a redelivery
days later still books into the settlement's period. The gateway fee, when the payload
carries one, is posted as its own DR expense / CR Bank entry so the bank leg nets to the
actual deposit. See review-fixes.md for the account-choice caveat.

**Files.** `src/modules/accounting/services/ar/gatewayInvoiceReceiptService.ts` (new),
`src/lib/publicRouteTx.ts` (new, shared with K-035), `pages/api/webhooks/paystack.ts`,
`pages/api/portal/payments/paystack/verify.ts`.

**Tests.** `tests/integration/k-036-paystack-invoice-payment-not-in-gl.int.test.ts` — 13
passed against the disposable production schema (was 2 failed / 2). Each asserts the
journal balances, that DR Bank and CR Receivable each equal the invoice's `amount_paid`,
and that the fiscal period is set. Adjacent cases: webhook + verify both firing, webhook
redelivery, part-payment, and another tenant untouched. Paystack is mocked; `chargeAuthorization`
throws if called.

**Mutation check.** Reverting both call sites to dd4f854c turns all 6 red.

**Migration / rollback.** `scripts/migrations/sql/619_customer_payments_card_reference_unique.sql`
adds a partial unique index behind the idempotency read. Rollback: `DROP INDEX
ux_customer_payments_card_reference`.

**Historical-data impact.** The query below was run read-only against production `isaflow`
once, before the instruction arrived not to query production; it is recorded here rather
than re-run. One affected receipt, R115,370.58, company `00000000-0000-0000-0000-000000000001`
("ISAFlow Demo (Pty) Ltd"), invoice INV-00553, 2026-05-01. No other tenant is affected and
no unprocessed webhook events exist. No data was repaired.
```sql
SELECT pr.company_id, count(*) AS receipts, sum(pr.amount_cents)/100.0 AS unposted_rand
FROM paystack_payment_requests pr
JOIN customer_invoices ci ON ci.id = pr.customer_invoice_id
WHERE pr.purpose = 'customer_invoice' AND pr.status = 'completed'
  AND NOT EXISTS (SELECT 1 FROM customer_payments cp
                  WHERE cp.company_id = pr.company_id
                    AND cp.bank_reference = pr.paystack_reference AND cp.status <> 'cancelled')
GROUP BY pr.company_id;
```

**Limits.** A company without a `bank` or `receivable` system account now fails the
webhook with a 500 instead of silently marking the invoice paid; K-035 makes that a
retryable delivery rather than a lost one. Historical receipts are not backfilled.

**Follow-up in the same branch.** The route file crossed the 300-line limit once the
receipt call was added (it was already 329 on master). The four event handlers moved
verbatim to `src/modules/billing/services/paystackEventHandlers.ts`; route 152 lines,
handlers 215. No logic change — both suites still 12 passed, full unit suite 9320 passed.
