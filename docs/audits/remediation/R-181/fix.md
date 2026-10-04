# R-181 — Paystack settlement banks the reported amount, never settles an invoice outside the ledger

## Defect

- The webhook (`handleChargeSuccess`, both its branches) and the return page's `verify` route
  settled through `recordGatewayInvoiceReceipt` with `Number(pr.amount_cents) / 100`: the amount
  the checkout ASKED for. `event.data.amount` and `verifyTransaction().amountCents`, the amount
  Paystack says it RECEIVED, were never read. A difference would be banked at the wrong value with
  no log line.
- Settlement had no rule on the invoice. A checkout opened before an invoice went back to draft,
  pending approval, cancelled or soft-deleted could still be paid, and the receipt was allocated
  to an invoice that is not in the ledger (`documentInPopulation` false). That moved
  `amount_paid` on a document no AR report counts.

## Decision (Hein, 2026-10-02)

Bank what Paystack actually received, log an error and flag the receipt for review. On an invoice
outside the ledger, still bank the money (it was received) but do not allocate it.

## Review mechanism

There is no review or exception flag on receipts or bank lines. `customer_payments` has no
flag, note or review column. The fixture schema has no review/exception column on any receipt or
bank table. The two alert tables do not fit: `compliance_alerts` is AFS-only with one active row
per company and type, and `fraud_alerts` needs a supplier.

The closest existing marker is used: `paystack_payment_requests.failure_reason` on the COMPLETED
request. `noteAuthorisationNotAttached` already writes it on a completed request to mean "the card
was charged and nothing could be attached". The value is `review:<reasons>`, comma-joined. The
reasons, as they stand after every review round: `amount_not_reported`, `amount_mismatch`,
`amount_below_requested_amount`, `requested_amount_exceeds_fee`, `requested_amount_unverified`,
`currency_mismatch`, `unapplied_currency`, `invoice_<status>` (`invoice_draft`,
`invoice_pending_approval`, `invoice_cancelled`), `invoice_deleted`, `invoice_balance_invalid`,
`overpaid_unapplied`, `fee_not_posted_currency`, `fee_clamped`, `fee_exceeds_receipt`,
`amount_disagrees_with_first_report` (15, counting `invoice_<status>` once). The receipt is found from the
request by `customer_payments.bank_reference = paystack_reference`. No migration: Hein approved
this marker over one on 2026-10-02, on three conditions, each tested:

- **The note never costs the receipt.** The UPDATE runs in its own savepoint
  (`withSavepoint('gateway_review_note')`). A failure is logged at error level, not thrown. Outside a
  savepoint a failed write aborted the settlement transaction; the webhook answered 500 and the
  receipt rolled back (`red.r2.int.log`).
- **A prior reason is not overwritten silently.** A non-review `failure_reason` the request already
  carried is kept after the note (`review:amount_mismatch | previously: abandoned while starting`,
  the reason `portalLinkCharge` writes on a checkout swept while starting) and named in the log as
  `previousFailureReason`. An earlier review note is merged with the new reasons (review round 1:
  the second report adds to the first, never erases it).
- **The unapplied case is visible.** A receipt banked against an invoice outside the ledger is
  asserted in `getUnappliedReceipts` (the `list_unapplied_receipts` service) for the customer, at
  the full amount.

Limit: nothing in the app shows `failure_reason` for a customer-invoice request yet. The flag can
be queried, and the `log.error` line is what alerts someone. An invoice outside the ledger also
leaves an unapplied receipt on the customer, and that does show in the unapplied-receipts list.

## Fix

- **`src/modules/accounting/services/ar/gatewaySettlementReview.ts` (new).**
  - `settledCharge(requestedCents, reported)` returns the cents to bank and why they need review
    (the rule as it stands after every review round; the rounds below say how it got here).
    It banks `requested_amount` when `0 <= amount - requested_amount <= fees` (the excess is a fee
    the customer paid); otherwise `amount`, flagged `requested_amount_exceeds_fee`,
    `amount_below_requested_amount` or, with no fee figure, `requested_amount_unverified`. With no
    `amount` it banks `requested_amount`; with neither, the request's `amount_cents`; a missing,
    zero or fractional `amount` is always flagged `amount_not_reported` (refusing would make every
    webhook redelivery fail). A banked figure that differs from the request is `amount_mismatch`; a
    currency other than `ZAR` is `currency_mismatch`.
  - `merchantFee` gives the fee leg, `fees - (amount - banked)` clamped to `[0, fees]` and never
    above the receipt, so Bank nets to `amount - fees`. Every comparison that decides a flag or an
    allocation is made in whole cents.
  - `invoiceReview(status, deletedAt)` returns `invoice_deleted` for a soft-deleted invoice,
    `invoice_<status>` for one outside `documentInPopulation`, or null.
  - `flagSettlementForReview` writes the flag, scoped by `company_id` and reference, and logs at
    error level with the company, the reference, expected and reported cents, the reported
    currency, the prior reason, the invoice and what was banked and allocated. See the three
    conditions above.
- **`gatewayInvoiceReceiptService.recordGatewayInvoiceReceipt`** now takes `requestedCents` and
  `reported` instead of `amountRand`. The invoice's `status`, `deleted_at`, balance and customer
  are read UNDER the invoice row lock (`decideGatewayAllocation`, since review round 1). An invoice
  outside the ledger is allocated 0, so the whole receipt is banked unapplied on the customer
  through the existing over-settlement path. The flag is written in the same transaction as the
  receipt. A second delivery banks nothing; since review round 1 it compares its amount with
  what was banked (below).
- **Callers.** Both pass four reported fields. The webhook passes `{ amountCents: data.amount,
  currency: data.currency, requestedAmountCents: data.requested_amount, feeCents: data.fees }` on
  both branches, with `feeRand` from `data.fees`. `verify` passes the same four from
  `verifyTransaction` (`amountCents`, `currency`, `requestedAmountCents`, `feesCents`), and since
  PR #618 its `feeRand` too. Both report the same Paystack transaction, so whichever arrives first
  banks the same amount; a second report that disagrees is flagged (review rounds 1-2, PR #618).

## Argument against

- **Currency.** A non-ZAR charge is banked as if its minor units were cents of rand (the decision:
  "bank the reported amount"), but since review round 2 it is held unapplied (`unapplied_currency`)
  and its fee is not posted, so it never settles the ZAR invoice. The banked figure is still wrong
  in a different way. A Paystack ZA merchant settles only in ZAR, so this is a flag for an
  impossible-in-practice case, not a conversion.
- **The flag lives on the request, not the receipt.** A reviewer has to join through the
  reference. A real review column on `customer_payments` would need a migration, and that was not
  approved.
- **Missing amount falls back to the request.** If verify got no amount and the webhook later
  reported a different one, the first to arrive wins and the amounts could differ. Paystack always
  reports both, and the fallback is flagged.
- **No surface.** A flagged receipt is only found through the log or a query until something
  reads `failure_reason`.

## Tests

`tests/integration/r181-settlement-amount.int.test.ts` (helpers in `r181-settlement.helpers.ts`).
Real Postgres, the real webhook route and verify route. Only `paystackClient` is stubbed.

- Reported = requested: unchanged behaviour, no flag, no error log.
- Reported < requested (R50 of R115): R50 banked and allocated, flagged, logged with expected and
  reported cents.
- Reported > requested (R200): R200 banked, R115 allocated, R85 unapplied, flagged.
- Currency USD: banked, flagged, logged with the reported currency.
- No amount, 0, or 115.5 cents: the request amount banked, flagged `amount_not_reported`.
- A request already completed with nothing banked: the webhook's completed branch banks the
  reported amount.
- Verify banks what Paystack verified.
- Draft, pending approval, cancelled, soft-deleted (webhook), and draft (verify): banked in full,
  allocated 0, invoice `amount_paid` untouched, flagged, logged, and listed as unapplied for the
  customer.
- The note write made to fail for real (22012 inside the transaction): 200, the receipt banked, the
  request completed, no note, the failure logged.
- A prior `abandoned while starting` reason is kept after the note and logged. A prior review note
  is merged with the new reasons, and its own prior reason kept.
- Webhook then verify, and verify then webhook: one receipt, the reported amount, in either order.
- Tenant isolation: a flagged settlement in company A writes nothing in company B. A request in A
  naming B's invoice settles nothing (500, rolled back).

Evidence: `red.int.log` (12 of 14 red on the unchanged code, origin/master 82bd2afdc; the
unreported-amount and completed-branch cases were added after it), `red.r2.int.log` (the two
note-condition tests red on the round-1 note write, 5d312dc1e), `red.r3.int.log` (review round 1:
12 of 31 red on f7ef79b60/028c26bcf), `green.int.log` (31/31 over both R-181 suites),
`mutations.log` (43 mutants over every guard in the final code: 42 killed, 1 equivalent),
`regression.int.log` (187/187: k-036, k095*, k096, r166, r167*, r177, r178, k101, r181*). The full
unit suite passed (1281 files) on ce90064fd.

`k-036` changed: its part-payment and over-settlement cases seeded a request for R400 / R1,650
but delivered a webhook reporting R1,150. Their deliveries now report the settled amount, as
Paystack's would.

## Review round 1

Both blind reviewers scored 5d312dc1e (general: FIX, adversarial: SHIP). The overwrite finding was
already closed by f7ef79b60. The rest, fixed in ce90064fd and a684f6f64:

1. **MEDIUM — a fee the customer paid became customer credit.** When the Paystack account passes
   charges to the customer, `amount` = `requested_amount` + fee. A R115 invoice paid at R118.50
   banked R118.50: R115 allocated, R3.50 unapplied credit, the fee expensed as well, and every
   settlement flagged. `requested_amount` is a field of Paystack's transaction (Paystack OpenAPI
   `VerifyResponse.requested_amount: integer`; the repo had no recorded payload carrying it, and
   no fixture under `tests/fixtures`). The webhook passes `data.requested_amount`;
   `verifyTransaction` maps it to `requestedAmountCents` (unit-tested). When present it is the
   receipt and the comparison with the request. `merchantFee` posts only the fee the merchant
   bore, `fees - (amount - requested_amount)`, so Bank nets to `amount - fees`, what Paystack
   settles. Proven for both account modes: passed on (Bank R115, no fee expense) and borne by the
   merchant (Bank R111.50, fee R3.50), and with no `requested_amount` (today's rule). An `amount`
   below `requested_amount` makes the latter untrustworthy: the amount is banked, no fee is credited
   back, and it is flagged `amount_below_requested_amount`.
2. **LOW — non-ZAR.** Still banked (Hein). The receipt description names the reported currency
   and amount (`(USD 115.00 reported, booked as ZAR)`). Its fee is not posted as rand; it is
   flagged `fee_not_posted_currency`.
3. **LOW — the second report was never compared.** The dedupe path now compares its amount with
   the banked `total_amount` and flags `amount_disagrees_with_first_report`, logging both figures.
   Both orders tested. Verify only asks Paystack about a request that is not completed, so
   "webhook first" is the webhook landing while verify's gateway call is out; the test does that.
   Review notes now MERGE: the second report adds reasons to the first and never erases them.
4. **LOW — an overpayment matching the request** (invoice already paid by EFT) is flagged
   `overpaid_unapplied`: the customer is owed a refund or a placement.
5. **LOW (pre-existing) — over-allocation race.** `decideGatewayAllocation`
   (`gatewayReceiptAllocation.ts`) locks the invoice row through `withCustomerInvoiceLock` (5s,
   typed timeout) and re-reads status, `deleted_at` and balance under the lock. Lock order: the
   receipt's own `customer_payments` row is inserted first, then the invoice is locked
   (payment-then-invoice, the canonical sequence in `bank/.claude.md`). A timeout loses nothing:
   the settlement rolls back, the webhook answers 500 and Paystack redelivers; verify logs it and
   leaves the request pending (tested: lock held by another connection, webhook 500, verify
   pending, nothing banked; released, the redelivery banks it). The race test holds the first
   settlement's locked read open for 1.5s while a second settlement for the same invoice starts:
   one allocates R115, the other 0 (and is flagged overpaid). The hook asserts it fired.
6. **LOW — tests.** The r167 and k-036 verify mocks now report an amount and ZAR, so their normal
   settlements no longer take the fallback path. The comment names the column, not "the same
   marker". The blocked and overpaid cases assert the receivable credit leg and that every journal
   for the reference balances (`ledger()` in the helpers).
7. **Recorded, not changed.** The review flag is not shown anywhere in the UI: Hein chose the log
   line and the note. The `company_id` predicate on the flag UPDATE is an equivalent mutant: the
   reference is unique across the table, so no test can tell it apart; it stays as tenant scoping.

Tests for this round: `tests/integration/r181-review-round1.int.test.ts` (12 cases) and a
`requested_amount` mapping case in `tests/unit/services/billing/paystackClient.test.ts`. The race
case had no meaningful red on the old code (its hook targets the new locked read and fails on
"hook did not fire"); the proof that the lock matters is mutant M36, which removes `FOR UPDATE` and
turns it red.

Not changed and worth knowing: `paystackClient.ts` was already over 300 lines (425) before this
change; three lines were added to it.

## Review round 2 (general reviewer, 82fd809d0: FIX, LOW only)

- **LOW-1. The second report dropped its own reasons.** The dedupe path compared amounts only, so
  verify `{11500, ZAR}` then a webhook in USD, or a webhook with no amount, was never flagged. It now
  merges the second report's own `settledCharge` reasons with the disagreement and fee reasons. As a
  result a redelivery of a report that already disagreed with the request logs it again; the note
  merge makes the stored flag idempotent.
- **LOW-2. The second report's fee was costed against itself, not against what was banked.**
  Verify with no `requested_amount` banks R118.50; the webhook then reports `requested_amount`
  R115 and fees R3.50, and `merchantFee` posted R0, so Bank netted R118.50 against a R115.00
  deposit. `merchantFee` now takes the receipt as booked (`bankedCents`): on the first report the
  receipt it is about to bank, on the second what the FIRST report banked. Bank then nets to
  `amount - fees`, the deposit.
  Trade-off, explicit: in that case the R118.50 receipt stands (receipts are not rewritten
  automatically), so R3.50 sits on the customer as unapplied credit while R3.50 is expensed as a fee
  the customer actually paid. Bank is right; AR and fee expense are each overstated by the
  customer-paid fee, and the request is flagged (`amount_mismatch`,
  `amount_disagrees_with_first_report`, `overpaid_unapplied`) for a person to offset the two.
  The excess is never negative: a second report BELOW what was banked expenses only the reported fee
  (the gap is the receipt's, flagged), so Bank nets to `banked - fee` there, not the deposit. Tested.
- **LOW-3. `requested_amount` with no `amount`** banked R115 with no flag. `amount_not_reported`
  is now raised whenever `amount` is missing; `requested_amount` is still what is banked.
- **LOW-4.** The R-181 entry in `ar/.claude.md` no longer says the flag is written only on creation;
  mirror regenerated.
- **Cosmetic.** `composeReviewNote` treats an empty prior reason as none, so no trailing
  `| previously: `.

Tests: six cases appended to `r181-review-round1.int.test.ts`; five red on 82fd809d0
(`red.r4.int.log`), the sixth (second report below what was banked) added to kill mutant N5.
Green 37/37 over both R-181 suites; mutants N1..N5 on the new guards all killed (`mutations.log`).

## Review round 2 (adversarial reviewer: one MEDIUM, four LOWs)

- **MEDIUM. `requested_amount` was trusted whenever it was not above `amount`.** Request R100,
  `amount` R103, `requested_amount` R50, fees R3 banked R50 with no fee while Paystack settled
  R100; `requested_amount` R100 with fees R2 banked R100 against a R101 settlement. It is now
  trusted only when the excess is a fee the customer paid, `0 <= amount - requested_amount <= fees`
  (`requestedAmountDistrust`). Otherwise `amount` is banked and the request flagged
  (`requested_amount_exceeds_fee`, `amount_below_requested_amount`), and the clamped fee leg below
  nets Bank to `amount - fees`.
  **Verify without a fee figure.** Paystack's verify response has `fees` (OpenAPI
  `VerifyResponse.fees`, nullable), and `verifyTransaction` now maps it to `feesCents`. When it is
  null and `amount` exceeds `requested_amount`, the excess cannot be bounded. Chosen: bank `amount`
  and flag `requested_amount_unverified`. Reason: that is the choice that keeps Bank equal to the
  settlement in every case. When the webhook arrives, its fee leg is `fees - (amount - banked)` =
  `fees`, so Bank nets to `amount - fees` whatever `requested_amount` said. Banking
  `requested_amount` instead would be right for a genuine customer-paid fee, but leaves Bank short
  by the excess the moment `requested_amount` is wrong (the MEDIUM's own case), and the clamp could
  only flag that, not book it. The cost of the choice: on a pass-on account where the return page
  beats the webhook AND the verify response carries no fee, the customer-paid fee sits as unapplied
  credit and is also expensed. Both are flagged (`requested_amount_unverified`,
  `amount_disagrees_with_first_report`, `overpaid_unapplied`) for a person to offset. When verify
  does carry `fees` (the schema says it does), the excess is bounded and `requested_amount` is
  banked as on the webhook. When `requested_amount` equals `amount` no fee figure is needed.
- **LOW. The fee leg used the second report's `requested_amount` against the first report's
  receipt.** Since round 2 (general) it is costed against what was banked. It is now
  `fees - (amount - banked)` clamped to `[0, fees]`, and a clamp that bites is flagged
  `fee_clamped`: Bank cannot reach the deposit with a fee in that range, so the gap is left for a
  person rather than booked as a fee. Both orders pinned: verify R103 then the webhook
  (`requested_amount` R100, fees R3) books the full R3 (Bank R100); verify R100 then the webhook
  reporting R103 books no fee (Bank R100).
- **LOW. A non-ZAR receipt was still allocated** to the ZAR invoice, so a USD figure could mark it
  paid. It is still banked (Hein) but held unapplied like an invoice outside the ledger, and
  flagged `unapplied_currency` (with `currency_mismatch`). `decideGatewayAllocation` takes the
  caller's hold.
- **LOW. A missing `amount` with `requested_amount` present** — the general reviewer's LOW-3,
  already fixed in 45aeb23c5.
- **LOW (pre-existing). The customer was read before the invoice lock.** A merge committed between
  the read and the lock left the receipt on the merged-away customer. Chosen: re-read
  `COALESCE(client_id, customer_id)` in the locked read and UPDATE the receipt's own payment row
  when it differs, BEFORE the allocation and confirmation. Not chosen: moving the payment INSERT
  after the lock, which would reverse the payment-then-invoice order round 1 established and argued
  for. The row is our own, uncommitted, so the UPDATE contends with nobody. Test: the race-window
  hook runs the merge's effect on the invoice (moved to the survivor, the source soft-deleted,
  committed through a separate connection) just before the locked read; red on 45aeb23c5/48c783db3
  (the payment stayed on the merged-away customer), green now. It simulates the merge's committed
  writes rather than running `mergeCustomers`, which needs a request transaction of its own.

Tests: `tests/integration/r181-review-round2.int.test.ts` (11 cases), the client unit test maps
`fees`, and the non-ZAR expectations in the two earlier suites now require it unapplied. Red: 8 of
46 on 48c783db3 (`red.r5.int.log`; the two fee-order cases were already green after round 2's
LOW-2 and pin it). Green 47/47. Mutants P1..P11 on the new guards: all killed (P3 after one added
case). Regression: 238 tests across k-036, k095*, k096, r166, r167*, r177, r178, k101, k061*,
r181*: 238 of 239 pass. The one failure is a k061 contention case (`a bulk allocation
interleaving ... with a merge`): it expects a 40P01 that does not occur. It passes alone (3/3, and
36/36 for the k061 files). **It reproduces on master**: a detached worktree at origin/master
82bd2afdc, the same 24 non-R-181 files, 1-minute load under 30, failed 3 of 7 runs with the
identical assertion (`expected 'committed' to be '40P01'`); the branch head b331f20e2, alternating
with it, failed 2 of 6 completed runs (a seventh was stopped mid-run). It is a pre-existing
timing-sensitive test, not an R-181 regression.
Fixture caveat: those attribution runs used 127.0.0.1:55790, which is `isaflow-fixture-brk-d8c`,
a peer session's container, chosen by mistake (it was the only local fixture with migrations
718/719). The stopped seventh branch run left 8 test companies there, reported to the
orchestrator. Every other R-181 evidence log (red, green, mutations, regression) ran on
`isaflow-fixture-r181`, 127.0.0.1:55563.

## Accepted residual risk

- **Verify without a fee figure on a pass-on account.** When the return page beats the webhook and
  Paystack's verify response carries no `fees`, `amount` is banked (e.g. R118.50 on a R115
  invoice). The webhook's fee leg then nets Bank to the deposit, but the customer-paid fee (R3.50)
  stays on the customer as unapplied credit and is also expensed. It is flagged
  (`requested_amount_unverified`, `amount_disagrees_with_first_report`, `overpaid_unapplied`) for a
  person to offset. Accepted: the alternative leaves Bank wrong whenever `requested_amount` is
  wrong, and Bank is the figure the statement reconciles against.
- **The review flag has no UI**; the log line and `failure_reason` are what surface it (Hein).
- **Two fee skips warn and do not flag (pre-existing, unchanged).** Where Bank cannot reach the
  settlement, the request is flagged, with two exceptions in `postGatewayFee`: a receipt with no
  bank account (the fee leg is skipped with `log.warn`), and no resolvable `admin_expense` system
  account (skipped with `log.warn`). In both, Bank stays above the deposit by the fee and the request
  carries no review reason; only the warning records it.
- **Evidence logs and the commit they ran at.** `green.int.log` before this round ran on the tree
  committed as fa0d98e9f. From this round every evidence log starts with a `HEAD:` line naming the
  commit it ran at.
- **The first report's `amount` lives in a free-text tag** (`[paystack amount N cents]` in
  `customer_payments.description`), the kind of free-text match `gatewayFeeService` rejects for its
  own idempotency. If the tag were edited or renamed between verify and the webhook, a spurious
  `amount_disagrees_with_first_report` would be raised. The impact is a wrong flag only; no money
  moves. No code path edits a receipt description today (cancel only appends ` [CANCELLED]`, and
  cancelled receipts are excluded from the dedupe read). The tag is not customer-visible:
  statements use `bank_reference` and the portal uses fixed labels.
- **Verify's `pending` can stay pending indefinitely.** When the settlement fails for a permanent
  cause, verify keeps answering `pending` (never `failed`, so the payer is not invited to pay
  again). The return page polls it at most 10 times, 3 s apart, and a 429 from verify's per-IP
  limit ends the polling the same way: the payer lands on a neutral "Still confirming your
  payment" state ("check back later, or contact <company>"), not on an error. It promises no
  email, because the settlement sends none. The webhook fails on the same cause loudly: it answers
  500, keeps the event `processed = false` with its `processing_error`, and Paystack redelivers.
- **A one-cent excess over `fees` (10301 / 10000 / 300) is not trusted** (PR #618 final review
  LOW-1). `amount` R103.01 is banked and flagged `requested_amount_exceeds_fee`; the fee leg makes
  Bank R100.01 = `amount - fees`, so Bank is right, but a customer-paid fee becomes customer credit
  plus expense. Accepted: a tolerance would leave Bank a cent off the settlement. **Unverified
  against real Paystack pass-on payloads**: if Paystack's `amount - requested_amount` routinely
  exceeds `fees` by a rounding cent, every pass-on charge takes this path. Pinned as current
  behaviour in `tests/unit/services/ar/gatewaySettlementRules.test.ts`.
- **`paystackClient.ts` is 432 lines** (over the 300-line limit; 425 before R-181): R-183, not
  split here.
- **On a pass-on account the return page shows what the merchant received**, not the card charge:
  a R118.50 charge with `requested_amount` R115 reads "R 115,00 has been received". Deliberate: the
  figure is the receipt booked against the customer; the payer's card statement shows the full
  R118.50, which includes Paystack's fee.
- **The fee journal has no unique constraint (R-185, pre-existing).** `postGatewayFee` guards with a
  SELECT on (company, reference, posting agent) and then inserts; two dedupe-path settlements for
  one reference at the same moment (for example two different webhook bodies arriving together)
  can both pass the SELECT and post the fee twice. Registered as R-185 (fix: a partial unique
  index, or an advisory lock on the reference); not introduced by R-181 and not fixed here.
  Fixed under R-185 (branch fix/r185-gateway-fee-unique-20261003; not deployed):
  partial unique index `ux_gl_je_gateway_fee_reference` (migration 852) plus an outcome re-read in
  `postGatewayFee` (`docs/audits/remediation/R-185/fix.md`).
- **A cancelled gateway receipt does not stop a re-bank (R-187, pre-existing).** The receipt dedupe
  and `ux_customer_payments_card_reference` both exclude cancelled receipts, so if a person cancels
  a Paystack receipt and a `charge.success` for that reference is processed again in a different
  body, a new receipt is banked. Registered as R-187 with a census query and two fix options
  (dedupe on any receipt including cancelled, or record the settlement on the request); found in
  the D8 lock-timeout review of this PR, not introduced by R-181 and not fixed here.
  **Fixed in R-187 (2026-10-03):** the dedupe reads a live receipt for the reference, else a
  cancelled one the GATEWAY wrote (its journal's `posting_agent`); that match banks nothing, posts no
  fee and flags the request `already_settled_cancelled_receipt`. A cancelled manual or bank-feed
  receipt with the reference does not block. The index is unchanged (`docs/audits/remediation/R-187/fix.md`).

## Review round 3 (both reviewers: SHIP; residual LOWs)

- **The fee leg had no cap at the receipt.** `amount` R100 with `fees` R200 posted a R200 fee
  against a R100 receipt, unflagged. The leg is now capped at the banked amount and flagged
  `fee_exceeds_receipt` (red first; mutants Q1, Q2).
- **Test gap: verify trusting `requested_amount`.** Verify reports R103, `requested_amount` R100,
  fees R3 and banks R100; the webhook with the same figures posts no fee. Bank nets R100, the
  receivable is credited R100, the ledger balances, no review. It was already correct; the case
  pins the branch. Mutants that turn it red: verify passing no fee figure (Q3), no
  `requested_amount` (Q4), and an excess equal to the fee distrusted (Q5).
- **`paystackClient.ts` is 432 lines** (425 at 82bd2afdc, +7 from R-181): registered as R-183, not
  split here.

## PR #618 blind review (SHIP, 7 LOWs; LOW-6 is R-183)

- **LOW-1. Verify had the fee but did not post it.** If the webhook never lands, Bank stayed
  overstated by the fee. Verify now passes `feeRand` from its own `fees` (null when absent);
  `postGatewayFee`'s reference + posting-agent idempotency keeps the webhook from posting it again
  (tested: one fee journal after verify then webhook). The stale comment is gone.
- **LOW-2. A NaN invoice balance** (numeric NaN in `total_amount` or `amount_paid`, a real legacy
  state, R-166) banked the receipt unapplied with no flag or log. A non-finite balance now blocks
  the allocation like an invoice outside the ledger: `invoice_balance_invalid`. The test writes the
  legacy NaN with triggers off for that one statement (migration 692 refuses new NaNs).
- **LOW-3. The lock-order note was wrong.** The real order is request row → explicit-amount link
  (`spendPaymentLinkOfRequest`) → the receipt's own payment row → the invoice. `customerMergeService`
  takes invoice → link, the opposite: a merge racing the settlement of the same customer's
  explicit-amount link can raise 40P01. Pre-existing and recoverable (the webhook answers 500 and
  is redelivered; the merge errors and is retried). Documented in `gatewayReceiptAllocation.ts` and
  `ar/.claude.md`; `spendPaymentLinkOfRequest` was not moved (instruction).
- **LOW-4. A charged payer could be told "failed".** A request stored `failed` that Paystack says
  succeeded, whose settlement then throws (a 5s invoice-lock timeout in the test), answered
  `failed`. Verify now answers `pending` whenever Paystack said success and the settlement threw;
  the request stays as stored and the webhook settles it.
- **LOW-5. Two different Paystack `amount`s for one transaction went unflagged** when the figure
  each would bank was the same (verify `amount` R100; webhook `amount` R103, `requested_amount`
  R100, fees R3). The first report's `amount` is now recoverable without a migration: when it
  differs from what was banked it is tagged in the receipt description
  (`[paystack amount 10300 cents]`); otherwise it equals the receipt. A second report whose
  `amount` differs from it is flagged `amount_disagrees_with_first_report`, in both orders.
  Residual: a first report with no `amount` is taken to have reported what it banked, so a second
  report then compares against that figure.
- **LOW-7.** fix.md "Fix → Callers" and "Argument against → Currency" corrected; the R-181 entry in
  `ar/.claude.md` rewritten as a rule list (banked / allocated / fee leg / second report / flagged /
  lock order); mirrors regenerated.

Tests: `tests/integration/r181-pr618.int.test.ts` (5 cases) and the round-2 case LOW-5 named, now
expecting the flag. Red 5 of 18 on a8aad8465 (`red.r7.int.log`); green 55/55 over the four R-181
suites; mutants S1..S7 all killed (`mutations.log`); regression 246 of 247 (the one failure is the
pre-existing k061 contention case above). All on `isaflow-fixture-r181`, 127.0.0.1:55563.

## PR #618 final blind review (at 745d6e8d6: FIX, 1 MEDIUM + 4 LOWs)

- **MEDIUM-1. CI ran no test of the money rules**: every R-181 test was an integration test, and
  those are skipped on GitHub (empty `DATABASE_URL`). `tests/unit/services/ar/gatewaySettlementRules.test.ts`
  is a table of every case in this file: `settledCharge` ({cents, reviews}), `merchantFee`
  ({feeRand, reviews}, with Bank netting to `amount - fees` asserted wherever it can),
  `composeReviewNote`, the description tag, `invoiceReview`, and the allocation arithmetic, now a
  pure `allocationPlan` that `decideGatewayAllocation` calls. 53 cases; the 10 allocation cases
  were red until `allocationPlan` existed (`red.r8.unit.log`). Under `env -u DATABASE_URL vitest
  run`, `>` → `>=` in `requestedAmountDistrust` (line 58) turns 3 cases red and dropping the
  receipt cap (line 111) turns 1 red (`mutations.log`).
- **LOW-1.** The one-cent excess: accepted and pinned (residual above).
- **LOW-2. The return page.** verify now answers `amountCents` with what was banked (the receipt's
  `total_amount`; the request amount only before anything is banked) and `appliedToInvoice`
  (whether the invoice took any of it). The page names the invoice only when it did, and stops
  polling after 10 tries or a 429 on "Still confirming your payment". Tests: three verify cases in
  `r181-pr618.int.test.ts` (red 3/8, `red.r8.int.log`) and `tests/unit/components/paystackPortalReturn.test.tsx`
  (red 3/4, `red.r8.component.log`). The completed state's line "A receipt has been emailed to
  you" was a promise nothing keeps (the settlement sends no email): removed, not replaced; the
  page now says only "You can close this window." (red first, `red.r9.component.log`).
- **LOW-3.** The "verify carries no fee" comments (`gatewayFeeService.ts`,
  `gatewayInvoiceReceiptService.ts`, `paystackEventHandlers.ts`) corrected; `fees` added to
  `billing/.claude.md`; mirrors regenerated.
- **LOW-4.** `paystackClient.ts` stays R-183.

## Review at 72b132f52 (FIX: M1 + 3 LOWs)

- **M1. CI gated the arithmetic, not the wiring.** Unit tests, run without a database:
  `tests/unit/services/ar/gatewayReceiptWiring.test.ts` pins `recordGatewayInvoiceReceipt`'s receipt
  INSERT total, the fee leg handed to `postGatewayFee` and the non-ZAR hold, for the pass-on,
  merchant-borne, non-ZAR and dedupe paths (on dedupe, the fee costed against the FIRST report's
  banked figure). `tests/unit/services/billing/paystackSettlementPassThrough.test.ts` pins that the
  webhook (both branches) and verify hand over `amount`, `currency`, `requested_amount`, `fees` and
  the fee leg. Under `env -u DATABASE_URL`, mutants W1..W8 all go red: the raw receipt to
  `postGatewayFee`, the dedupe fee against this report, the hold dropped, `requestedAmountCents` /
  `fees` dropped at verify and at the webhook, verify's fee leg dropped (`mutations.log`).
  **The invoice lock is not CI-gated; it is proven by the r181 integration race test**
  (`r181-review-round1.int.test.ts`, two settlements racing for one invoice; mutant M36). The CI
  workflow is unchanged.
- **L1. A one-cent fee leg was dropped.** `postGatewayFee` skipped `fee <= 0.01`, so R118.50 /
  R115 / R3.51 computed a R0.01 merchant share and posted nothing, leaving Bank a cent above the
  deposit. It now skips only below half a cent. Callers checked: `postGatewayFee` is called only from
  `gatewayInvoiceReceiptService` (first-report and dedupe paths), both with `merchantFee`'s
  cent-rounded figure; nothing relies on a one-cent floor. Pinned in the unit table, in
  `gatewayFeeLeg.test.ts` and in `r181-pr618.int.test.ts` (Bank R114.99, fee R0.01).
- **L2. A non-ZAR payer saw a rand figure.** verify now also answers `currency`: the receipt's
  reported currency, read from its description tag (`receiptCurrency`, the reader of the tag
  `receiptDescription` writes), else ZAR. The return page shows the figure only for ZAR; otherwise
  "Thank you. Your payment has been received." Response shape:
  `{ status, amountCents, appliedToInvoice, currency, invoiceNumber?, companyName? }`.
- **L3.** The dedupe path's lock order (spend link → fee journal → request row `FOR UPDATE` last, no
  `lock_timeout`, no cycle because the request is already completed) is in `ar/.claude.md` and the
  `gatewayReceiptAllocation.ts` header. `return.tsx` and `gatewayFeeService.ts` are in R-181's
  `affectedPaths`.

Red: unit 1 of 59 (`red.r10.unit.log`), component 1 of 5 (`red.r10.component.log`), int 3 of 11
(`red.r10.int.log`); the wiring tests pin existing behaviour and are proven by their mutants.
Green: R-181 integration 61/61 on 55563.

## Review at 6a46d8417 (FIX: 2 MEDIUM test gaps + 2 LOWs)

- **M1. Two wiring mutants survived the unit suite.** `gatewayReceiptWiring.test.ts` gains a dedupe
  case where verify trusted `requested_amount` (R115 banked, `amount` R118.50 tagged): the webhook's
  customer-paid R3.50 must reach `postGatewayFee` as R0 (the raw R3.50 would net Bank R111.50
  against a R115 deposit), and a case where the locked invoice takes R50 of a R115 receipt: the
  allocation INSERT must carry R50. Mutants X1 (raw receipt on dedupe) and X2 (whole receipt in the
  allocation INSERT) now go red without a database.
- **M2. verify's payer-facing answers were untested in CI.** `tests/unit/services/billing/paystackVerifyRoute.test.ts`
  runs the route with its dependencies mocked: a request stored `failed` that Paystack says
  succeeded, whose settlement throws, answers `pending`; a settled payment answers its banked
  `amountCents`, `appliedToInvoice` and `currency` (ZAR applied, USD held, nothing banked yet).
  Mutants X3..X6 go red.
- **L1.** The pass-on figure on the return page is recorded above as deliberate.
- **L2.** `ar/.claude.md` now states the allocation as `min(banked, total - amount_paid - draft
  receipts' open allocations)`; mirror regenerated.

Evidence: unit 73/73 and component 5/5 under `env -u DATABASE_URL`; X1..X6 all killed
(`mutations.log`). No database run this round.

## Review at 7c0e9c407 (FIX: M + 2 LOWs + one register)

- **M. More wiring escaped the unit suite.** `gatewayReceiptWiring.test.ts` now pins the review
  reasons (first report; an invoice outside the ledger; the second report's Paystack `amount`
  differing from the first's; bank figures one cent apart), the INSERTed description
  (`receiptDescription`) and the receipt's re-point to the customer read under the lock. Mutants
  Y1..Y5 go red without a database: the main-path flag removed, `invoiceBlock` dropped, the
  Paystack-amount comparison dropped, a plain description, the re-point removed.
- **L1. One-cent decisions were made in float rand** (`2.01 - 2.00 > 0.01` is false). Every
  difference that decides a flag or an allocation is now compared in integer cents: the second
  report's bank figure, the allocation INSERT threshold, `allocationPlan`'s balance, allocation and
  overpayment, `merchantFee`'s clamp and receipt cap, `postGatewayFee`'s skip and verify's
  `appliedToInvoice`. The orphaned `EPS` export is gone. Unit cases at one cent (R2.01 vs R2.00,
  R20000.01 vs R20000.00, a one-cent allocation, a one-cent clamp, one cent applied); mutants C1..C6
  restoring the float comparisons go red.
- **L2.** The "Fix" section above states the current rule.
- **Registered: R-186** (archiving and Paystack requests). Probed on the fixture in a rolled-back
  transaction: deleting a paid invoice that a `customer_invoice` request references does NOT leave
  the request with a NULL invoice id: `ON DELETE SET NULL` violates `paystack_pr_invoice_has_invoice`
  and the DELETE fails with 23514. So the "completed and never banked" outcome cannot arise while
  that CHECK is validated; what is reachable instead is the archive run failing for any company
  whose archivable invoice has a Paystack request. Details and census queries in the R-186 entry.

Evidence: unit 87/87 and component 5/5 under `env -u DATABASE_URL`; Y1..Y5 and C1..C6 all killed
(`mutations.log`, red before the change `red.r11.unit.log`); R-181 integration 61/61 on 55563.

## Review at 47c581ac0 (FIX: M1 + 3 LOWs)

- **M1. `decideGatewayAllocation` had no unit test.** `tests/unit/services/ar/gatewayAllocationLocked.test.ts`
  runs it with `sql` mocked and `withCustomerInvoiceLock` as a pass-through that records its
  statement: the invoice is read `FOR UPDATE`, scoped by `company_id`, inside the lock; a draft row
  takes nothing (`invoice_draft`); `deleted_at` set takes nothing (`invoice_deleted`); R20 of draft
  receipts on a R115 balance leaves R95 for a R115 receipt, overpaid; the `unapplied_currency` hold
  takes nothing; the customer read under the lock is returned. Mutants A1..A5 (status, deletedAt,
  pending, hold, clientId) go red, and so does A6 (the `FOR UPDATE` removed): the statement's lock
  clause is now asserted in CI. What the lock DOES under contention is still proven only by the r181
  integration race test.
- **L1.** Wiring cases now assert the flagged reasons for the dedupe path's own `charge.reviews`, for
  `overpaid_unapplied` and for the main path's `fee.reviews`; mutants dropping each go red.
  **verify's `FILTER (WHERE a.invoice_id = ...)` in the `appliedToInvoice` query is
  integration-only** (the unit test mocks the query); it is proven by `r181-pr618.int.test.ts`.
- **L2. A request stored `failed` whose live check threw** (timeout, 5xx) answered "failed" to a
  payer who may have been charged ("No money has left your account"). verify now answers `pending`
  unless Paystack itself said failed: `pending` when Paystack said success and the settlement threw,
  or when Paystack never answered on a request stored `failed`. Unit test red first; mutant
  restoring the old condition goes red. The claim this PR makes is therefore: **a payer is told
  "failed" only when Paystack said the charge failed.**
- **L3.** The one exception to master's "no payment lock while holding an invoice lock" rule
  (`confirmCustomerPayment` locks the settlement's own uncommitted payment row while the invoice is
  held; safe because no other transaction can see it) is stated in `ar/.claude.md`,
  `gatewayReceiptAllocation.ts` and `customerInvoiceLock.ts`. "about 30s" is now "10 polls, 3 s apart".

## Review at fa0d98e9f (SHIP, 3 LOWs)

- **L1. A request stored `failed` that Paystack still reports `pending`** told the payer "Payment
  failed. No money has left your account". verify now answers `pending` in that case; only
  Paystack's own `failed`, `abandoned` or `reversed` (`paystackClient.mapStatus`; anything else is
  `pending`) keeps a stored `failed`. Unit tests: pending → `pending`, reversed → `failed`; mutant D1
  (the new line removed) red.
- **L2. The draft-receipt deduction's conditions are asserted**: `gatewayAllocationLocked.test.ts`
  reads the recorded SQL and values (`cp.status = 'draft'`, `cpa.invoice_id` and `cp.company_id`
  bound to this invoice and company). Mutants D2 (status filter removed) and D3 (company scope
  removed) red.
- **L3.** The review-reason list above is complete; the "Fix" section says the invoice is read under
  the lock; the two warn-only fee skips are named as the exceptions to "flagged wherever Bank cannot
  reach the settlement" (here and in `ar/.claude.md`); evidence logs now carry a `HEAD:` line.
