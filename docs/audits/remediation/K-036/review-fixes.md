# Review remediation — K-035 / K-036 (blind review of cc6f7bf9)

All 12 findings addressed except L4, which the review itself asked to be mentioned
and not fixed in this branch.

| # | Finding | Fix |
|---|---|---|
| H1 | Non-UUID `customer_invoices.created_by` (varchar) aborts the payment insert with 22P02 on every redelivery | Actor resolved through `resolveUserUuid`, the same helper the GL side uses |
| H2 | An over-settlement was clamped to the invoice balance and the excess dropped with a 200 ack | The whole receipt is banked; only what the invoice owes is allocated, the remainder stays as an unapplied receipt on the customer, and a warning is logged |
| M1 | Two concurrent redeliveries both read `processed = false` and processed in parallel | The `processed` check moved inside the transaction behind `SELECT … FOR UPDATE` on the event row |
| M2 | A failed ROLLBACK returned a poisoned connection to the pool | `client.release(err)` when — and only when — the ROLLBACK itself failed, so the connection is destroyed |
| M3 | The receipt was dated at processing time, so a retry booked it into the wrong period | `paid_at` (webhook) / `paidAt` (verify) carried through to `payment_date` and the journal date |
| M4 | Gross bank debit against a net settlement left the bank unreconcilable and no fee expense | The fee from the payload is posted as its own DR expense / CR Bank entry, so the bank leg nets to the deposit |
| L1 | `processing_error` survived a later success | Cleared in the same statement that sets `processed` |
| L2 | No nesting guard on `withPublicRouteTransaction` | Throws when an ALS request context is already bound |
| L3 | Silent RLS bypass on this path | Documented in the wrapper's header: isolation rests on the explicit `company_id` predicates |
| L4 | `subscription_charges` update lacks `company_id` | **Not fixed** — pre-existing on master, moved verbatim, out of scope per the review |
| L5 | Read-then-write idempotency with no constraint behind it | Migration `619_customer_payments_card_reference_unique.sql`, a partial unique index on `(company_id, bank_reference)` for non-cancelled card payments |
| L6 | Two different epsilons | Single `EPS = 0.01`, matching `confirmCustomerPayment` |

**Accounting-policy choice worth overruling (M4).** There is no bank-charges system
account role in this chart, so the fee is booked to `admin_expense`. If the business wants
a dedicated card-fees account, that is a chart change plus one line here. The fee leg is
best-effort: when the payload carries no fee, or the role is unresolved, the receipt still
stands and the gap is logged, because throwing would turn a settled card payment into a 500.

**Why `createCustomerPayment` is no longer used.** It requires allocations to equal the
payment total. An over-settlement cannot satisfy that invariant, and the only way to satisfy
it is to drop the excess — which is H2. The payment and allocation rows are now inserted
here (the same shape `bankAllocationService` uses for an unapplied receipt) and
`confirmCustomerPayment` still does all the GL work. Its balance validation is replaced by
the explicit clamp against the invoice's outstanding amount.

**Tests.** 8 new real-DB cases, all red on cc6f7bf9's code:
non-UUID author, over-settlement, `paid_at` dating, fee posting, concurrent delivery,
`processing_error` clearing (K-036 suite), plus connection destruction on a failed ROLLBACK
and the nesting refusal (`tests/integration/public-route-tx.int.test.ts`). The unique-index
case proves the migration. Totals: K-035 6, K-036 13, publicRouteTx 4 — 23 passed.

**Migration.** `619` applied to the fixture database to prove it. Checked for violations
first: zero duplicate `(company_id, bank_reference)` card payments in `isaflow_dev` across
57 card payments. Rollback is `DROP INDEX ux_customer_payments_card_reference`. Production
was not queried.
