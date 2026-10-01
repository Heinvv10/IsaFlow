# R-177 to R-180 — follow-ups of R-167 on portal payments

Four items, one PR. All were recorded as follow-ups by the R-167 reviewers. Hein decided on
2026-10-01: fix them; a standing link never expires; a draft invoice gets no payment link.
Review round 1 changed two of the designs below; the section after the fix says how.

## Defects

- **R-177. `pay-now` called Paystack inside its request transaction.**
  - `withAuth` holds one connection and one transaction for the whole request, so the gateway
    call ran with both held and with no timeout.
  - It read the balance in float, so a NaN `amount_paid` reached the INSERT and answered 500.
  - Every click opened a new payable checkout; two clicks could both be paid.
  - It reused whatever `payment_url` named, even a cancelled link.
- **R-178. `verify` made an abandoned checkout terminal.** Paystack reports `abandoned` while a
  checkout is open and unpaid. `verify` wrote `cancelled`, so the next click could not reuse the
  checkout and opened a second payable one.
- **R-179. A standing link expired after 30 days.** `portal_payment_links.expires_at` defaults to
  30 days. The standing link is the one emailed with the invoice, so a customer paying late met
  "Payment link expired" on an invoice that still owed money.
- **R-180. A draft invoice could get a payment link, and a link on a draft could be paid.** A
  draft is not yet a claim on the customer and is not in the ledger.

## Fix

- **`src/modules/accounting/services/ar/standingPaymentLink.ts` (new).**
  - `ensureStandingLink(companyId, invoiceId, appUrl)` locks the invoice row, then returns the
    active standing link the invoice's `payment_url` names, or mints one. The minted link has no
    expiry.
  - The lock goes through `withCustomerInvoiceLock`: it needs the request transaction and waits
    at most 5 seconds. It is a NO KEY lock, so it does not hold up a checkout or a receipt being
    recorded against the same invoice.
  - The balance is read in numeric. A NaN balance or a paid invoice owes nothing.
  - It refuses an unapproved invoice, an invoice with no customer, and another company's.
  - The lookup is a statement of its own after the lock. As a subquery of the locking statement
    it read the old snapshot, and two simultaneous calls minted two links (found by the test).
  - It never adopts a link the invoice does not name, nor an explicit-amount link.
  - It sets `online_payment_enabled` when it finds the link with the flag off.
- **`pay-now`** calls `ensureStandingLink` and answers `{ token, paymentUrl }`. It no longer calls
  Paystack. A lock timeout is a 400 with code `CUSTOMER_INVOICE_LOCK_TIMEOUT`.
- **`src/modules/accounting/utils/payNowCheckout.ts` (new)** is what the Pay Now button calls.
  It posts to `pay-now`, then starts the checkout from the token through the public
  `paystack/create` route. That route already gives one checkout per click, a 10-second gateway
  bound and the live balance (R-167).
- **`enableOnlinePayment`** uses `ensureStandingLink`. It used to mint a new link on every call.
  For an unapproved invoice it throws `InvoiceNotApprovedError`, and the enable route answers 400
  with the reason. Its other refusals are still 404, as before.
- **`verify`**: on `abandoned` it writes nothing and reports `cancelled` to the return page. It
  re-reads the stored status first, so a request the webhook settled meanwhile is reported as
  stored.
- **`resolveLinkCharge`** is the one judge of whether a link may be shown or paid:
  - R-179: a link expires at `expires_at`, except the standing link its invoice's `payment_url`
    names. The exemption is decided at read time, so no stored expiry is rewritten.
  - R-180: a link on an invoice that is a draft or awaiting approval is refused
    (`invoice_unapproved`). The public create route answers 400 "This invoice has not been
    issued yet"; the pay page GET answers 404.
- **`getPaymentLink`** no longer filters on status or expiry. The GET asks `resolveLinkCharge`.
  It returns `expiresAt: null` for a link with no expiry, not the string "null".
- **`payment-link` POST** refuses an unapproved invoice with 400.
- **The Pay Now button** is hidden for `pending_approval` as well as `draft`.

There is no migration.

## Argument against

- The Pay Now response changed from `{ checkoutUrl, reference, paymentUrl }` to
  `{ token, paymentUrl }`. The invoice page is its only caller (checked by grep).
- The staff click now goes through the public route's rate limits: 60 starts per address and 20
  per link in 15 minutes.
- The Paystack payer email falls back to a synthetic per-token address when the customer has no
  email. It used to fall back to the staff user's own email.
- A link a customer already holds on an unapproved invoice stops working until it is approved.
- `enableOnlinePayment` now throws outside a request transaction. Both callers are `withAuth`
  routes.

## Review round 1

Both blind reviewers returned SHIP on `44aee3c94`. Their findings, and what changed:

- **Migration 719 could update nothing and still be recorded** (both reviewers).
  `portal_payment_links` forces row security with a policy for `app_user` only. It also left a
  deploy window. **Dropped.** The expiry exemption now lives in `resolveLinkCharge`. Nothing on
  prod is rewritten, and a link the old code mints mid-deploy is covered too.
- **`pending_approval` stayed payable.** It is refused now, by the shared population rule
  (`documentInPopulation`, R-082), which already excludes draft, pending approval and cancelled.
- **The invoice lock had no bound and was stronger than needed.** It now goes through
  `withCustomerInvoiceLock` (5 seconds, typed retryable error) and is `FOR NO KEY UPDATE`.
- **`ensureStandingLink` did not enforce its transaction.** The lock wrapper refuses without one.
- **`online_payment_enabled` was not restored on a found link.** It is now.
- **The mutation log mixed two heads.** All 21 mutants were re-run on the final code.

Recorded, not changed:

- **An abandoned checkout is reused only inside the 30-minute window** (R-167's reuse rule). After
  that the next click opens a second checkout while the first may still be payable at Paystack.
  The excess of a double payment is banked unapplied.
- **A checkout already open on an unapproved invoice before the deploy can still be paid.**
  Settlement banks what Paystack received; it has no status rule. Filed with R-181.
- **Not fixed here (R-181, candidate):** settlement banks the request's `amount_cents` and never
  compares it with the amount Paystack reports.

## Review round 2

Both blind reviewers returned SHIP on `00ea768b5`, with LOWs. Fixed:

- **The enable route answered 404 "Open invoice with a balance due" for an unapproved invoice.**
  It now answers 400 with the reason.
- **The enable route's lock-timeout mapping had no test.** It has one now, and a mutant.
- **Nothing tested that the Pay Now button is hidden for `pending_approval`.** A unit test on
  `useCustomerInvoiceActions` covers the statuses.
- **Nothing tested `enableOnlinePayment` outside a request transaction.** It throws; tested.
- **A stale comment** in the R-167 suite named a file this branch deleted.
- **`red.int.log` was the red run of the first suite only.** `red.r1.int.log` is the final suites
  on unchanged `origin/master` source: 19 of 23 fail.

Recorded, not changed:

- **A standing link has no revoke action.** Nothing in the app sets a link to `cancelled`. A link
  forwarded to the wrong person used to die after 30 days. It now shows the invoice number,
  company, customer and balance for as long as the invoice owes, and can only be stopped in SQL.
  This follows from "never expires". A revoke button is a feature for Hein to decide.
- **Links that come back to life on deploy.** Every expired standing link an invoice names
  becomes payable again. Census below.
- A stored `failed` request that Paystack calls `abandoned` stays `failed`. R-167's suite pins it.

## Tests

Real Postgres, the real routes and wrappers; only the Paystack client is stubbed. 23 cases in two
files, with shared callers in `tests/integration/r177-portal-followups.helpers.ts`.

`tests/integration/r177-pay-now-standing-link.int.test.ts`, 9 cases (R-177):

- no gateway call and no request row in `pay-now`;
- the token starts one checkout for the live balance, and a second click reuses it;
- two simultaneous calls keep one link, and the flag is restored on a legacy row;
- the lock does not wait behind a row that references the invoice (NO KEY);
- a cancelled named link is replaced; an unnamed link or a named explicit link is never adopted;
- NaN and paid invoices get 400 and no link; a negative `amount_paid` charges the total;
- an invoice held by another request answers a retryable 400 after 5 seconds and mints nothing;
- another company's invoice is 404 through the route and null through the service, which runs
  there with no row security.

`tests/integration/r178-r180-portal-link-rules.int.test.ts`, 14 cases:

- R-178: `abandoned` reports cancelled, the request stays pending, the next click gets the same
  checkout, one charge. `failed` is still written.
- R-179: both mint points mint with no expiry; an explicit link keeps 30 days;
  `enableOnlinePayment` returns the existing link; the named standing link is shown and payable
  past its stored expiry; an unnamed link and a named explicit link still expire; a cancelled or
  paid link is not shown.
- R-180, for `draft` and for `pending_approval`: no link from any of the three mint points; a
  link already there is neither shown nor payable, and works once the invoice is approved.
- The enable route: returns the standing link and still answers 404 for a paid invoice; a held
  invoice gives a retryable 400 after 5 seconds; the bare service refuses to run with no request
  transaction.

`tests/unit/accounting/utils/payNowCheckout.test.ts`, 5 cases: the two calls in order, and each
refusal thrown with the server's message.

`tests/unit/accounting/hooks/useCustomerInvoiceActionsPayNow.test.ts`, 9 cases: the button is
offered for approved, sent, overdue and partially paid invoices with a balance, and for nothing else.

`red.int.log`: 11 of 14 failed on unchanged `origin/master` (the first version of the suite).
`red.r1.int.log`: the final suites on unchanged `origin/master` source, 19 of 23 failed.
`mutations.log`: 25 mutants on the final code, all RED.

**Browser proof (2026-10-01):** a dev server from this branch against the disposable fixture, a
Playwright Chromium session signed in as a seeded user, and the public create route answered by
the test so Paystack was not called. Clicking Pay Now on an approved R115 invoice sent
`POST …/pay-now` (200, `{ token, paymentUrl }`), then `POST /api/portal/payments/paystack/create`
with that token, and `window.open` was called with the checkout URL. One standing link was
minted, with no expiry. Not exercised in a browser: the real Paystack page, and a popup blocker.

## Migration / rollback

There is no migration. To roll back, revert the PR. Standing links minted meanwhile have no
expiry; the old code treats that as not expired.

Census (read-only, for Hein), standing links that become payable again:
`SELECT count(*) FROM portal_payment_links l JOIN customer_invoices ci ON ci.id = l.invoice_id
 WHERE l.status = 'active' AND l.charges_balance AND l.expires_at < now()
   AND ci.payment_url LIKE '%/portal/pay/' || l.token
   AND ci.status NOT IN ('draft', 'pending_approval', 'cancelled') AND ci.deleted_at IS NULL
   AND ci.total_amount - GREATEST(ci.amount_paid, 0) > 0;`

Census (read-only, for Hein), links that stop being payable until their invoice is approved:
`SELECT count(*) FROM portal_payment_links l JOIN customer_invoices ci ON ci.id = l.invoice_id
 WHERE l.status = 'active' AND ci.status IN ('draft', 'pending_approval');`
