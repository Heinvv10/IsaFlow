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
request by `customer_payments.bank_reference = paystack_reference`. No migration: Hein approved
this marker over one on 2026-10-02, on three conditions, each tested:

- **The note never costs the receipt.** The UPDATE runs in its own savepoint
  (`withSavepoint('gateway_review_note')`). A failure is logged at error level, not thrown. Outside a
  savepoint a failed write aborted the settlement transaction; the webhook answered 500 and the
  receipt rolled back (`red.r2.int.log`).
- **A prior reason is not overwritten silently.** A non-review `failure_reason` the request already
  carried is kept after the note (`review:amount_mismatch | previously: abandoned while starting`,
  the reason `portalLinkCharge` writes on a checkout swept while starting) and named in the log as
  `previousFailureReason`. An earlier review note is merged with the new reasons (review round 1:
  the second report adds to the first, never erases it).
- **The unapplied case is visible.** A receipt banked against an invoice outside the ledger is
  asserted in `getUnappliedReceipts` (the `list_unapplied_receipts` service) for the customer, at
  the full amount.

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
    currency, the prior reason, the invoice and what was banked and allocated. See the three
    conditions above.
- **`gatewayInvoiceReceiptService.recordGatewayInvoiceReceipt`** now takes `requestedCents` and
  `reported` instead of `amountRand`. It reads the invoice's `status` and `deleted_at`. An invoice
  outside the ledger is allocated 0, so the whole receipt is banked unapplied on the customer
  through the existing over-settlement path. The flag is written in the same transaction as the
  receipt. A second delivery banks nothing; since review round 1 it compares its amount with
  what was banked (below).
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
  allocated 0, invoice `amount_paid` untouched, flagged, logged, and listed as unapplied for the
  customer.
- The note write made to fail for real (22012 inside the transaction): 200, the receipt banked, the
  request completed, no note, the failure logged.
- A prior `abandoned while starting` reason is kept after the note and logged. A prior review note
  is merged with the new reasons, and its own prior reason kept.
- Webhook then verify, and verify then webhook: one receipt, the reported amount, in either order.
- Tenant isolation: a flagged settlement in company A writes nothing in company B. A request in A
  naming B's invoice settles nothing (500, rolled back).

Evidence: `red.int.log` (12 of 14 red on the unchanged code, origin/master 82bd2afdc; the
unreported-amount and completed-branch cases were added after it), `red.r2.int.log` (the two
note-condition tests red on the round-1 note write, 5d312dc1e), `red.r3.int.log` (review round 1:
12 of 31 red on f7ef79b60/028c26bcf), `green.int.log` (31/31 over both R-181 suites),
`mutations.log` (43 mutants over every guard in the final code: 42 killed, 1 equivalent),
`regression.int.log` (187/187: k-036, k095*, k096, r166, r167*, r177, r178, k101, r181*). The full
unit suite passed (1281 files) on ce90064fd.

`k-036` changed: its part-payment and over-settlement cases seeded a request for R400 / R1,650
but delivered a webhook reporting R1,150. Their deliveries now report the settled amount, as
Paystack's would.

## Review round 1

Both blind reviewers scored 5d312dc1e (general: FIX, adversarial: SHIP). The overwrite finding was
already closed by f7ef79b60. The rest, fixed in ce90064fd and a684f6f64:

1. **MEDIUM — a fee the customer paid became customer credit.** When the Paystack account passes
   charges to the customer, `amount` = `requested_amount` + fee. A R115 invoice paid at R118.50
   banked R118.50: R115 allocated, R3.50 unapplied credit, the fee expensed as well, and every
   settlement flagged. `requested_amount` is a field of Paystack's transaction (Paystack OpenAPI
   `VerifyResponse.requested_amount: integer`; the repo had no recorded payload carrying it, and
   no fixture under `tests/fixtures`). The webhook passes `data.requested_amount`;
   `verifyTransaction` maps it to `requestedAmountCents` (unit-tested). When present it is the
   receipt and the comparison with the request. `merchantFee` posts only the fee the merchant
   bore, `fees - (amount - requested_amount)`, so Bank nets to `amount - fees`, what Paystack
   settles. Proven for both account modes: passed on (Bank R115, no fee expense) and borne by the
   merchant (Bank R111.50, fee R3.50), and with no `requested_amount` (today's rule). An `amount`
   below `requested_amount` makes the latter untrustworthy: the amount is banked, no fee is credited
   back, and it is flagged `amount_below_requested_amount`.
2. **LOW — non-ZAR.** Still banked (Hein). The receipt description names the reported currency
   and amount (`(USD 115.00 reported, booked as ZAR)`). Its fee is not posted as rand; it is
   flagged `fee_not_posted_currency`.
3. **LOW — the second report was never compared.** The dedupe path now compares its amount with
   the banked `total_amount` and flags `amount_disagrees_with_first_report`, logging both figures.
   Both orders tested. Verify only asks Paystack about a request that is not completed, so
   "webhook first" is the webhook landing while verify's gateway call is out; the test does that.
   Review notes now MERGE: the second report adds reasons to the first and never erases them.
4. **LOW — an overpayment matching the request** (invoice already paid by EFT) is flagged
   `overpaid_unapplied`: the customer is owed a refund or a placement.
5. **LOW (pre-existing) — over-allocation race.** `decideGatewayAllocation`
   (`gatewayReceiptAllocation.ts`) locks the invoice row through `withCustomerInvoiceLock` (5s,
   typed timeout) and re-reads status, `deleted_at` and balance under the lock. Lock order: the
   receipt's own `customer_payments` row is inserted first, then the invoice is locked
   (payment-then-invoice, the canonical sequence in `bank/.claude.md`). A timeout loses nothing:
   the settlement rolls back, the webhook answers 500 and Paystack redelivers; verify logs it and
   leaves the request pending (tested: lock held by another connection, webhook 500, verify
   pending, nothing banked; released, the redelivery banks it). The race test holds the first
   settlement's locked read open for 1.5s while a second settlement for the same invoice starts:
   one allocates R115, the other 0 (and is flagged overpaid). The hook asserts it fired.
6. **LOW — tests.** The r167 and k-036 verify mocks now report an amount and ZAR, so their normal
   settlements no longer take the fallback path. The comment names the column, not "the same
   marker". The blocked and overpaid cases assert the receivable credit leg and that every journal
   for the reference balances (`ledger()` in the helpers).
7. **Recorded, not changed.** The review flag is not shown anywhere in the UI: Hein chose the log
   line and the note. The `company_id` predicate on the flag UPDATE is an equivalent mutant: the
   reference is unique across the table, so no test can tell it apart; it stays as tenant scoping.

Tests for this round: `tests/integration/r181-review-round1.int.test.ts` (12 cases) and a
`requested_amount` mapping case in `tests/unit/services/billing/paystackClient.test.ts`. The race
case had no meaningful red on the old code (its hook targets the new locked read and fails on
"hook did not fire"); the proof that the lock matters is mutant M36, which removes `FOR UPDATE` and
turns it red.

Not changed and worth knowing: `paystackClient.ts` was already over 300 lines (425) before this
change; three lines were added to it.
