# R-187 — a cancelled gateway receipt blocks re-banking

## Defect

`recordGatewayInvoiceReceipt` (`src/modules/accounting/services/ar/gatewayInvoiceReceiptService.ts`)
deduped on `customer_payments (company_id, bank_reference)` with `status IS DISTINCT FROM
'cancelled'`, and `ux_customer_payments_card_reference` excludes cancelled rows too. After a person
cancelled a Paystack receipt, a `charge.success` for the same reference in a different body (the
webhook's already-completed branch, or `verify` on a stale `pending` read) found nothing and banked
a second receipt: AR credited and Bank debited twice for one card payment, plus the fee leg.

## Decision (Hein, 2026-10-03)

`.claude/handoffs/2026-10-03-r183-r187-pool-budget-goal.md` §2.2 and §5: dedupe on any receipt for
the reference, cancelled included. A replay banks nothing and flags the request for review. Code
only; `ux_customer_payments_card_reference` stays as is (no migration).

**Narrowed in review round 1 (orchestrator, for Hein to confirm):** "any receipt" became "any
GATEWAY-WRITTEN receipt". A cancelled receipt someone else wrote with the Paystack reference (a
manual receipt, a bank-feed allocation) no longer blocks; see Review round 1.

## Fix

- The dedupe read is `gatewaySettledReceipt.findSettledReceipt`: a live receipt for (company,
  reference), whoever wrote it, else a cancelled one whose journal carries the gateway's stamp
  (`LEFT JOIN gl_journal_entries je ... AND (cp.status IS DISTINCT FROM 'cancelled' OR
  je.posting_agent = GATEWAY_RECEIPT_AGENT)`), live first (`ORDER BY (cp.status IS NOT DISTINCT FROM
  'cancelled'), cp.id`). A live match runs the existing second-report path unchanged (missing fee,
  amount comparison, its own reasons).
- Only a cancelled gateway receipt matches: bank nothing, post no fee, `flagSettlementForReview(...,
  ['already_settled_cancelled_receipt'], { cancelledPaymentId, invoiceId, reportedCents,
  reportedCurrency, feeRand, reportedFeeCents })`, return null. The flag is R-181's mechanism
  unchanged: `failure_reason = 'review:<reasons>'`, merged with any earlier note, in its own
  savepoint, logged at error level. The reason is truthful as worded: the gateway's settlement
  receipt exists and was cancelled.
- `spendPaymentLinkOfRequest` still runs first on every call; it is idempotent and the link was
  spent by the first settlement.

**The gateway marker.** `customer_payments.gl_journal_entry_id` -> `gl_journal_entries.posting_agent
= 'system:paystack-receipt:v1'`. Chosen because it is the only durable one and it survives a cancel:
- every gateway receipt has been confirmed with that stamp since the service was written
  (3f1ef0a8d, 2026-09-09), in the same transaction as the INSERT;
- `cancelCustomerPayment` sets only `status` and appends to `description`; it reverses the journal
  with a NEW entry and leaves the original row, its `posting_agent` and the receipt's link intact;
- no code path clears `customer_payments.gl_journal_entry_id` or rewrites `posting_agent` (grep), and
  the FK (`customer_payments_gl_journal_entry_id_fkey`, NO ACTION) stops the journal being deleted;
- a manual receipt's journal is stamped `human:<id>`, a bank allocation's
  `system:bank-allocation:v1` (or its caller's agent); `GATEWAY_RECEIPT_AGENT` is used only by the
  gateway services (grep); the fee journal shares it but is never a receipt's `gl_journal_entry_id`.
Rejected: `description` (free text a person can type, and cancel appends to it), `payment_method`
(a manual receipt may be `card`), `created_by` (a member, not a marker). The brief pointed at
"migration 841_gateway_receipt_principal": no such migration exists in this repo (the latest prefixes
are 719 and 850-851) or in the fixture's `schema_migrations`.

**Callers.** Both ignore the return value, so the result type is unchanged (null, as for a live
dedupe); nothing needs to tell the two apart. The webhook answers 200 (no redelivery loop). `verify`
answers `status: 'completed'`, `amountCents` = the request's amount, `appliedToInvoice: false` (its
receipt read already excludes cancelled receipts): the payer was charged and is never told
"failed" (R-181 rule); the response shape is unchanged.

**Lock order and concurrency.** No lock added or removed; the join reads the journal without a lock.
The dedupe SELECT is still a plain read; first settlements still serialise on the request row UPDATE
(webhook and verify) and, last, on `ux_customer_payments_card_reference`. No path inserts a receipt
when a cancelled gateway receipt exists, so that branch cannot race a live insert. A cancel committing
while a replay runs is seen or not seen by the replay's snapshot: not seen, it takes the live path
(bank nothing, fee only if missing; pre-existing, and cancel keeps the fee by design); seen, it flags.
R-181's documented order (request -> link -> payment -> invoice; dedupe: link -> fee journal ->
request row last) is unchanged; the cancelled branch takes only the request row (the note).

## Review round 1 (0b6fbc95b: general SHIP 3 LOW, adversarial FIX 2 MEDIUM 1 LOW)

1. **M — any cancelled row blocked, including ones the gateway never wrote.** A person who recorded
   the Paystack payment by hand with the reference (or a bank-feed allocation whose line carried
   it), then cancelled it, made the FIRST `charge.success` bank nothing: the request stayed
   `completed` with no receipt for ever (verify skips completed requests). Fixed with the marker above.
2. **M — first-settlement cases.** Added (`r187-non-gateway-cancelled.int.test.ts`): a cancelled
   manual CARD receipt then the webhook (guarded UPDATE matched), a cancelled manual EFT receipt then
   verify (moves the request), a cancelled bank-feed allocation (real `allocateTransaction`, line
   reference = the Paystack reference) then the webhook: each banks as usual, no flag. Red on
   0b6fbc95b (`red.r1.int.log`, 3/7). Plus a pin that a LIVE receipt with no journal (a draft manual
   receipt) still dedupes as before (pre-existing behaviour, kept exactly; it is what pins the LEFT JOIN).
3. **L — the note-failure log said "the receipt stands"** on a path that banked nothing. Now "the
   settlement is not rolled back"; the JSDoc says the same.
4. **L — the cancelled-path log** now carries `feeRand` and `reportedFeeCents` (unit-asserted).
5. **L — regression logs name their files** (`regression.r1.*.log`, verbose reporter). k-035 is
   recorded baseline-vs-branch in `k035.r1.int.log`: 4 failed / 2 passed with master's source for the
   two changed services and 4/2 on the branch, the same four tests with the same assertions
   (`expected 200 to be 500` x3, `expected 'completed' to be 'pending'`). Pre-existing, not R-187.
6. **L — fixCommit** left null for the orchestrator.

## Review round 2 (a2e9cf93a: both reviewers SHIP, LOW only)

1. The cancelled-and-live case now gives the live row an id starting `ffffffff-ffff-4fff-bfff-`
   (random tail), so `ORDER BY cp.id` alone would pick the cancelled row; M13 (drop only the status
   key) is RED.
2. The replay test's header describes the round-1 rule.
3. **A cancelled gateway receipt is not always a deliberate decision.** Besides
   `cancelCustomerPayment`, it is cancelled as a side effect when the bank line matched to its journal
   is reversed (`reverseReconciledTransaction`, and the auto-post undo, both through
   `unwindBankAllocationApplication` -> `unwindOnePayment`), and by an agent through MCP
   `void_receipt` (`paymentVoidService` -> `unwindOnePayment`). Whoever handles
   `already_settled_cancelled_receipt` should check which it was. Said in the service, in
   `gatewaySettledReceipt.ts` and in `ar/.claude.md`. New case: a bank line matched to the gateway
   receipt's bank leg, reversed with `reverseReconciledTransaction` (one payment cancelled), then a
   replay: nothing banked, flagged.
4. The draft-receipt case no longer asserts `review: null` and says it is a known pre-existing gap,
   registered as **R-189** (a live draft receipt with the reference makes the gateway bank nothing,
   unflagged; a fee leg can post against the draft's bank account).
5. The stale k-035 test is registered as **R-190**.

`mutations.r2.log` (at 4d3362b96): 13 mutants, 12 RED, M12 equivalent (as round 1); baselines
unit 19/19, int 9/9 before and after.
`regression.r2.int.log` (at 4d3362b96): 210/210 over 22 listed files.

## Tests

- Unit (`tests/unit/services/ar/gatewayReceiptWiring.test.ts`, two cases added; the mock models the
  read: a cancelled row is visible only to a read that admits cancelled rows, and only when it is
  `gateway` if the read asks for the gateway agent): a cancelled gateway match makes no receipt
  INSERT, no allocation, no `postGatewayFee` call, returns null, flags
  `already_settled_cancelled_receipt` with the fee figures; a cancelled non-gateway match banks.
- Integration, real routes, real `cancelCustomerPayment`, fixture `isaflow-fixture-r187`:
  - `r187-cancelled-receipt-replay.int.test.ts`: (1) webhook settle, cancel, replay in another body
    with `fees`: company Bank/AR/expense and receipt/journal counts unchanged, no fee journal, request
    flagged; (2) verify while the webhook settles and a person cancels: the same, verify answers
    `completed`, 11500, `appliedToInvoice: false`; (3) a live receipt: a replay still dedupes (fee
    posted, Bank 111.50, no flag); (4) a cancelled AND a live receipt: the live one is the match.
  - `r187-non-gateway-cancelled.int.test.ts`: the four round-1 cases above.

## Evidence

| Log | Result |
|---|---|
| `red.unit.log` / `red.int.log` | round 0 at 1910c157b: 1/18 and 2/4 failed (re-banked: Bank +111.50, AR -115.00) |
| `green.unit.log` / `green.int.log` | round 0 at 6a4ab4933: 18/18, 4/4 |
| `mutations.log` | round 0: 7 mutants, 7 RED |
| `regression.unit.log` / `regression.int.log` | round 0: 133/133 + 7/7; 205/205 over 21 files (file list not printed; superseded by r1) |
| `red.r1.unit.log` / `red.r1.int.log` | round 1 at 0b6fbc95b: 1/19 and 3/7 failed (nothing banked after a cancelled manual/bank-feed receipt) |
| `green.r1.unit.log` / `green.r1.int.log` | round 1 at 8d9c055b9: 19/19, 8/8 |
| `mutations.r1.log` | 12 mutants: 11 RED, 1 equivalent (M12); baselines green before and after |
| `regression.r1.unit.log` | 134/134 over 9 unit files + 7/7 over 2 component files, each listed |
| `regression.r1.int.log` | 209/209 over 22 files, each listed: r181-*, k-036, r167*, r178*, link-revoke*, k095*, k096*, r187-* |
| `k035.r1.int.log` | k-035: 4 failed / 2 passed on master source and on the branch, identical failures |

Round-1 mutants: M1 restore `status IS DISTINCT FROM 'cancelled'`; M2 drop the flag; M3 post the
fee on the cancelled path; M4 drop the live-first ORDER BY; M5 invert it; M6 the cancelled branch
never taken; M7 a different flag reason; M8 any cancelled receipt blocks (round 0); M9 any journal
counts as the gateway's; M10 the fee figures dropped from the log detail; M11 INNER JOIN; M12 the
join's `je.company_id = cp.company_id` dropped: equivalent (the journal id is a random UUID primary
key and the FK names exactly one journal; the predicate is a tenant guard against a cross-tenant link
no writer creates, the same class as R-181's equivalent company_id mutant).

## Recorded, not changed

- `ux_customer_payments_card_reference` still excludes cancelled rows (decision). A writer other
  than this service could still insert a second live card receipt for a cancelled reference.
- The census in the register (references with both a cancelled and a live receipt) was not run;
  existing double-banked references, if any, need a person.
- The flag has no UI (R-181); the `log.error` line and `failure_reason` surface it.
- Pre-existing, kept exactly: a LIVE receipt of any kind with the reference (even a draft manual
  one) is taken as the settlement, so the gateway banks nothing. A known gap, registered as R-189.
- A gateway receipt whose journal was later deleted cannot exist (FK); one never confirmed cannot be
  committed (the INSERT and the confirm share the settlement transaction).
