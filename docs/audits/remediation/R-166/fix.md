# R-166 — a payment link may not ask for more than the invoice still owes

## Defect

`POST /api/portal/payment-link` checked the amount's format and capped it at the column maximum
(R-158), but never against the invoice. An owner, admin or manager could create a link for more
than `total_amount - amount_paid`, or on an invoice that was already paid. The link's amount is
what the pay page shows the customer as "Amount Due". The R-155 prod census found one such link:
the live link on INV-00553 (ISAFlow Demo), which is paid in full.

Hein decided on 2026-09-30 to cap a link at the outstanding balance and to allow part payments.

What the customer is actually charged is a separate defect, registered as R-167 and not fixed
here. `pages/api/portal/payments/paystack/create.ts` never reads `portal_payment_links.amount`.
It charges `total_amount - amount_paid` at pay time, with no clamp, and nothing marks a link
paid. A part-payment link therefore shows its own amount and charges the whole balance. The
charge can also exceed what the invoice is owed:

- on a legacy row with a negative `amount_paid` (-50 on a R115 invoice charges R165);
- a NaN `amount_paid` sends a NaN amount to the gateway, because `NaN <= 0` is false, so the
  "Invoice already paid" guard is skipped;
- its invoice lookup has no company, status or `deleted_at` filter, so an existing link on a
  since-cancelled or soft-deleted invoice can still be charged.

R-166 caps what a new link may ask for; it does not change what paying a link charges.

## Fix

The invoice lookup in `pages/api/portal/payment-link.ts` computes the balance once, in a
`LATERAL` subquery: `total_amount - GREATEST(amount_paid, 0)`. It also returns whether the
requested amount is over that balance.

- The comparison is in Postgres `numeric`, not a JS float. In float, 0.30 - 0.10 is
  0.19999999999999998, which would refuse an amount of exactly 0.20.
- `GREATEST` ignores NULL, so a NULL `amount_paid` counts as 0. A negative `amount_paid`,
  which exists on legacy rows, also counts as 0, so it cannot raise the cap above the total.
  This is stricter than the literal `total_amount - COALESCE(amount_paid, 0)`, and it only ever
  lowers the cap.
- A NaN balance is refused. Numeric NaN sorts above every number, so `amount > NaN` is false and
  would otherwise allow any amount. Migration 692 guards `total_amount` on write only, and
  nothing guards `amount_paid`.
- The lookup now also requires `deleted_at IS NULL`, as `pay-now` and `payment-gateway` already
  do. A soft-deleted invoice gets 404. This was true before R-166 too; it was found on the same
  query in review.
- After the customer check, an amount over the balance gets 400 with the message "amount is
  more than the invoice's outstanding balance of <balance>". The refusal comes before
  `assertCustomerInCompany` and before the INSERT, so nothing is written. The order matters
  because `withAuth` COMMITs a 4xx. The balance appears only once the client has matched this
  company's invoice.
- Any amount up to the balance is allowed. A paid invoice (balance 0) or an overpaid one
  (negative balance) gets no link.
- Links that already exist are not changed. Each link is capped on its own, and live links on
  one invoice are not added up; that was the decision.

## Tests

`tests/integration/r166-payment-link-amount-cap.int.test.ts` has 7 cases. They run through the
real route: `withAuth` as `app_user` with RLS, then `withCsrf` and `withWriteAccess`.

- **Unpaid R115.00:** 115.01, '115.01' and 116 are refused with the balance in the message, and
  nothing is written. 115, '115.00' and a part payment of 40.50 are written.
- **Part-paid (100 of 115):** 15.01 and 115 are refused, and the message says 15.00. 15 and 0.01
  are written.
- **Paid (115) or overpaid (120):** 0.01 is refused and nothing is written.
- **`amount_paid` of -50:** 115.01 and 165 are refused, the message says 115.00, and 115 is
  written.
- **`amount_paid` NaN:** 0.01 is refused.
- **Soft-deleted:** 404, and nothing is written.
- **`amount_paid` NULL:** 115.01 is refused, the message says 115.00, and 115 is written.

`k101-portal-routes-use-active-company` changed in two places:

- It accepted a 9 999 999 999 999.99 link on a R115 invoice, which R-166 now refuses. The case
  first raises that invoice's total to the column maximum.
- Its refusal loop sends 1e15 and '0.00'. Both pass the text check, and the balance cap would
  now refuse 1e15 on its own. The loop therefore asserts R-158's own "between 0.01 and" message
  for those two values. Without that, deleting the maximum check stayed green (review round 1).

Evidence:

- `red.int.log`: the original 4 cases fail on origin/master `7c49109f5`, where every over-balance
  amount is written with 200.
- `red.r1.int.log`: the 3 round-1 cases (negative, NaN, soft-deleted) fail on the round-0 route
  `be59cda61`.
- `green.log`: the new suite, k101, r155-157, r157-throw, r158, k122, k122b, the three r095
  suites, and customer-ownership-fence-routes. The fence suite refuses any database not named
  `isaflow_dev` or `isaflow_test`, so it runs on an `isaflow_test` copy of the same fixture clone.
- `mutations.log`: 10 of 11 mutants are RED, and N11 is equivalent. The round-1 mutants cover
  the clamp and NULL handling, `>` changed to `>=`, `amount_paid` ignored, the NaN arm, the
  message, the refusal removed or moved after the INSERT, the negative clamp, `deleted_at`, and
  R-158's maximum. N11 swaps `!== false` for `=== true`. That changes nothing, because
  `over_balance` cannot be NULL.

## Review round 1

Both reviewers returned FIX. Every finding is fixed above, apart from the MEDIUM:

- **MEDIUM (adversarial):** the link amount never controls the charge. This is registered as
  R-167. Fixing it changes what a customer is charged, so it is Hein's decision.
- **LOW:** the R-158 maximum was no longer pinned. It now is, by its own message.
- **LOW:** a NaN balance slipped past the cap. It is now refused.
- **LOW:** the reason given for comparing in numeric was wrong. It is corrected.
- **LOW:** a negative `amount_paid` raised the cap above the total. It is now clamped to 0.
- **LOW:** soft-deleted invoices got a link. They now get 404.
- **LOW:** the INV-00553 link was called "still payable". It is not: `paystack/create` refuses a
  paid invoice. The wording is corrected below.
- The earlier fix.md mentioned a generated `balance` column. No migration here defines it, so
  the mention was dropped.

## Prod follow-up (not done; needs Hein)

The link on INV-00553 (ISAFlow Demo) is still `active` and still displays. A payment attempt is
refused ("Invoice already paid"), so expiring the link is a tidy-up, not urgent. It is a prod
write, so it waits for Hein's yes.

## Migration / rollback

There is no migration. To roll back, revert the PR.
