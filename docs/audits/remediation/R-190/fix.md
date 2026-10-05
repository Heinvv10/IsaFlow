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
transaction, so the rollback must undo the payment request, the mandate activation and the stamp
(the two rows the test reads; other tables are not checked).
The match is on the table name, not the SQL text. Every case that relies on the hook asserts it
fired, which catches a renamed or removed statement but not the hook firing at the wrong
statement (corrected in round 1 below). The hook disarms when it
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
The failure is injected at the stamp, after all handler writes. Round 1 below adds a throw from
inside `processEvent`; the round-0 claim that it "follows the same route code path" was not tested
and missed the swallow regression. If the stamp stops being an `UPDATE paystack_webhook_events` inside the transaction, the
"hook fired" assertions fail and the test must be re-pointed.

## Review round 1

Blind review of b5bb29638 returned FIX. The findings and what changed (test only, commit 5bc3cf14a):

- **[M] No failure came from inside `processEvent`.** A regression that swallowed handler errors
  (`try { await processEvent(...) } catch { log }`) would stamp a failed event processed and answer
  200, and no case caught it. Added a case (now 6th; the duplicate-ack case moves to 7th), "treats a throw from inside processEvent as a failure,
  then processes the redelivery". The hook is armed on the first `UPDATE paystack_payment_requests`
  (the handler's first write). The case asserts 500, `processed = false`, `processing_error` set,
  the request and mandate still `pending`, and then a successful redelivery. The swallow mutant (M8)
  turns it red.
- **[M] The hook matched any `UPDATE paystack_webhook_events`, not the stamp.** The stamp matcher
  now also requires `SET processed = TRUE`. Before throwing, the hook reads the request and mandate
  status through the same in-transaction `sql`. Cases 4 and 5 assert they were `completed` / `active`
  before the rollback, so a hook that fires before the handler writes turns them red (M10) instead of
  passing vacuously. The duplicate-ack case now arms the handler hook, which must not fire.
- **[L] fix.md overstated the guarantee.** Corrected above. The rollback proof covers the payment
  request, the mandate and the event row, not "every write". Asserting that the hook fired proves it
  fired, not where it fired. The in-transaction reads added in this round prove where.

The file now has 7 cases.

### Logs
- `green.r1.int.log` (5bc3cf14a): 7/7 passed.
- `mutations.r1.log`: baseline 7/7 before and after. Each mutant was reverted with `git diff` empty.

| Mutant | Change | Result |
|---|---|---|
| M1 | ack any existing event row as duplicate | 6 failed |
| M2 | original K-035: ack when the insert hits the existing row | 3 failed |
| M3 | `withPublicRouteTransaction` COMMITs instead of rolling back | 6 failed |
| M4 | drop the `processing_error` write | 2 failed |
| M5 | route's catch answers 200 | 4 failed |
| M6 | ignore `processed` (never ack a duplicate) | 1 failed (duplicate-ack case) |
| M7 | `processEvent` before the transaction | 4 failed |
| M8 | swallow `processEvent` errors inside the transaction (new) | 1 failed (handler-throw case) |
| M9 | extra in-transaction `UPDATE paystack_webhook_events` before `processEvent` (new; a benign change, so a control) | 7 passed; the hook still fires at the stamp |
| M10 | stamp moved before `processEvent` (new) | 2 failed (cases 4, 5: hook saw request `pending`) |

  Control: M9 run against the round-0 test (9063b0362, bare table matcher) passed 6/6. That is the
  vacuous pass the reviewer predicted: its hook threw before any handler write.
- `regression.r1.int.log`: the same 15 webhook-route suites, 198/198 passed.

### Residual risk
The handler-throw case injects at the request's completion UPDATE only. A throw later in the
handler (for example inside the mandate activation savepoint) takes the same route path. It is not
exercised separately.
