# R-167 — a portal payment link charges what it should, and an explicit-amount link is spent by its payment

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
- a link is spent by one payment, with the migration below;
- after review round 1, there are **two kinds of link**:
  - the invoice's standing "Pay now" link is the one `customer_invoices.payment_url` names, minted
    by `pay-now` and `enableOnlinePayment`. It charges the live balance and is never spent;
  - an explicit-amount link, from the portal `payment-link` POST, charges its own amount, capped
    at the balance, and one payment spends it.

## Fix

- **`src/modules/accounting/services/ar/portalLinkCharge.ts` (new):**
  - `resolveLinkCharge(token)` is the one place that decides what a link may charge. A standing
    link charges the live balance, `total_amount - GREATEST(amount_paid, 0)`. An explicit link
    charges `min(link amount, that balance)`. Both are computed in numeric, from one query that
    starts at the token.
  - A NaN balance or NaN link amount charges nothing. Numeric NaN sorts above every number, so
    `LEAST` alone would silently drop it.
  - A cancelled or soft-deleted invoice gives `invoice_gone`, and a charge of zero or less gives
    `nothing_owed`. Only a link whose status is exactly `active` is chargeable.
  - `lockPaymentLink`, `findReusableCheckout` and `CHECKOUT_REUSE_MINUTES` (30) serve create's
    one-checkout rule.
  - `spendPaymentLinkOfRequest(companyId, reference)` marks an explicit link `paid`, sets
    `paid_at` and stores the reference. It acts only on a `completed` request of that company,
    only while the link is `active`, and never on a standing link.
- **`paystack/create`:**
  - runs in one `withPublicRouteTransaction`, with the link row locked;
  - resolves the charge, then hands out a pending checkout started from the same link, for the
    same amount, in the last 30 minutes, instead of starting a second one;
  - otherwise starts one, stores `amount_cents` = the charge, and records
    `portal_payment_link_id`;
  - answers only after COMMIT.

  Settlement already posts that `amount_cents` through `recordGatewayInvoiceReceipt`, which
  allocates `min(amount, outstanding)` and banks any excess as an unapplied receipt.
- **`recordGatewayInvoiceReceipt`:** calls `spendPaymentLinkOfRequest` first. The webhook and the
  verify route both settle through it, inside their settlement transaction.
- **`pay-now` and `enableOnlinePayment`:** mint their link with `charges_balance = true`.
- **The public `payment-link` GET:**
  - shows what `create` would charge;
  - on an invoice that owes nothing, answers 400 "This invoice has no outstanding balance",
    which the pay page shows;
  - on a cancelled or deleted invoice, answers 404.
- **Migration 717:**
  - adds `paystack_payment_requests.portal_payment_link_id UUID`, which is nullable, references
    `portal_payment_links(id)` with `ON DELETE SET NULL`, and has a partial index. There is no
    backfill: requests from before 717 carry no link;
  - adds `portal_payment_links.charges_balance BOOLEAN NOT NULL DEFAULT false`;
  - backfills `true` on every link an invoice's `payment_url` names. The backfill is idempotent.

## Not changed

- **Explicit links created before this change** stay payable until they expire or are paid
  under the new code. A request created before 717 has no link to spend.
- **Checkouts started more than 30 minutes apart, or for different amounts, are both valid.**
  If both are paid, both settle, and any excess is banked as an unapplied, refundable receipt.
  A click inside the window gets the same checkout, so a double click or a back-and-retry is
  charged once.
- **`portalService.markPaymentLinkPaid(token, reference)`** is dead code. It had no caller before
  this change and none after. It was left in place, as the rules require for unrelated dead code.
- **`k-035-webhook-redelivery-discarded`** fails 4 of 6. It fails identically on clean
  origin/master `66e776d81` against the same fixture. It covers the mandate (`authorization`)
  branch, which this change does not touch.
- **Pre-existing, outside this change** (review round 1, recorded as follow-ups):
  - `pay-now`'s own charge still computes `total - amount_paid` in JS, with no NaN or negative
    clamp;
  - settlement books `amount_cents` without comparing it to the event's amount and currency.

## Tests

Two suites share `tests/integration/r167-portal-links.helpers.ts`. In both, Paystack is mocked:
`initializeTransaction` records the amount it is asked to charge, the webhook is delivered
signed, and `verifyTransaction` is stubbed. Each run uses a fresh client IP, because verify
rate-limits per IP and that counter persists between runs.

`r167-link-charges-link-amount.int.test.ts` covers explicit links, 20 cases:

- **`create` charges:**
  - 4050 for R40.50 on an unpaid invoice;
  - 3000 when R30 is left;
  - 11500 for a legacy R200 link on a -50 row;
  - 4050 with a NULL `amount_paid`.

  Each stored request carries its amount and link.
- **`create` refuses, with no gateway call:**
  - a paid invoice or a NaN `amount_paid` gets 400;
  - a cancelled or deleted invoice gets 404;
  - a NaN link amount, an unknown token (404, naming the link), an expired link, and a link with
    a NULL status are refused.
- **Spend:**
  - the webhook spends the link, once, keeps another link on the same invoice active, and banks
    R40.50; a second `create` then gets "Payment link not active";
  - the verify route also spends it;
  - a link cancelled after checkout stays cancelled;
  - a pre-717 request touches no link;
  - `spendPaymentLinkOfRequest` does nothing for a pending request or another company.
- **The GET** shows 30 for a R40.50 link with R30 left. It says "This invoice has no
  outstanding balance" on a paid invoice, and answers 404 on a cancelled one.

`r167-standing-links-and-checkout.int.test.ts` covers the other two rules, 8 cases:

- **A standing link:**
  - charges the live balance: 3000 when minted at 115 with R30 owed, and 15000 after the
    invoice grew to R150;
  - stays active after a payment, and charges the rest after a receipt is reversed;
  - is minted with `charges_balance` by both `enableOnlinePayment` and `pay-now` (through the
    real authenticated route);
  - is what migration 717's backfill marks. Other links, including an explicit link on the same
    invoice, are left alone.
- **One checkout per click:**
  - a second click gets the same checkout and is charged once;
  - a new checkout starts after 30 minutes, or when the amount changed;
  - a completed checkout is never handed out again.

Evidence:

- `red.int.log`: 11 of 13 original cases fail on origin/master `66e776d81` with 717 applied.
- `red.r1.int.log`: the round-1 cases against the round-0 source `cabe94705`. 3 of 20 and 4 of 8
  fail. The others pin boundaries the round-0 code happened to meet, such as always starting a
  new checkout; the mutants below prove them.
- `green.log`:
  - both suites;
  - k-036, every k095 and k096 Paystack suite, and k-033;
  - r158, r166, k101, r155-157, r157 and the r159 suites;
  - the k122 suites and the three r095 portal suites;
  - customer-ownership-fence-routes, on an `isaflow_test` copy of the fixture.
- `mutations.log`: 37 of 37 round-1 mutants are RED. They cover:
  - every filter and each arm of the charge;
  - both link kinds, and the clamp;
  - every refusal and its HTTP mapping;
  - the spend's four conditions;
  - the reuse's amount, status and window, and reuse itself;
  - the stored link and amounts;
  - both GET branches;
  - both writers' `charges_balance`;
  - the backfill's value and scope.

## Review round 1

The adversarial reviewer returned FIX: 2 MEDIUM and 4 LOW.

- **MEDIUM, the invoice's standing link.** It records the balance at mint time and is reused
  forever, so under round 0 it would have charged a stale figure and died after one payment.
  Hein chose two kinds of link, and that is built above.
- **MEDIUM, two checkouts from one link.** Both could be paid, and round 0's fix.md wrongly said
  the second would be capped. Fixed by the locked, reusable checkout, and fix.md corrected.
- **LOW, NULL-status link:** chargeable but never spendable. Now refused.
- **LOW, NaN link amount:** charged the whole balance. Now refused.
- **LOW, paid invoice's link:** said "not found". It now says the invoice has no outstanding
  balance.
- **LOW, tests:** the spend's company and status conditions, and a NULL `amount_paid`, are now
  covered.

The general reviewer's first verdict, on round 0 (`cabe94705`), was SHIP with four LOWs. Three
were already fixed by round 1: the spend's `completed` condition is now tested, a NaN link amount
is refused, and the invoice's `payment_url` link is now a standing link that is never spent. The
fourth is fixed in round 1 too. Three settlement tests never asserted that the webhook delivery
succeeded, so a failing delivery would have left the link untouched and passed. They now assert a
200 and the banked receipt.

## Migration / rollback

- **Migration 717 is additive** and uses `IF NOT EXISTS`. It adds two columns and one
  idempotent backfill. `deploy.sh` applies it before the rsync.
- **To roll back,** revert the PR. The columns can stay, because nothing else reads them.
