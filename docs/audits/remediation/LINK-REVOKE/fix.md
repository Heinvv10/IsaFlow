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
| company_id dropped from the lock select | killed (service called without row security) |
| `FOR NO KEY UPDATE` dropped | killed (5s lock-timeout test) |
| hook guard forced true / forced false | killed |
| company_id dropped from the named-link select, or from the final invoice UPDATE | **survive, equivalent**: the lock select has already refused another company's invoice, and both statements are keyed on that same invoice id |

## Not verified

Browser proof of the button and dialog (run by the lead).
