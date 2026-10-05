# R-190 — K-035 redelivery test was stale

## Claim
Verified. On clean master (470df5599) `tests/integration/k-035-webhook-redelivery-discarded.int.test.ts`
failed 4 of 6: `expected 200 to be 500` three times and `expected 'completed' to be 'pending'` once
(`red.int.log`).

## Root cause
The test made processing fail with two mandates for one company, so the `charge.success`
authorisation branch tripped `ux_sub_mandates_company_active`. `paystackMandateActivation.ts` now
absorbs that 23505 inside a savepoint and records it as a settled outcome
(`noteAuthorisationNotAttached`, 200). The fixture no longer fails, so the test's premise was gone.
The production redelivery handling itself is intact; no production code changed.

## Fix (test only)
The test now forces the failure with the sql-wrapper hook pattern (as in
`r129-po-delete-status-guard.int.test.ts`). `@/lib/neon`'s `sql` runs every statement on the real
database; while the hook is armed, it throws straight after the first `UPDATE paystack_webhook_events`
of a delivery. That statement is the `processed = TRUE` stamp, the last write inside the
transaction, so the rollback must undo the payment request, the mandate activation and the stamp.
The match is on the table name, not the SQL text. Every case that relies on the hook asserts it
fired, so a renamed statement makes the test fail instead of pass vacuously. The hook disarms when it
fires and each case arms it for one delivery, so it never hits the outer `processing_error` UPDATE
(the second `UPDATE paystack_webhook_events` in a failed delivery).

The fixture is now one pending mandate linked through `paystack_payment_requests.mandate_id`, so
the uninjected path is a clean `activated`.

All six cases are kept:
1. A failed delivery answers 500; the event row stays `processed = false` with `processing_error` set.
2. A redelivery while the cause persists is processed again (500), not acked `{duplicate:true}`.
3. Once the cause clears, the redelivery answers 200 `{ok:true}`; the row is processed, the request
   completed and the mandate active with the new code.
4. A failed delivery leaves the payment request `pending`.
5. A failed delivery leaves the mandate `pending` with no authorisation code.
6. A redelivery of a successfully processed event is acked `{duplicate:true}` without reprocessing
   (the hook is armed and must not fire), and there is one event row.

## Tests
- `red.int.log`: the old test at master 470df5599, 4 failed / 2 passed.
- `green.int.log`: the rewrite at 9063b0362, 6/6 passed. Its `dirty=1` is the log file itself.
- `regression.int.log`: the 15 other suites that drive the webhook route (directly, or through
  `r181-settlement.helpers` / `r167-portal-links.helpers`): 15 files, 198/198 passed.
  The logged errors in it are expected-failure paths inside passing tests.

## Mutants (`mutations.log`; baseline 6/6 before and after, each reverted with `git diff` empty)
| Mutant | Change | Result |
|---|---|---|
| M1 | `if (locked[0]) return true` — ack any existing event row as duplicate | 5 failed (1–5) |
| M2 | original K-035: ack `{duplicate:true}` when the insert hits the existing row | 2 failed (2, 3) |
| M3 | `withPublicRouteTransaction` COMMITs instead of rolling back on a throw | 5 failed (1–5) |
| M4 | drop the `processing_error` write in the route's catch | 1 failed (1) |
| M5 | route's catch answers 200 instead of 500 | 3 failed (1–3) |
| M6 | ignore `processed` (never ack a duplicate) | 1 failed (6) |
| M7 | run `processEvent` before the transaction (auto-commit writes) | 2 failed (4, 5) |

Every case is caught by at least one mutant.

## Residual risk
The failure is injected at the stamp, after all handler writes. A real throw from inside
`processEvent` follows the same route code path (same `try`, same transaction), but is not exercised
here. If the stamp stops being an `UPDATE paystack_webhook_events` inside the transaction, the
"hook fired" assertions fail and the test must be re-pointed.
