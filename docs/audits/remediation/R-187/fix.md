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

## Fix

- The dedupe SELECT drops the status predicate, returns `status`, and orders a live receipt first
  (`ORDER BY (status IS NOT DISTINCT FROM 'cancelled'), id`). A live match runs the existing
  second-report path unchanged (missing fee, amount comparison, its own reasons).
- Only cancelled matches: bank nothing, post no fee, `flagSettlementForReview(...,
  ['already_settled_cancelled_receipt'], { cancelledPaymentId, invoiceId, reportedCents,
  reportedCurrency })`, return null. The flag is R-181's mechanism unchanged: `failure_reason =
  'review:<reasons>'`, merged with any earlier note, in its own savepoint, logged at error level.
- `spendPaymentLinkOfRequest` still runs first on every call; it is idempotent and the link was
  spent by the first settlement.

**Callers.** Both ignore the return value, so the result type is unchanged (null, as for a live
dedupe); nothing needs to tell the two apart. The webhook answers 200 (no redelivery loop). `verify`
answers `status: 'completed'`, `amountCents` = the request's amount, `appliedToInvoice: false` (its
receipt read already excludes cancelled receipts): the payer was charged and is never told
"failed" (R-181 rule); the response shape is unchanged.

**Lock order and concurrency.** No lock added or removed. The dedupe SELECT is still a plain read;
first settlements still serialise on the request row UPDATE (webhook and verify) and, last, on
`ux_customer_payments_card_reference`. No path now inserts a receipt when a cancelled one exists, so
the cancelled-only branch cannot race a live insert from the new code. A cancel committing while a
replay runs is seen or not seen by the replay's snapshot: not seen, it takes the live path (bank
nothing, fee only if missing; pre-existing, and cancel keeps the fee by design); seen, it flags.
R-181's documented order (request -> link -> payment -> invoice; dedupe: link -> fee journal ->
request row last) is unchanged; the cancelled branch takes only the request row (the note).

## Tests

- Unit (`tests/unit/services/ar/gatewayReceiptWiring.test.ts`, one case added; the mock now hides a
  cancelled row from a read that excludes cancelled, as Postgres does): a cancelled match makes no
  receipt INSERT, no allocation, no `postGatewayFee` call, returns null, flags
  `already_settled_cancelled_receipt`.
- Integration (`tests/integration/r187-cancelled-receipt-replay.int.test.ts`, real routes, real
  `cancelCustomerPayment`, fixture `isaflow-fixture-r187`):
  1. webhook settle, cancel, replay in another body with `fees`: company Bank/AR/expense and
     receipt/journal counts unchanged, no fee journal, request flagged.
  2. verify while the webhook settles and a person cancels (inside the stubbed Paystack call): the
     same, and verify answers `completed`, 11500, `appliedToInvoice: false`.
  3. a live receipt: a replay still dedupes (one receipt, the missing fee posted, Bank 111.50, no flag).
  4. a cancelled AND a live receipt (what the old dedupe left behind): the live one is the match
     (fee posted, no flag).

## Evidence

| Log | Result |
|---|---|
| `red.unit.log` | 1 failed / 18 at 1910c157b (a new receipt returned) |
| `red.int.log` | 2 failed / 4 at 1910c157b (Bank +111.50, AR -115.00 re-banked; verify `appliedToInvoice: true`) |
| `green.unit.log` | 18/18 |
| `green.int.log` | 4/4 |
| `mutations.log` | 7 mutants, 7 RED; baselines green before and after |
| `regression.unit.log` | 133/133 (9 gateway*/paystack* unit files) + 7/7 (2 component files) |
| `regression.int.log` | 205/205 over 21 files: r181-*, k-036, r167*, r178*, link-revoke*, k095*, k096*, r187 |

Mutants: M1 restore `IS DISTINCT FROM 'cancelled'`; M2 drop the flag; M3 post the fee on the
cancelled path; M4 drop the live-first ORDER BY (integration case 4 only); M5 invert it; M6 the
cancelled branch never taken; M7 a different flag reason. M5's unit red is an artefact of the
mock's text match; its integration red is the real kill.

## Recorded, not changed

- `ux_customer_payments_card_reference` still excludes cancelled rows (decision). A writer other
  than this service could still insert a second live card receipt for a cancelled reference.
- The census in the register (references with both a cancelled and a live receipt) was not run;
  existing double-banked references, if any, need a person.
- The flag has no UI (R-181); the `log.error` line and `failure_reason` surface it.
- The dedupe read does not filter `payment_method = 'card'`, as before: a cancelled non-card receipt
  carrying a Paystack reference as its `bank_reference` would now also block. Paystack references
  are generated per checkout, so this is not expected.
