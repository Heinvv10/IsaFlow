# R-181 — Paystack settlement banks the reported amount, never settles an invoice outside the ledger

## Defect

- The webhook (`handleChargeSuccess`, both its branches) and the return page's `verify` route
  settled through `recordGatewayInvoiceReceipt` with `Number(pr.amount_cents) / 100`: the amount
  the checkout ASKED for. `event.data.amount` and `verifyTransaction().amountCents`, the amount
  Paystack says it RECEIVED, were never read. A difference would be banked at the wrong value with
  no log line.
- Settlement had no rule on the invoice. A checkout opened before an invoice went back to draft,
  pending approval, cancelled or soft-deleted could still be paid, and the receipt was allocated
  to an invoice that is not in the ledger (`documentInPopulation` false). That moved
  `amount_paid` on a document no AR report counts.

## Decision (Hein, 2026-10-02)

Bank what Paystack actually received, log an error and flag the receipt for review. On an invoice
outside the ledger, still bank the money (it was received) but do not allocate it.

## Review mechanism

There is no review or exception flag on receipts or bank lines. `customer_payments` has no
flag, note or review column. The fixture schema has no review/exception column on any receipt or
bank table. The two alert tables do not fit: `compliance_alerts` is AFS-only with one active row
per company and type, and `fraud_alerts` needs a supplier.

The closest existing marker is used: `paystack_payment_requests.failure_reason` on the COMPLETED
request. `noteAuthorisationNotAttached` already writes it on a completed request to mean "the card
was charged and nothing could be attached". The value is `review:<reasons>`, comma-joined:
`amount_mismatch`, `amount_not_reported`, `currency_mismatch`, `invoice_draft`,
`invoice_pending_approval`, `invoice_cancelled`, `invoice_deleted`. The receipt is found from the
request by `customer_payments.bank_reference = paystack_reference`. No migration.

Limit: nothing in the app shows `failure_reason` for a customer-invoice request yet. The flag can
be queried, and the `log.error` line is what alerts someone. An invoice outside the ledger also
leaves an unapplied receipt on the customer, and that does show in the unapplied-receipts list.

## Fix

- **`src/modules/accounting/services/ar/gatewaySettlementReview.ts` (new).**
  - `settledCharge(requestedCents, reported)` returns the cents to bank and why they need review.
    It banks the reported amount when that is a positive integer. A missing, zero or fractional
    amount falls back to the request amount, flagged `amount_not_reported`; refusing would make
    every webhook redelivery fail. A difference is `amount_mismatch`. A currency other than `ZAR`
    is `currency_mismatch`.
  - `invoiceReview(status, deletedAt)` returns `invoice_deleted` for a soft-deleted invoice,
    `invoice_<status>` for one outside `documentInPopulation`, or null.
  - `flagSettlementForReview` writes the flag, scoped by `company_id` and reference, and logs at
    error level with the company, the reference, expected and reported cents, the reported
    currency, the invoice and what was banked and allocated.
- **`gatewayInvoiceReceiptService.recordGatewayInvoiceReceipt`** now takes `requestedCents` and
  `reported` instead of `amountRand`. It reads the invoice's `status` and `deleted_at`. An invoice
  outside the ledger is allocated 0, so the whole receipt is banked unapplied on the customer
  through the existing over-settlement path. The flag is written in the same transaction as the
  receipt, and only when the receipt is created: the reference dedupe returns before it, so a
  second delivery neither banks again nor rewrites the flag.
- **Callers.** The webhook passes `{ amountCents: event.data.amount, currency: event.data.currency }`
  on both branches. `verify` passes `{ amountCents: live.amountCents, currency: live.currency }`.
  Both report the same Paystack transaction, so whichever arrives first banks the same amount.

## Argument against

- **Currency.** A non-ZAR charge is banked as if its minor units were cents of rand and is still
  allocated. That follows the decision ("bank the reported amount"), but the figure is wrong in a
  different way. A Paystack ZA merchant settles only in ZAR, so this is a flag for an
  impossible-in-practice case, not a conversion.
- **The flag lives on the request, not the receipt.** A reviewer has to join through the
  reference. A real review column on `customer_payments` would need a migration, and that was not
  approved.
- **Missing amount falls back to the request.** If verify got no amount and the webhook later
  reported a different one, the first to arrive wins and the amounts could differ. Paystack always
  reports both, and the fallback is flagged.
- **No surface.** A flagged receipt is only found through the log or a query until something
  reads `failure_reason`.

## Tests

`tests/integration/r181-settlement-amount.int.test.ts` (helpers in `r181-settlement.helpers.ts`).
Real Postgres, the real webhook route and verify route. Only `paystackClient` is stubbed.

- Reported = requested: unchanged behaviour, no flag, no error log.
- Reported < requested (R50 of R115): R50 banked and allocated, flagged, logged with expected and
  reported cents.
- Reported > requested (R200): R200 banked, R115 allocated, R85 unapplied, flagged.
- Currency USD: banked, flagged, logged with the reported currency.
- No amount, 0, or 115.5 cents: the request amount banked, flagged `amount_not_reported`.
- A request already completed with nothing banked: the webhook's completed branch banks the
  reported amount.
- Verify banks what Paystack verified.
- Draft, pending approval, cancelled, soft-deleted (webhook), and draft (verify): banked in full,
  allocated 0, invoice `amount_paid` untouched, flagged, logged.
- Webhook then verify, and verify then webhook: one receipt, the reported amount, in either order.
- Tenant isolation: a flagged settlement in company A writes nothing in company B. A request in A
  naming B's invoice settles nothing (500, rolled back).

Evidence: `red.int.log` (12 of 14 red on the unchanged code, origin/master 82bd2afdc; the
unreported-amount and completed-branch cases were added after it), `green.int.log` (16/16),
`mutations.log` (16 mutants: 15 killed, 1 equivalent), `regression.int.log`.

`k-036` changed: its part-payment and over-settlement cases seeded a request for R400 / R1,650
but delivered a webhook reporting R1,150. Their deliveries now report the settled amount, as
Paystack's would.
