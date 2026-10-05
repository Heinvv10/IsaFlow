# R-189 — a live DRAFT receipt carrying the Paystack reference

## Claim, verified
`gatewaySettledReceipt.findSettledReceipt` took any live receipt for (company, reference) as the
settlement, a draft included. A draft manual receipt with the Paystack reference therefore sent the
first `charge.success` down the second-report path: no receipt banked, nothing allocated, no review
reason, and `postGatewayFee` posted the fee leg (DR admin_expense / CR Bank) against the draft's bank
account. Reproduced on the fixture at origin/master (`red.int.log`, `red.r1.int.log`): Bank moved by
-R3.50 per delivery behind a draft, and the request carried no flag. `verify` also answered
`appliedToInvoice: true` from the draft's own allocation, though the invoice was not paid.

## Decision (Hein, 2026-10-05)
On a report that finds only a draft: bank nothing, post NO fee, flag the request
`draft_receipt_holds_reference` for a person, return as the cancelled case does. Do not auto-confirm
or auto-cancel the draft.

## Fix
- `gatewaySettledReceipt.ts`: `isSettlement(status)` = confirmed or reconciled. The read ranks a
  confirmed/reconciled receipt first, then any other live one (a draft), then a cancelled
  gateway-written one. Before, the order was "not cancelled, then id", so a draft could outrank a
  confirmed receipt for the same reference.
- `gatewayInvoiceReceiptService.ts`: after the R-187 cancelled branch, a match that is live but not a
  settlement flags `draft_receipt_holds_reference` (with the draft's id and status, and the fee this
  report carried, so a person can see what was not posted) and returns null. No fee, no receipt, no
  allocation; the draft is not touched.
- `verify.ts`: the "what was banked" read counts only a confirmed or reconciled receipt. Behind a
  draft verify answers `completed`, the request amount, `appliedToInvoice: false`.
- `ar/.claude.md`: the reason list, verify's answer, and an R-189 entry.

## Tests
- `tests/integration/r189-draft-receipt-holds-reference.int.test.ts` (real webhook and verify routes,
  real manual-receipt service, fixture `isaflow-fixture-r19x`), 6 cases:
  webhook behind a draft EFT receipt and behind a draft CARD receipt; verify behind a draft; a later
  charge.success in another body (already-completed branch); a draft AND a confirmed receipt (the
  draft has the lower id, so an id-only order would pick it); a control with no draft. Each draft case
  asserts no new receipt, no fee journal, the whole of company A's books unchanged, the flag, and the
  draft unchanged (status, no journal, its allocation).
- `tests/integration/r187-non-gateway-cancelled.int.test.ts`: the pin "a LIVE receipt with no journal
  still dedupes" now asserts the R-189 flag (it still pins the LEFT JOIN: the draft is matched).
- `tests/unit/services/ar/gatewayReceiptWiring.test.ts`: a draft banks nothing, posts no fee, flags;
  a confirmed match still posts the fee. The existing dedupe cases now say `status: 'confirmed'`
  (the real read always returns a status; they had none).

## Evidence
- `red.int.log`: the first 5 cases, before the fix (4 red, the control green).
- `red.r1.int.log`: the final 6 cases against origin/master's three production files (4 red; the
  ranking case and the control pass there, as expected: the ranking only matters once drafts branch).
- `green.int.log`: 6/6. `regression.int.log`: every integration suite on the gateway path (19 files,
  214 tests) except k-035 (stale on master, R-190).
- `mutations.log`: baseline green, then M1 draft treated as live (5 red), M2 fee still posted (4 red),
  M3 flag missing (5 red), M4 id-only order (1 red), M5 verify counts a draft as banked (1 red),
  baseline green again. `mutations.r0.log` is the first run, before the verify case carried its fee
  as `feesCents` (M2 caught 3 there).

## Residual
- No UI shows any review flag (Hein's earlier decision); the flag is `failure_reason` plus `log.error`.
- Census for existing cases (read-only, in the register entry): completed requests with a draft
  receipt and no confirmed one. Not run here.
- The dedupe read is still unlocked: R-193.
