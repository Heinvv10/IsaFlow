# LINK-REVOKE: a way to cancel an invoice's standing "Pay now" link

**Branch** `fix/standing-link-revoke-20261002` from `origin/master` @ `82bd2afdc`
**Severity** low (control gap, no defect) · **Migration** none

## Trigger

Since R-177..R-180 the standing link `customer_invoices.payment_url` names never expires. A link
forwarded to the wrong person shows the invoice and can be paid for as long as the invoice owes;
the only way to stop it was SQL.

## Change

- `revokeStandingLink(companyId, invoiceId)` in `standingPaymentLink.ts`: takes the same invoice
  lock as `ensureStandingLink` (`withCustomerInvoiceLock`, NO KEY, 5s) with a plain locking
  SELECT, then checks for a live link in a statement of its own (a subquery of the locking
  statement would read the pre-lock snapshot). It cancels EVERY active `charges_balance` link on
  the invoice in one `UPDATE ... RETURNING` scoped to the invoice, then clears `payment_url` /
  `online_payment_enabled` in the same transaction.
- `POST /api/accounting/customer-invoices/[id]/payment-link/revoke`
  (`withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))`): 200 `{ revoked, cancelled }`
  (0 when only a dead `payment_url` was cleared), 400 bad id, 404 `Invoice not found`, 404
  `No active payment link` (no active standing link and no `payment_url`; a second call is this
  404), 400 on lock timeout. Every refusal precedes the first write. A success is logged
  (`Standing payment link revoked`: company, invoice, user, count).
- Invoice page: overflow action "Revoke payment link" (while `payment_url` is set) opens
  `RevokePaymentLinkDialog`; the invoice is reloaded after any attempt, a failure shows the
  server's message.

## What it does not do

- It does not touch fixed-amount links created after the deploy that wrote `charges_balance` false.
- It does not touch a checkout already open at Paystack: a payment already started still settles,
  as today (the webhook/verify path credits it against the invoice either way).
- The link rows are only `cancelled`; the next Pay Now mints a new token (nothing is reused).

## Evidence (fixture `isaflow_schema_fixture`)

Final counts at the head: integration `link-revoke.int.test.ts` 22/22 (first run on unchanged code:
11/11 red); hook unit tests 6/6; dialog component test 4/4. Mutant tables are per round below
(each restored after its run). Not verified by a test: a concurrent Pay Now racing a revoke
(lock-timeout and lock-dropped mutants cover the lock itself).

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
   created after 07:00 on 1 October 2026 are not affected, and a payment already started at Paystack can still complete. The next
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
"Copy Payment Link". The lead re-ran it on the final dialog copy (Playwright, local dev server against the fixture): the
"Revoke link" button was clicked and the dialog text matched.

## Review round 2 (head `8b9b854a2`: both reviewers SHIP)

- Dialog copy corrected: links made through the payment-link POST before migration 717 (2026-10-01)
  carry `charges_balance` true and are cancelled like any standing link, so the copy now says
  "Fixed-amount links created after 07:00 on 1 October 2026 are not affected."
- New test: a pre-717 fixed-amount link is cancelled, a post-717 one is not, and `cancelled` equals
  the number of active standing links counted before the call. Mutant (count capped at 1): killed.

## Review round 3

The code that writes `charges_balance` false reached production in the deploy at 06:45 SAST on
1 October 2026 (e00c8f237 contains 7fb687cfa), so the cutoff in the dialog copy is a time after the new build was certainly serving (the deploy's checks finished at 06:45, the copy says 07:00): "Fixed-amount
links created after 07:00 on 1 October 2026 are not affected." Links made through the payment-link
POST before that deploy carry `charges_balance` true and are cancelled.

## PR #616 blind review: 7 LOW, all fixed

- L1 `has_link` read the pre-lock snapshot, so a second concurrent revoke answered 200 instead of
  404: the live-link check is now a statement after the lock. Test holds the invoice lock, starts
  the second revoke, commits the first's effect, expects 404 (red before, green after).
- L2 hook tests pin the gate on `payment_url` alone (flag off + url: offered; flag on + no url: not).
- L3 `revokePaymentLinkDialog.test.tsx`: 200/404/403, callback order done, error(server message),
  close.
- L4 audit log line; L5 the open checkout is settled through the webhook after the revoke and a
  receipt of 115.00 is banked; L7 "07:00 SAST" (no count of spared links: the dialog fetches
  nothing).
- Mutants (all killed): snapshot subquery back in the locking statement; live check without
  `status`, `charges_balance`, or the invoice; log removed / wrong user; hook gated on the flag;
  dialog callbacks reordered, `onClose` dropped, server message replaced; SAST dropped; a
  settlement guard refusing a cancelled link. Survivor, equivalent: revoke voiding the Paystack
  request row (the webhook settles by reference regardless), which is why that is not the L5 mutant.

## PR #616 re-review at 6372a2613: 4 LOW, all fixed

- L1 (real gap): the menu item was gated on `payment_url` only, so an invoice with a pre-deploy
  fixed-amount link (`charges_balance` true, 30-day expiry) and no `payment_url` could not reach
  Revoke although the server would cancel it. The invoice detail read now returns
  `has_standing_link` (EXISTS on an active `charges_balance` link of that invoice; the read is
  company scoped) and the item shows when `payment_url || has_standing_link`. Tests: the read
  returns the flag (none / pre-717 link / post-717 fixed link / paid link / other company), the hook
  offers the item for null `payment_url` + flag. Mutants killed: flag always false, flag without
  `charges_balance`, without `status`, without the invoice join; hook gate dropped, hook gate always.
  The flag also appears in the MCP `get_invoice` output (same read function).
- L2 **Follow-up due 2026-10-31**: after that date change the dialog copy from "Fixed-amount links
  created after 07:00 SAST on 1 October 2026 are not affected" to "Fixed-amount links are not
  affected" (every pre-deploy link will have expired by then). No code change now.
- L3 the live-link SELECT carries the same company `EXISTS` as the cancel UPDATE. Equivalent for
  behaviour (the locking SELECT already refuses another company's invoice), so no test can go red
  on it; it is there so each statement is scoped on its own.
- L4 the integration suite is split: `link-revoke.int.test.ts` (functional, 23 tests incl. the new
  flag test), `link-revoke-locking.int.test.ts` (race + 5s lock timeout, 2 tests) and
  `link-revoke.helpers.ts`. Both pass against the fixture.

## Expired unnamed links (adversarial LOW at 46b378577)

`has_standing_link` ignores a link whose `expires_at` has passed (`COALESCE(l.expires_at > NOW(), true)`),
because nothing ever sets `status = 'expired'` and Revoke would otherwise be offered indefinitely for
dead links. Test: an expired unnamed active link gives false, an unexpired one true; the mutant without
the expiry predicate goes red.

`revokeStandingLink` is deliberately NOT changed: it still counts an expired active `charges_balance`
link as something to do (it cancels it and answers 200). That is harmless and accurate (the row was
`active` and is now `cancelled`), the only caller that can reach it with just an expired link is a
stale page or a direct call, and treating it as "nothing to do" would leave a dead-but-active row
behind. The expiry on the read only decides whether the button is shown.

Mutant for the expired-link pin: `AND COALESCE(expires_at > NOW(), true)` added to both the live-link
check and the cancel UPDATE of `revokeStandingLink` -> killed (the expired-link revoke test goes red;
1 failed, the rest green). Reverted.

## has_standing_link and the named-link exception (adversarial LOW at 6e7a72117)

A pre-R-177 link past its stored expiry that `payment_url` names is still live and payable
(`resolveLinkCharge`), but the plain expiry predicate reported false. The expiry rule is now one
exported fragment, `linkExpiredSql()` in `portalLinkCharge.ts`, used by `resolveLinkCharge` and by
`has_standing_link` (`AND NOT linkExpiredSql()`), so what the page shows as live is what can be paid.
Test: a named link with a past `expires_at` gives true (red before). Mutant: the plain
`COALESCE(l.expires_at >= NOW(), true)` back in the read -> killed. The type comment now says the link
payment_url names never expires.
