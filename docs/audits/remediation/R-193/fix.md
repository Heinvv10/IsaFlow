# R-193 — a replay reads a live gateway receipt while a cancel of it commits

Stacked on R-189 (branch `fix/r189-draft-receipt-holds-reference-20261005`): both change
`gatewaySettledReceipt.findSettledReceipt`.

## Claim, verified
`findSettledReceipt` was a plain read. A charge.success replay (another body, or verify) could read
the gateway receipt LIVE while `cancelCustomerPayment` of it was in flight; the cancel committed; the
replay went on down the live second-report path and `postGatewayFee` posted the fee leg against the
now-cancelled receipt, with no review reason. Reproduced on the fixture (`red.int.log`, first case):
one fee journal, receipt cancelled, `review: null`.

## Lock-order analysis (done before choosing the mechanism)
Orders involved, from the code at the R-189 head:
- R-181 settlement (webhook guarded UPDATE, or verify): request row → explicit-amount link
  (`spendPaymentLinkOfRequest`, an UPDATE that only matches an ACTIVE link) → the new receipt row
  (INSERT) → the invoice (`withCustomerInvoiceLock`, 5 s).
- Dedupe (receipt already banked): link → fee journal INSERT → request row `FOR UPDATE` last (the
  review note).
- `cancelCustomerPayment`: bank line (`lockReceiptBankLeg`) → payment (`lockCustomerPaymentForUpdate`)
  → invoices (id order) → journal head; under one 5 s flow budget. It touches neither the payment link
  nor the Paystack request.
- `customerMergeService`: receipts (`customer_payments ... FOR UPDATE`, line 92) → invoices → ... →
  `UPDATE portal_payment_links` (line 139). So merge takes receipt BEFORE link.

Adding `FOR UPDATE OF cp` to the dedupe read where it sat (after the link spend) would make the
settlement take link → existing receipt, the inverse of merge's receipts → link. That pair only
locks the link when it is still ACTIVE, which happens when a live receipt already exists on the
FIRST report (the R-189 draft case, or a confirmed manual receipt), so it is narrow, but it is a
real cycle. Moving the spend after the read gives receipt → link everywhere, consistent with merge.
Against cancel: the replay holds the receipt, then inserts a NEW fee journal (no existing journal row
is locked) and locks the request row; cancel holds a bank line and then waits on the receipt, and
never asks for the link, the request or the fee journal. No cycle. A first-path settlement holds the
request row, then the receipt; nothing that holds a receipt waits on a Paystack request row (cancel,
merge, allocation, bank unwind and MCP void never touch it). The FOR UPDATE therefore inverts no
order once the spend is moved, so the read-then-recheck alternative was not needed. (A re-check after
the fee would also not close the window: the cancel can commit after the re-check and before the
replay's commit.)

## Fix
- `gatewaySettledReceipt.findSettledReceipt`: `FOR UPDATE OF cp` on every receipt for the reference,
  `ORDER BY cp.id` (a total lock order), inside `withRowLockBudget` (5 s; `RowLockTimeoutError`).
  `LIMIT 1` is gone: the rows are ranked in code (settlement, other live, cancelled gateway; id breaks
  ties, the sort is stable). Locked rows are re-checked by Postgres after the wait (READ COMMITTED
  re-evaluation), so a receipt cancelled while we waited comes back cancelled and takes the R-187
  branch; a non-gateway receipt cancelled while we waited drops out of the result.
- `gatewayInvoiceReceiptService.recordGatewayInvoiceReceipt`: `spendPaymentLinkOfRequest` runs after
  the dedupe read (still before any branch, so every outcome spends the link as before).
- A wait past the budget: the webhook answers 500 (its handler maps every processing error to 500;
  the event stays `processed = false` and Paystack's redelivery is processed, K-035); verify answers
  `pending` (its existing settlement catch). No route change.

## Side effect on R-185
Two dedupe-path deliveries for one reference are now serialised at the receipt: the second waits
for the first and then finds its fee journal by the guard. The R-185 route races (which paused one
delivery mid fee-post and ran the other) therefore no longer reach the 852 index; they are re-pinned
in `r185-gateway-fee-unique.int.test.ts` to the new contract: B is seen blocked behind A on the
receipt read, one fee journal, no 23505 stand-down (A rolled back: B posts the fee). The index stays
as the backstop with its own SQL tests in that file, and the stand-down by outcome stays unit-tested
in `tests/unit/services/ar/gatewayFeeIdempotency.test.ts`.

## Tests
`tests/integration/r193-replay-waits-for-cancel.int.test.ts`, real webhook route and real cancel
service, sql-wrapper pattern (the hook matches the dedupe read by table and predicate and asserts it
fired):
1. A cancel holds the receipt (open transaction) when the replay reaches the read; the cancel commits
   only once the replay is SEEN waiting on a lock (`pg_stat_activity`). Asserts no fee journal, the
   receipt cancelled, `review:already_settled_cancelled_receipt`, and that the commit happened while
   the replay was blocked (not after its read returned).
2. The replay holds the receipt; a cancel started right after the read is seen waiting; the fee posts,
   the cancel then commits; no flag; no deadlock (both finish).
3. Another transaction holds the receipt for 9 s: the delivery fails in 4-8.5 s with 500 and no fee
   journal; the same body redelivered is processed and posts the fee.
The sequential case (cancel committed before the replay) stays in
`r187-cancelled-receipt-replay.int.test.ts` and `r187-non-gateway-cancelled.int.test.ts`.

## Evidence
- `red.int.log`: the 3 cases before the fix (all red: fee posted unflagged; cancel not blocked; 200
  instead of 500).
- `green.int.log`: 3/3.
- `mutations.log` (r193 + r187 replay suites) and `mutations.r1.log` (adds the re-pinned r185 suite):
  baseline green; M1 no lock red; M2 lock without re-read (a stale unlocked read, then a lock by id)
  red; M3 unbounded wait (no budget) red; baseline green.
- `regression.int.log`: every suite on the gateway, cancel and merge paths on `isaflow_schema_fixture`
  (22 files, 226 tests). `regression.d8.int.log`: the D8 lock-order suites that touch receipts, on the
  fixture's `isaflow_test` (they refuse any other DB name): 11 files, 177 tests.

## Residual
- The link-spend reorder is argued from the code, not race-tested (a merge vs first-report-behind-a-
  draft deadlock needs three parties). It does not change what is spent.
- A replay now holds the receipt lock across the fee post: a person cancelling that receipt in the
  same instant waits up to the cancel's own 5 s budget (then 503 + Retry-After on the receipts page).
