# R-167 — a portal payment link charges its own amount, capped at the balance, and a payment spends it

## Defect

`pages/api/portal/payments/paystack/create.ts` read only the link's invoice, status and expiry.
It never read the link's amount, and charged `total_amount - amount_paid`.

- A part-payment link showed its own amount on the pay page (`data.amount`) and charged the whole
  balance. A R40.50 link on a R115 invoice charged R115.
- A legacy row with a negative `amount_paid` was charged more than the invoice total: -50 paid on
  R115 charged R165.
- A NaN `amount_paid` produced NaN cents. `NaN <= 0` is false, so the "already paid" guard was
  skipped, and the INSERT then failed as a 500.
- The invoice lookup had no status or `deleted_at` filter, so an old link on a cancelled or
  soft-deleted invoice could still be charged.
- Nothing ever marked a link paid: `markPaymentLinkPaid` has no caller. A paid link therefore
  stayed payable.

Hein decided on 2026-09-30:

- a link charges its amount, capped at the balance;
- a link is spent by one payment, with the migration below.

## Fix

- **`src/modules/accounting/services/ar/portalLinkCharge.ts` (new):**
  - `resolveLinkCharge(token)` is the one place that decides what a link may charge:
    `min(link amount, total_amount - GREATEST(amount_paid, 0))`, in numeric, from one query
    that starts at the token.
  - NaN charges nothing. Numeric NaN sorts above every number, so `LEAST` alone would ignore it.
  - A cancelled or soft-deleted invoice gives `invoice_gone`, and a charge of zero or less gives
    `nothing_owed`. An unknown, inactive or expired link keeps its existing refusal.
  - `spendPaymentLinkOfRequest(companyId, reference)` marks the request's link `paid`, sets
    `paid_at` and stores the reference. It acts only on a `completed` request and only while the
    link is `active`.
- **`paystack/create`:**
  - charges `chargeCents`;
  - stores it as the request's `amount_cents`;
  - records `portal_payment_link_id`.

  Settlement already posts that `amount_cents` through `recordGatewayInvoiceReceipt`, which
  allocates `min(amount, outstanding)` and banks any excess as an unapplied receipt. The ledger
  path is therefore unchanged.
- **`recordGatewayInvoiceReceipt`:**
  - calls `spendPaymentLinkOfRequest` first;
  - the webhook and the verify route both settle through it, inside their settlement transaction;
  - whichever arrives first spends the link, and a redelivery changes nothing.
- **The public `payment-link` GET:**
  - shows the amount `create` would charge;
  - answers 404 for a link `create` would refuse (an invoice that is cancelled, deleted or owes
    nothing).
- **Migration 717:**
  - adds `paystack_payment_requests.portal_payment_link_id UUID`, which is nullable, references
    `portal_payment_links(id)` with `ON DELETE SET NULL`, and has a partial index;
  - does no backfill. Requests from before 717, and every non-portal purpose, carry no link and
    spend none.

## Not changed

- **Links created before this change** stay payable until they expire or are paid under the new
  code. A request created before 717 has no link to spend.
- **Two checkouts from one link.** If both are paid, both settle. The second is capped by the
  balance, and any excess is banked as an unapplied, refundable receipt. Retries are not blocked,
  because an abandoned checkout stays `pending` and would lock the customer out.
- **`portalService.markPaymentLinkPaid(token, reference)`** is now dead code. It had no caller
  before this change and none after. It was left in place, as the rules require for unrelated
  dead code.
- **`k-035-webhook-redelivery-discarded`** fails 4 of 6. It fails identically on clean
  origin/master `66e776d81` against the same fixture. It covers the mandate (`authorization`)
  branch, which this change does not touch.

## Tests

`tests/integration/r167-link-charges-link-amount.int.test.ts` has 16 cases. Paystack is mocked:
`initializeTransaction` records the amount it is asked to charge, the webhook is delivered signed,
and `verifyTransaction` is stubbed.

- **`create` charges:**
  - a R40.50 link on an unpaid R115 invoice charges 4050;
  - a R40.50 link on an invoice with R30 left charges 3000;
  - a legacy R200 link on a -50 row charges 11500.

  Each stored request carries that amount and its link.
- **`create` refuses before the gateway**, with no request stored:
  - a paid invoice or a NaN `amount_paid` gets 400;
  - a cancelled or soft-deleted invoice gets 404;
  - an unknown token gets 404, naming the payment link;
  - an expired link gets 400.
- **The webhook:**
  - marks the link `paid` with its reference, and a redelivery changes nothing;
  - leaves another link on the same invoice `active`;
  - banks R40.50;
  - after this, the GET answers 404 and a second `create` gets 400 "Payment link not active".
- **The verify route** marks the link paid when it settles first.
- **Links that must stay as they are:**
  - a link cancelled after checkout started stays `cancelled`;
  - a pre-717 request with no link settles and touches no link.
- **The GET** shows 30 for a R40.50 link with R30 left, and answers 404 for a link on a paid or
  cancelled invoice.

Each run uses a fresh client IP. The verify route rate-limits per IP (30 per 15 minutes), and that
counter persists between runs.

Evidence:

- `red.int.log`: 11 of 13 original cases fail on origin/master `66e776d81` with migration 717
  applied. The two that pass cover behaviour that was already right.
- `green.log`:
  - this suite, 16/16;
  - k-036 (Paystack to GL), every k095 and k096 Paystack suite, k-033;
  - r158, r166, k101, r155-157, r157;
  - the k122 suites and the three r095 portal suites;
  - customer-ownership-fence-routes, on an `isaflow_test` copy of the fixture.
- `mutations.log`: 23 of 23 mutants are RED. They cover:
  - each filter (cancelled, deleted, NaN), `LEAST` on either side, and the negative clamp;
  - every refusal and its HTTP mapping;
  - the spend, and its status condition;
  - the stored link, the charged amount and the stored amount;
  - the GET's amount and its 404.

## Migration / rollback

- **Migration 717 is additive** and uses `IF NOT EXISTS`. `deploy.sh` applies it before the
  rsync. To roll back, revert the PR. The column can stay: nothing else reads it.
