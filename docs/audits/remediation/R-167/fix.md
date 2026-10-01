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
  - `lockPaymentLink`, `existingCheckout`, `recordStartingCheckout`, `checkoutStarted` and
    `checkoutFailed` serve create's one-checkout rule. `CHECKOUT_REUSE_MINUTES` is 30 and
    `CHECKOUT_STARTING_SECONDS` is 60.
  - `spendPaymentLinkOfRequest(companyId, reference)` marks an explicit link `paid`, sets
    `paid_at` and stores the reference. It acts only on a `completed` request of that company,
    only while the link is `active`, and never on a standing link.
- **`paystack/create`** is rate-limited per client IP (60 per 15 minutes) and per link (20 per 15
  minutes, keyed by a hash of the token). The limiter writes its own counter, but nothing touches
  a payment table until it passes. Then it runs in three phases, so no
  connection or lock is held while Paystack answers (review round 2):
  1. **A short `withPublicRouteTransaction`, with the link row locked.** It resolves the charge
     and then does one of three things:
     - hands out a pending checkout from the same link, for the same amount, started in the last
       30 minutes;
     - answers 409 if one recorded in the last minute has no URL yet, because it is still
       starting;
     - otherwise records the checkout (a pre-generated reference, `amount_cents` equal to the
       charge, `portal_payment_link_id`) with no URL.

     Then it COMMITs.
  2. **The gateway call.** `initializeTransaction` runs outside any transaction, bounded at 10
     seconds. It takes a new, optional `timeoutMs`; other callers leave it unset and are
     unchanged.
  3. **The result.** On success the recorded checkout gets its access code and URL. If it is no
     longer `pending`, because a stall let a later click sweep it, the URL is not handed out and
     the click gets 500. On failure or timeout it is marked `failed`, and a later click starts
     afresh.

  If phase 2 or 3 never finishes (the process dies), the checkout keeps no URL. It stops blocking
  after 60 seconds, and the next click on that link marks it `failed` ("abandoned while
  starting") under the lock (review round 3).

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
    `portal_payment_links(id)` with `ON DELETE SET NULL`, and has a partial index. Requests from
    before 717 carry no link;
  - adds `portal_payment_links.charges_balance BOOLEAN NOT NULL DEFAULT true`. The default is
    what keeps existing links safe, not a backfill (review round 2). Every link that exists today
    stays standing, and so does any link the previous code mints between the migration and the
    code switch (`deploy.sh` migrates before it rsyncs). So does an older standing link an
    invoice no longer names. Only `portalService.createPaymentLink` (the POST) writes `false`.

## Not changed

- **Links created before this change** are all standing, so they behave exactly as before: they
  charge the live balance and are never spent. That includes any explicit-amount link created
  before the deploy. Hein decided this on 2026-10-01 (review round 3, LOW 1). Marking
  links `false` whenever no `payment_url` names them would reopen the two round-2 gaps. The pay
  page now shows the full balance before the customer pays, so what they see is what they are
  charged. The R-155 prod census found 3 active links, all in ISAFlow Demo. A request created
  before 717 has no link to spend.
- **Anyone holding a link's token can use up its per-link limit** (20 starts in 15 minutes) and
  block that link for the rest of the window (review round 3, LOW 3). Accepted: the token is
  the credential to pay, so a holder could already pay. The per-IP limit also applies.
- **Standing links still expire after 30 days**, from the column default in migration 235.
  `pay-now` keeps handing out an expired `payment_url` (review round 2, LOW 4). This was already
  true before this change. Recorded as a follow-up: mint standing links with no expiry, or
  re-mint when the stored link is not payable.
- **Checkouts started more than 30 minutes apart, or for different amounts, are both valid.**
  If both are paid, both settle, and any excess is banked as an unapplied, refundable receipt.
  A click inside the window gets the same checkout, so a double click or a back-and-retry is
  charged once.
- **`portalService.markPaymentLinkPaid(token, reference)`** is dead code. It had no caller before
  this change and none after. It was left in place, as the rules require for unrelated dead code.
- **`k-035-webhook-redelivery-discarded`** fails 4 of 6. It fails identically on clean
  origin/master `66e776d81` against the same fixture. It covers the mandate (`authorization`)
  branch, which this change does not touch.
- **Pre-existing, outside this change** (reviews, recorded as follow-ups):
  - `checkRateLimit`'s in-process cache counts calls below half the limit locally and never
    writes them to the shared counter. One process therefore admits several times the configured
    limit: about 70 calls for a limit of 20. This affects every caller, including `verify`.
    Found while testing the new limits; the test seeds the shared counter instead;
  - `pay-now`'s own charge still computes `total - amount_paid` in JS, with no NaN or negative
    clamp;
  - settlement books `amount_cents` without comparing it to the event's amount and currency.

## Tests

Two suites share `tests/integration/r167-portal-links.helpers.ts`. In both, Paystack is mocked:
`initializeTransaction` records the amount it is asked to charge, the webhook is delivered
signed, and `verifyTransaction` is stubbed. Each run uses a fresh client IP, because verify
rate-limits per IP and that counter persists between runs.

`r167-link-charges-link-amount.int.test.ts` covers explicit links, 28 cases:

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
- **The payer:** an invoice naming another company's customer is charged as "Customer" with the
  synthetic payer email, never under that customer's name or email.
- **The GET** shows 30 for a R40.50 link with R30 left. It says "This invoice has no
  outstanding balance" on a paid invoice, and answers 404 on a cancelled one.

`r167-standing-links-and-checkout.int.test.ts` covers the other rules, 19 cases:

- **A standing link:**
  - charges the live balance: 3000 when minted at 115 with R30 owed, and 15000 after the
    invoice grew to R150;
  - stays active after a payment, and charges the rest after a receipt is reversed;
  - is minted with `charges_balance` by both `enableOnlinePayment` and `pay-now` (through the
    real authenticated route);
  - is what a link written without the flag becomes, while `createPaymentLink` writes an
    explicit one.
- **One checkout per click:**
  - a second click gets the same checkout and is charged once;
  - a new checkout starts after 30 minutes, or when the amount changed;
  - a completed checkout is never handed out again.
- **Nothing held across the gateway call:**
  - a click waits for a `FOR NO KEY UPDATE` another connection holds on the link, then starts
    exactly one checkout. That lock conflicts only with create's own `FOR UPDATE`, not with the
    foreign-key lock the INSERT takes;
  - while the gateway is answering, the link can be locked `NOWAIT`, the checkout is already
    recorded, and the call carries the 10-second bound;
  - a checkout still starting gets 409, and one abandoned while starting is marked failed and
    replaced, while a started checkout minutes old is still handed out;
  - a checkout swept while the gateway was answering never has its URL handed out (500);
  - a gateway failure marks the checkout `failed`, and the next click starts afresh;
  - an address or a link past its limit gets 429 before anything is written. The test seeds the
    limiter's shared counter.

`tests/unit/services/billing/paystackClient.test.ts` adds two cases. With `timeoutMs`,
`initializeTransaction` aborts a gateway that never answers. Without it, no signal is sent.

Evidence:

- `red.int.log`: 11 of 13 original cases fail on origin/master `66e776d81` with 717 applied.
- `red.r1.int.log`: the round-1 cases against the round-0 source `cabe94705`, run before the
  round-2 cases existed. 3 of 20 and 4 of 8
  fail. The others pin boundaries the round-0 code happened to meet, such as always starting a
  new checkout; the mutants below prove them.
- `green.log`:
  - both suites;
  - k-036, every k095 and k096 Paystack suite, and k-033;
  - r158, r166, k101, r155-157, r157 and the r159 suites;
  - the k122 suites and the three r095 portal suites;
  - customer-ownership-fence-routes, on an `isaflow_test` copy of the fixture.
- `mutations.log`: every mutant is RED. That is 47 in round 2; in round 3, Q50–Q52 are added, Q39 is re-pointed and Q40 is removed with the dead code, 49 in all; the re-confirmation round adds Q53, the /review round adds Q54, the fresh-review round adds Q55–Q60, round 6 adds Q61 and Q62, and round 7 adds Q63 and Q64, 61 in all. Each run used both suites plus the
  `paystackClient` unit test. They cover:
  - every filter and each arm of the charge, both link kinds, and the clamp;
  - every refusal and its HTTP mapping, including the 409;
  - the spend's four conditions, and the reuse's amount, status and window;
  - the link lock, the starting state and its expiry;
  - the three checkout phases, the gateway timeout and its client plumbing;
  - both rate limits;
  - the stored link and amounts, both GET branches, and all three writers' `charges_balance`.

  Two earlier runs were discarded. In the first, the fixed test IP hit verify's per-IP limit. In
  the second, the unknown-token case's fixed token hit the new per-link limit. Both made failures
  unrelated to the mutant. Each is fixed with a fresh value per run, and a baseline run after the
  final mutation run is green.

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
fourth was fixed in `8e3e1ac2c`, just after round 1. Three settlement tests never asserted that the webhook delivery
succeeded, so a failing delivery would have left the link untouched and passed. They now assert a
200 and the banked receipt.

## Review round 2 (adversarial)

The adversarial reviewer returned FIX: 1 HIGH, introduced in round 1, and LOWs.

- **HIGH, a connection and the link lock held across the gateway call.** Round 1 ran the Paystack
  call inside the link-locked transaction, and that call had no timeout. A burst of clicks on
  one link, or a slow gateway, could hold every pooled connection that other tenants share. The
  three-phase create above holds nothing across the call, bounds it at 10 seconds, and
  rate-limits it.
- **LOW, no test proved the lock.** Now one does, and Q38 (lock removed) is RED.
- **LOW, links minted during the deploy window.** A link the old code mints between migration and
  rsync would have defaulted to explicit.
- **LOW, older standing links not backfilled.** An older standing link the invoice no longer
  names would have missed the backfill.

The last two LOWs are both fixed by `DEFAULT true` in place of the backfill.

## Review round 3

Both reviewers returned SHIP on `7ec334794`. The adversarial reviewer added three LOWs:

- the older part-payment links; decided above;
- rows abandoned while starting that stayed `pending` forever; now marked `failed`, and Q50–Q52
  cover it;
- the per-link limit as a denial for a token holder; accepted above.

Re-confirmation on `5c6a9dc98`: both SHIP. The adversarial reviewer added an optional LOW: a
checkout swept during a stall still had its URL handed out. Now the URL write reports whether it
stored anything, and create answers 500 when it did not (Q53). The general reviewer noted that
the old-links rule named no decider, so it went to Hein, who confirmed it on 2026-10-01.

## /review (fresh blind Opus agent, on #599)

APPROVED with six LOWs. Posted to the PR; all are fixed:

- **"Spent" overstated:** "one payment spends it" said more than the code enforces. The first
  completed payment stops any new checkout, but one already opened stays payable, and any excess
  is banked unapplied (see Not changed). `.claude.md` and the migration comment now say so.
- **The payer lookup had no company predicate:** it joined the `clients` view, which has no
  `company_id`. It now joins `customers` with `c.company_id = ci.company_id`. The case it guards
  is an invoice whose `client_id` names another company's customer. `client_id` has no foreign
  key, so a bad import can leave one. A test now covers it: such an invoice is paid as
  "Customer" with the synthetic payer email, and Q54 (predicate removed) is RED. The earlier
  claim here that it could not be tested was wrong; the general reviewer corrected it.
- **Stale test count:** the suite count was 14; it is 16, with both round-3 cases listed.
- **"Before any DB work" was wrong:** the limiter writes its own counter. Reworded.
- **The green log** now re-runs every regression suite on the final code.
- **The register** has the PR and the fix commits.

## Fresh reviewers after a host reboot (round 5)

The host rebooted during the last push, and the reviewer agents were lost with it. Two new
blind reviewers read the whole range at `6b244289f`. Both returned SHIP with LOWs.

**Fixed:**

- **The starting check filtered on amount.** If the balance moved while a checkout was at the
  gateway, a second could start beside it. Any URL-less pending checkout on the link now answers
  409 (Q55). A truly concurrent case runs two clicks at once: one 200, one 409, one charge (Q38).
- **The spend trusted the request's link id.** It now also requires the link to belong to the
  request's invoice (Q56).
- **`verify` could overwrite a request the webhook had completed** with a stale `abandoned` or
  `failed`, and then reported that stale result. It now moves only a request that is not
  completed. A real success still completes one swept to `failed`. When it moves nothing, it
  reports the stored status (Q57, Q58, Q60).
- **The GET refused a link with no expiry while create charged it.** `getPaymentLink` now treats
  a NULL expiry as not expired, as create does (Q59).
- **A payment on a checkout already swept to `failed`** is banked and spends the link. This was a
  test gap; the behaviour was already right.
- **Migration 717 now sets `lock_timeout = '5s'`**, as migration 660 does. If it queues behind a
  long transaction it fails instead of blocking webhooks.

**Recorded, not changed:**

- An explicit link clicked again after 30 minutes can open a second payable checkout (accepted
  above).
- `pay-now` still calls the gateway inside its `withAuth` transaction, with a float balance and
  no reuse (follow-up).
- `verify` maps `abandoned` to a terminal `cancelled`, which stops that checkout being reused
  (follow-up).
- Standing links still expire after 30 days (follow-up).
- The register's `fixCommit` and status are set after merge, in the register PR.

## Re-confirmation of round 5 (round 6)

Both reviewers returned SHIP at `9b03ccc85`. The LOWs:

**Fixed:**

- **`verify` completed a pending request of any purpose** but settles only invoices. The
  webhook skips a request it finds completed, so a Flow bundle or subscription charge verified
  first was never settled. This predates R-167. `verify` now asks about and moves only a
  customer-invoice request; any other is reported as stored and left to the webhook (Q62).
- **`verify` asked Paystack only about a pending request.** One already `failed` (swept while
  starting) that Paystack reports paid is now completed and banked here too. A `failed` request
  Paystack does not report paid stays `failed` (Q61).
- **Test gap:** the phase-3 URL write throwing. The answer is 500, nothing is handed out, the
  next click gets 409, and the checkout is swept a minute later.

**No change:**

- **Migration 717's text changed during this branch.** A database that applied an earlier
  version fails its next migrate on the checksum. Two local fixture containers have it:
  `isaflow-fixture-r159` (this work's, removed at cleanup) and `isaflow-fixture-w204` (a peer's
  clone). Production and dev never applied it.
- The verify-race tests stand in for the webhook with a direct UPDATE. The webhook's own
  delivery is covered by the settlement cases.

## Re-confirmation of round 6 (round 7)

Both reviewers returned SHIP at `78df79bcf`; the general reviewer had no findings. One LOW from
the adversarial reviewer, fixed: `verify` now asks Paystack about failed requests too, and that
call had no timeout. `verifyTransaction` takes an optional `timeoutMs` and `verify` passes 10
seconds, as create does. A timeout is logged and the stored status is reported. The two other
callers of `verifyTransaction` are unchanged (Q63, Q64).

## Deployed

- #599 was merged as `e00c8f237` and deployed at 06:45 SAST on 2026-10-01, before business
  hours, on Hein's explicit "merge and deploy". The deploy also shipped peer PRs #583–#592,
  #594, #597 and #598; `git cherry` showed 0 `+` against the previous release.
- The deploy applied 1 migration (717). Golden paths passed 13/13 and integrity was green.
- `RELEASE_SHA` is `e00c8f237`.
- "abandoned while starting" and `charges_balance` are in the live
  `pages/api/portal/payments/paystack/create.js`; "This invoice has no outstanding balance" is in
  the live `pages/api/portal/payment-link.js`.
- Live checks: health answers 200; a create with no token answers 400; a payment-link GET with an
  unknown token answers 404.
- The rollback target is `ca5f32867`, code only: migration 717 is additive and stays.

## Migration / rollback

- **Migration 717 is additive** and uses `IF NOT EXISTS`. It adds two columns with fast
  defaults, so no table is rewritten. `deploy.sh` applies it before the rsync.
- **To roll back,** revert the PR. The columns can stay, because nothing else reads them.
