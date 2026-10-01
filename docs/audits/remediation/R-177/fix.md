# R-177 to R-180 — follow-ups of R-167 on portal payments

Four items, one PR. All were recorded as follow-ups by the R-167 reviewers. Hein decided on
2026-10-01: fix them; a standing link never expires; a draft invoice gets no payment link.

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
    active, unexpired standing link the invoice's `payment_url` names, or mints one. The minted
    link has no expiry.
  - The balance is read in numeric. A NaN balance or a paid invoice owes nothing.
  - It refuses a draft, an invoice with no customer, and an invoice of another company.
  - The lookup is a statement of its own after the lock. As a subquery of the locking statement
    it read the old snapshot, and two simultaneous calls minted two links (found by the test).
  - It never adopts a link the invoice does not name, nor an explicit-amount link.
- **`pay-now`** calls `ensureStandingLink` and answers `{ token, paymentUrl }`. It no longer calls
  Paystack.
- **`src/modules/accounting/utils/payNowCheckout.ts` (new)** is what the Pay Now button calls.
  It posts to `pay-now`, then starts the checkout from the token through the public
  `paystack/create` route. That route already gives one checkout per click, a 10-second gateway
  bound and the live balance (R-167).
- **`enableOnlinePayment`** uses `ensureStandingLink`. It used to mint a new link on every call.
- **`verify`**: on `abandoned` it writes nothing and reports `cancelled` to the return page. It
  re-reads the stored status first, so a request the webhook settled meanwhile is reported as
  stored.
- **`resolveLinkCharge`** refuses a link on a draft invoice (`invoice_draft`). The public create
  route answers 400 "This invoice has not been issued yet"; the pay page GET answers 404.
- **`payment-link` POST** refuses a draft invoice with 400.
- **Migration 719** clears `expires_at` on the active standing link each invoice names.
- `getPaymentLink` returns `expiresAt: null` for a link with no expiry, not the string "null".

## Argument against

- The Pay Now response changed from `{ checkoutUrl, reference, paymentUrl }` to
  `{ token, paymentUrl }`. The invoice page is its only caller (checked by grep).
- The staff click now goes through the public route's rate limits: 60 starts per address and 20
  per link in 15 minutes.
- The Paystack payer email falls back to a synthetic per-token address when the customer has no
  email. It used to fall back to the staff user's own email.
- A link on a draft that a customer already holds stops working until the invoice is approved.

## Decisions and limits

- **Only `draft` is refused.** `pending_approval` stays payable, as the Pay Now button already
  shows for it. Hein may want that refused too.
- **Migration 719 touches only the link an invoice names.** Every link from before 717 carries
  `charges_balance = true`, including old explicit-amount links. Clearing every flagged link would
  bring those back to life.
- **Deploy window.** `deploy.sh` migrates before it switches code. A standing link the old code
  mints in that window keeps a 30-day expiry. Pay Now replaces it with a fresh one once it expires.
- **Not fixed here (R-181, candidate):** settlement banks the request's `amount_cents` and never
  compares it with the amount Paystack reports.

## Tests

`tests/integration/r177-portal-payment-followups.int.test.ts`, 15 cases on real Postgres with the
real routes and wrappers; only the Paystack client is stubbed.

- R-177: no gateway call and no request row in `pay-now`; the token starts one checkout for the
  live balance and a second click reuses it; two simultaneous calls keep one link; a cancelled or
  expired named link is replaced; an unnamed link or a named explicit link is never adopted; NaN
  and paid invoices get 400 and no link; a negative `amount_paid` charges the total; another
  company's invoice is 404 through the route and null through the service (no RLS on that call).
- R-178: `abandoned` reports cancelled, the request stays pending, the next click gets the same
  checkout, one charge. `failed` is still written.
- R-179: Pay Now and `enableOnlinePayment` mint with no expiry; an explicit link keeps 30 days;
  `enableOnlinePayment` returns the existing link; migration 719 revives the named active
  standing link and leaves an unnamed, a cancelled and a named explicit link expired.
- R-180: no link for a draft from any of the three mint points; a link on a draft is neither
  shown nor payable, and works once the invoice is approved; `pending_approval` is payable.

`tests/unit/accounting/utils/payNowCheckout.test.ts`, 5 cases: the two calls in order, and each
refusal thrown with the server's message.

`red.int.log`: 11 of 14 failed on unchanged `origin/master` (one case was added after).
`mutations.log`: 18 mutants, all RED. One was dropped as equivalent and the code simplified.

## Migration / rollback

- **Migration 719 is data only** and idempotent: it sets `expires_at` to NULL on matching rows.
  It cannot be undone exactly, because the old expiry is not kept.
- **Census before deploy (read-only, for Hein):**
  `SELECT count(*) FROM portal_payment_links l JOIN customer_invoices ci ON ci.id = l.invoice_id
   WHERE l.charges_balance AND l.status = 'active' AND l.expires_at IS NOT NULL
     AND ci.payment_url LIKE '%/portal/pay/' || l.token;`
  The migration must run as a role that bypasses row security on `portal_payment_links` (the
  table forces it); otherwise it updates nothing and says nothing.
- **To roll back,** revert the PR. Links already cleared stay without an expiry.
