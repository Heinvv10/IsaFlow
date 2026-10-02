# LINK-REVOKE: a way to cancel an invoice's standing "Pay now" link

**Branch** `fix/standing-link-revoke-20261002` from `origin/master` @ `82bd2afdc`
**Severity** low (control gap, no defect) · **Migration** none

## Trigger

Since R-177..R-180 the standing link `customer_invoices.payment_url` names never expires. A link
forwarded to the wrong person shows the invoice and can be paid for as long as the invoice owes;
the only way to stop it was SQL.

## Change

- `revokeStandingLink(companyId, invoiceId)` in `standingPaymentLink.ts`: takes the same invoice
  lock as `ensureStandingLink` (`withCustomerInvoiceLock`, NO KEY, 5s), finds the active
  `charges_balance` link whose token `payment_url` names (the identification `ensureStandingLink`
  uses), sets it `cancelled`, and clears `payment_url` / `online_payment_enabled`.
- `POST /api/accounting/customer-invoices/[id]/payment-link/revoke`
  (`withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))`): 400 bad id, 404
  `Invoice not found`, 404 `No active payment link` (idempotent: a second call is this 404), 400 on
  lock timeout. Every refusal precedes the first write.
- Invoice page: overflow action "Revoke payment link" (only while `payment_url` is set) opens
  `RevokePaymentLinkDialog`; success reloads the invoice, failure shows the server's message.

## What it does not do

- It does not touch explicit-amount links.
- It does not touch a checkout already open at Paystack: a payment already started still settles,
  as today (the webhook/verify path credits it against the invoice either way).
- The link row is only `cancelled`; the next Pay Now mints a new token (nothing is reused).

## Evidence (fixture `isaflow_schema_fixture`)

`tests/integration/link-revoke.int.test.ts`: red on unchanged code (11/11 failed, module missing),
green 13/13 after. `tests/unit/accounting/hooks/useCustomerInvoiceActionsRevoke.test.ts`: red 2/4
(the two "not offered" cases pass vacuously on unchanged code), green 4/4.

Mutants (each restored after the run):

| Mutant | Result |
|---|---|
| `charges_balance` dropped from the named-link select | killed (explicit link named by the invoice) |
| payment_url name predicate dropped | killed (unnamed standing link cancelled) |
| `status = 'active'` dropped | killed (paid named link) |
| payment_url / flag not cleared (both, flag only) | killed |
| link not cancelled | killed (3 tests) |
| `withCsrf` removed | killed |
| `withWriteAccess` removed | killed (viewer) |
| `isUuidParam` removed | killed |
| company_id dropped from the lock select (first version) | killed (service called without row security) |
| `FOR NO KEY UPDATE` dropped | killed (5s lock-timeout test) |
| hook guard forced true / forced false | killed |
| company_id dropped from the named-link select, or from the final invoice UPDATE | **survive, equivalent**: the lock select has already refused another company's invoice, and both statements are keyed on that same invoice id |

## Not verified

Browser proof of the button and dialog (run by the lead).

## Review round 1 (head `85d47fced`: two MEDIUM, no HIGH)

1. **Older standing links stayed payable.** Pre-R-177 Pay Now minted one `charges_balance` link per
   click (30-day expiry); revoke cancelled only the one `payment_url` names. Now one statement
   cancels every active `charges_balance` link on the invoice (`invoice_id` and company scoped,
   under the same lock) and the response says how many (`{ revoked: true, cancelled: n }`).
   Explicit-amount links and an open Paystack checkout are still untouched.
2. **Stuck button.** A `payment_url` naming a paid, cancelled, fixed-amount or missing link used to
   answer 404 forever. Revoke is now "make sure no standing link is live and clear
   payment_url / online_payment_enabled": 200 with the count (0 allowed) whenever the invoice has a
   `payment_url` or any active standing link; 404 only when there is nothing to do.
3. The cancel is one `UPDATE ... RETURNING` with `AND invoice_id = <invoice>`; the invoice is
   cleared after it, in the same transaction, so `payment_url` is never cleared without the cancel.
4. Tests: refusal asserted as the specific 400 (not `!== 200`); hook docstring corrected; the dialog
   reloads the invoice after a failed attempt too (a stale item disappears), then shows the message.
5. Dialog copy: "Every Pay Now link on INV will stop working for anyone who has it. Fixed-amount links
   created after 06:45 on 1 October 2026 are not affected, and a payment already started at Paystack can still complete. The next
   Pay Now creates a new link."

Integration 19/19 (was 13/13; the old "explicit link named by payment_url is 404" test became the
stuck-button 200 case). Mutants against the committed baseline (each restored): cancel `status`
dropped, cancel `charges_balance` dropped, cancel `invoice_id` dropped, `has_link` always false /
without `charges_balance` / without `status` / without the invoice join, refusal `&&` to `||`,
invoice clear skipped, company dropped from the lock select, `FOR NO KEY UPDATE` dropped: all
killed. Survivor, equivalent: the company `EXISTS` in the cancel statement (the lock select has
already refused another company's invoice).

Browser proof (lead, local dev server against the fixture, no Paystack): on an approved invoice with
a standing link, "More invoice actions" -> "Revoke payment link" -> dialog "Revoke payment link?" ->
"Revoke link" cancelled the link, cleared `payment_url` and `online_payment_enabled`, and removed
"Copy Payment Link". That run was against the first version of the dialog copy; the round-1 copy
above has not been re-proved in the browser.

## Review round 2 (head `8b9b854a2`: both reviewers SHIP)

- Dialog copy corrected: links made through the payment-link POST before migration 717 (2026-10-01)
  carry `charges_balance` true and are cancelled like any standing link, so the copy now says
  "Fixed-amount links created after 06:45 on 1 October 2026 are not affected."
- New test: a pre-717 fixed-amount link is cancelled, a post-717 one is not, and `cancelled` equals
  the number of active standing links counted before the call. Mutant (count capped at 1): killed.

## Review round 3

The code that writes `charges_balance` false reached production in the deploy at 06:45 SAST on
1 October 2026 (e00c8f237 contains 7fb687cfa), so the cutoff in the dialog copy is exact: "Fixed-amount
links created after 06:45 on 1 October 2026 are not affected." Links made through the payment-link
POST before that deploy carry `charges_balance` true and are cancelled.
