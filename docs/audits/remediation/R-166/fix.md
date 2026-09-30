# R-166 — a payment link may not ask for more than the invoice still owes

## Defect

`POST /api/portal/payment-link` checked the amount's format and capped it at the column maximum
(R-158), but never against the invoice. An owner, admin or manager could therefore create a
payable link for more than `total_amount - amount_paid`, and for any amount on an invoice that
was already paid. The R-155 prod census found one such link: the live link on INV-00553 (ISAFlow
Demo), which is paid in full.

Hein decided on 2026-09-30 that a link is capped at the outstanding balance, and that a part
payment is allowed.

## Fix

The invoice lookup in `pages/api/portal/payment-link.ts` also returns:

- the balance, `total_amount - COALESCE(amount_paid, 0)`;
- whether the requested amount is over it.

The comparison is done in Postgres `numeric`, not in a JS float, so an amount one cent over the
balance is refused.

- After the customer check, an amount over the balance gets 400: "amount is more than the
  invoice's outstanding balance of <balance>".
- The refusal happens before `assertCustomerInCompany` and before the link INSERT, so nothing is
  written. `withAuth` COMMITs a 4xx, so the order matters.
- The branch fails closed: anything other than `over_balance = false` is refused.
- Any amount up to the balance is allowed. A paid invoice (balance 0) or an overpaid one
  (negative balance) gets no link.
- A NULL `amount_paid` counts as 0. The column's generated `balance` is NULL in that case,
  which is why it is not used.
- Links that already exist are not changed. The check does not add up other live links on the
  same invoice; each link is capped on its own, as decided.

## Tests

`tests/integration/r166-payment-link-amount-cap.int.test.ts`, 4 cases, runs through the real
route: `withAuth` as `app_user` with RLS, `withCsrf` and `withWriteAccess`.

- **Unpaid R115.00:**
  - 115.01, '115.01' and 116 are refused with the balance in the message, and no row is written;
  - 115, '115.00' and a part payment of 40.50 are written.
- **Part-paid (R100 of R115):**
  - 15.01 and 115 are refused, and the message says 15.00;
  - 15 and 0.01 are written.
- **Paid (115) or overpaid (120):** even 0.01 is refused and nothing is written.
- **`amount_paid` NULL:** 115.01 is refused, with the message saying 115.00, and 115 is written.

`k101-portal-routes-use-active-company` accepted a 9 999 999 999 999.99 link on a R115 invoice.
Under R-166 that is a refusal, so the case now raises that invoice's total to the column maximum
first. The bound it tests (R-158) is unchanged.

Evidence:

- `red.int.log`: 4 of 4 cases fail on origin/master `7c49109f5`. Each over-balance amount is
  written with 200;
- `green.log`: the new suite, plus k101, r155-157, r157-throw, r158, k122, k122b, the three r095
  suites, and customer-ownership-fence-routes. The fence suite refuses any database not named
  `isaflow_dev` or `isaflow_test`, so it ran on an `isaflow_test` copy of the same fixture clone;
- `mutations.log`: 7 of 7 mutants are RED:
  - COALESCE dropped from the cap, and from the balance text;
  - `>` changed to `>=`;
  - `amount_paid` ignored;
  - the refusal removed;
  - the balance removed from the message;
  - the refusal moved after the INSERT.

## Prod follow-up (not done; needs Hein)

The live link on paid invoice INV-00553 (ISAFlow Demo) is still payable. Expiring it would be a
prod write, so it waits for Hein's yes.

## Migration / rollback

There is no migration. To roll back, revert the PR.
