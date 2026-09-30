# R-159 — the auth wrappers answer a handler throw instead of rethrowing into their own buffer

## Defect

`withAuth`, the Bearer pipeline (`runBearerRequest`, behind `withBearerOrCookieAuth` and
`withBearerAuth`) and `withExtensionToken` swap `res.end` for a buffer, so the response flushes
only after COMMIT or ROLLBACK. When the handler returned, they replayed the buffer. When it threw,
they rolled back and rethrew with the buffer still in place. Any 500 sent after that, by an outer
`withErrorHandler` or by Next itself, went into the buffer and was never sent. The client hung
until its socket timed out. The write was rolled back, so no data was harmed.

## Census

An AST pass over every `pages/api` route that calls one of the four wrappers found:

- 640 routes put `withErrorHandler` inside the wrapper. A throw in the handler is caught there,
  so these routes only reached the bug on a throw from the wrapper itself (after the swap) or
  from a guard composed between the wrapper and `withErrorHandler`;
- `pages/api/invitations/revoke/[id].ts` is `withAuth(withCsrf(handler))`, with no
  `withErrorHandler`. It hung on every throw;
- `pages/api/accounting/capture/upload.ts` has an outer `withErrorHandler` and an inner one
  around `withAuth`;
- no route relies on the rethrow. The one other outer wrapper, `withRenderSlot`, catches only
  its own capacity errors, which are raised before `withAuth` runs.

Two unit suites pinned the rethrow (`withAuth-commit-order`, `withBearerOrCookieAuth.edges`),
as did `withExtensionTokenFinalize` and the `withExtensionToken` owner in `afterCommitTxOwners`.
They now expect the 500 answer.

## Fix

Hein chose to fix this in the wrappers (2026-09-30), and confirmed the no-rethrow design the
same day.

- `src/lib/auth/deferredEnd.ts` holds the swap (`deferEnd`), which used to be copied into each
  wrapper, plus `answerThrow`, `replayEnd` and `abortResponse`. On a throw, after the ROLLBACK,
  `answerThrow`:
  - puts the real `res.end` back first;
  - logs the throw with the route, company, user, message and stack, and reports it to Sentry
    with the same tags. The capture runs outside the wrapper's isolation scope, so the tags go
    with it. An error whose message cannot be read, or a Sentry capture that throws, cannot stop
    the answer;
  - if the headers were already sent, aborts the response (`res.destroy()`). Closing it would
    hand the client a complete-looking 2xx for a write that was rolled back;
  - otherwise answers through `respondToUnhandledError`, with a fixed 500 body if that throws;
  - never rethrows.
- `replayEnd` sends the buffered `end` once the transaction is final, and never throws. If the
  real `end` refuses the buffered body (Node rejects `end({ id })`), it logs and aborts. Without
  it, that throw reached the wrapper's catch after COMMIT, which rolled back a committed
  transaction, told the client 500 (inviting a duplicate retry) and skipped the after-commit
  work (review round 2).
- A failed COMMIT after the headers were flushed now aborts the response too, instead of
  replaying the buffered end.
- `withErrorHandler`, when a handler throws after flushing its headers, cannot send a 500. It
  now sets `statusCode = 500` anyway, so an enclosing wrapper rolls back instead of COMMITting,
  and aborts the response it could no longer end. It does this only while the response has not
  ended (`!res.writableEnded`, always true under the three wrappers, whose `end` is buffered).
  A response the handler already ended through the real `end`, on a route outside them, is left
  alone: destroying it could cut a large body off mid-flush (review round 3). Before, the wrapper committed the partial
  write and the response hung. This was the case on the 640 routes with `withErrorHandler`
  inside, though no such route flushes before it ends today (review round 2).
- `respondToUnhandledError` is `withErrorHandler`'s response code, moved unchanged into an
  exported function that `withErrorHandler` now calls. A throw that escapes a wrapper gets the
  same answer `withErrorHandler` gives: 503 for a lock timeout, 403 for a refused Login-as
  session, otherwise 500 `INTERNAL_SERVER_ERROR` with the message masked in production.
- A throw before the swap is answered the same way. That covers `SET ROLE`, the rate limiter,
  and the Bearer membership lookup's non-22P02 errors. Those used to reach Next's plain-text
  500.
- The pool `connect()` is still outside the `try`, so a pool failure is rethrown as before
  (`withAuthPrintToken` pins it). No response has been swapped at that point.
- `withExtensionToken` no longer logs its own `handler error` line, because `answerThrow`
  logs the throw. It passes the `connectionId` to `answerThrow`, so the log line still has it.

## Tests

- `tests/integration/r159-auth-wrapper-throw-responds.int.test.ts`, 44 cases (11 per wrapper). Each runs through
  the real wrappers as `app_user` with RLS and real credentials (cookie JWT, PAT, extension
  JWT), on a fixture clone. For each of `withAuth`, `withBearerOrCookieAuth`, `withBearerAuth`
  and `withExtensionToken`, a handler writes a customer row and then:
  - throws: the row is rolled back, nothing is rethrown, the answer is 500 with
    `withErrorHandler`'s body, the response's own `end` runs once, and the log line carries the
    company and user;
  - answers 200, then throws: the 200 is replaced by the 500;
  - flushes its headers, then throws: the row is rolled back and the response aborted, not
    ended;
  - the same with `withErrorHandler` inside the wrapper: rolled back, not committed, and aborted;
  - responds with a body Node's `end` refuses (`res.status(201).end({ id: 1 })`): the row stays
    committed, the response is aborted, no rollback is logged, the replay-failure log carries
    the tenant, and the after-commit work runs;
  - throws a lock timeout: the answer is 503;
  - fails at COMMIT (a deferred FK): 500 `COMMIT_FAILED`, or an aborted response after flushed
    headers;
  - answers normally, including twice: 200, the row is committed, and the first body is sent
    once; never answers: the row is committed and nothing is replayed.

  The test response is a stand-in that behaves like Node's: `setHeader` after the headers are
  sent throws, and `end` refuses a body that is not a string or Buffer
  (`r159-auth-wrapper.helpers.ts`).

  `tests/integration/r159-invitation-revoke-throw-responds.int.test.ts`: `invitations/revoke/[id]` gets a throw forced after its DELETE: the invitation survives, the
  answer is 500, `end` runs once and nothing is rethrown. The hook is asserted to have fired. A
  GET still gets 405.
- `tests/unit/lib/auth/deferredEnd.test.ts`: the Sentry capture carries the company, route and
  user, and is gated on `SENTRY_ENABLED`; a refused Login-as session gets 403; in production the
  500 says only "An unexpected error occurred", with no details; an error whose message getter
  throws, a thrown value that cannot be printed, and a Sentry capture that throws are each
  still answered with one 500; a throw before the swap still gets one 500.
- `tests/unit/lib/apiErrorHandlerShareToken.test.ts`: `withErrorHandler`'s headers-already-sent
  branch now also sets 500 and aborts.
- `tests/unit/lib/auth/deferredEndCensus.test.ts` pins the contract on the tracked tree:
  - only `deferredEnd.ts` assigns `res.end`;
  - the callers of `deferEnd` are exactly the three wrappers;
  - in each, the `try` around `deferEnd` catches with `answerThrow` and has no `throw`.

Evidence:

- `red.int.log`: 17 of the 22 original cases fail on origin/master `7c49109f5`, because every
  throw is rethrown and `end` is never called. The positive paths and the 405 pass;
- `green.log`: the suites on the final head;
- `mutations.log`: 64 of 64 mutants are RED. M55–M57 were re-run on the round-3 guard; the /review round re-ran every mutant whose line changed and added M58–M63. Every changed line was
  mutated in `deferredEnd.ts` (the buffer, the restore, the abort, the answer and its fallback,
  the log and stack, Sentry and its guard, and `replayEnd`), in each of the three wrappers (the
  deferral, the answer and its tenant, the guarded replay and its tenant, and both COMMIT-failure
  paths), and in `api-error-handler.ts` (the delegation, the lock-timeout and impersonation
  branches, the error code, the production masking, and the flushed-failure mark and abort).
  Rounds 0–1 (M1–M41) are kept below it.

## Review round 1

The general reviewer returned SHIP with three LOWs, all fixed:

- the module doc said a throw is never rethrown. A throw before the transaction, such as token
  validation or the pool `connect()`, still propagates. Nothing is buffered at that point, so
  it cannot hang. The doc now says so;
- no test proved the production masking on the paths that now reach it. A unit case was added,
  and mutant M39 is RED;
- the extension's throw log had lost the `connectionId`. `ThrowContext.extra` now carries it,
  the integration case asserts it, and M40 and M41 are RED.

## Review round 2 (adversarial)

The adversarial reviewer returned FIX with 2 MEDIUM and 4 LOW findings, all latent: no route
does any of these today. Each one was proved with a probe, and all are fixed:

- **MEDIUM:** a replay that throws after COMMIT reached the catch. Fixed with `replayEnd`
  (above).
- **MEDIUM:** a handler under `withErrorHandler` that throws after flushing its headers was
  committed and left hanging. Fixed in `withErrorHandler` (above). The module doc's caller
  contract now says so.
- **LOW:** a throw after flushed headers closed the response as a complete 2xx. It is now
  aborted, and so is a failed COMMIT after flushed headers.
- **LOW:** `answerThrow` logged before it restored the real end, and an unreadable error could
  make it rethrow. The real end is now restored first, and the error is read defensively.
- **LOW:** the throw log had no stack, now that Next no longer prints one. It is added.
- **LOW:** the module doc contradicted the census about adding a wrapper, and did not list the
  other transaction owners. Both are corrected.

The integration suite was split to stay under 300 lines: the revoke cases and the `sql` hook
have their own file, and the test response is in a shared helper.

## Review round 3

Both reviewers confirmed every round-1 and round-2 finding fixed, and both raised the same new
one (MEDIUM from the general reviewer, LOW from the adversarial one): `withErrorHandler`'s
headers-already-sent branch destroyed a response that had already ended, which on a route
outside the wrappers can truncate a large body and logs 500 for a 200. It is now guarded by
`!res.writableEnded`, with a unit case (ended response: no destroy, status unchanged) and
mutant M57. The integration test response now tracks `writableEnded` as Node's does.

Residual, accepted (adversarial reviewer): if `replayEnd` fails after COMMIT, the client sees a
reset connection for a write that did commit, and may retry. It no longer rolls back or reports
a failure, and only a handler bug (`end` given a body that is not a string or Buffer) can cause
it; no route does that today.

## /review (fresh blind Opus agent)

APPROVED with six LOWs. Posted to the PR; all six are fixed:

- the register note was stale (the confirmation, the mutant count, round 3). It is updated;
- the throw log said "handler threw, transaction rolled back", but the wrapper's own steps
  (BEGIN, the rate limiter) reach it too, and a failed ROLLBACK was swallowed. It now says
  "request threw inside its transaction" and logs `rolledBack`, which each wrapper records from
  its ROLLBACK instead of an empty catch (M58–M61);
- `answerThrow` aborted a response with its headers sent even if it had already ended. It now
  leaves an ended response alone, as `withErrorHandler` does (M62, with unit cases for both);
- the census flagged any `x.end =` assignment. That is kept: a receiver-name filter, tried
  first, missed `apiRes.end =` (re-confirmation LOW). The census still fails closed, and a
  non-response `end` goes in its `NOT_A_RESPONSE` list with a reason; the list is empty today.
  Its failure message now says so. M63 breaks the matcher, M64 plants an `apiRes.end =` swap in
  a tracked file, and both are RED;
- no integration case covered a throw from the wrapper's own step before the swap. A case now
  makes the rate limiter throw under withAuth and both Bearer wrappers: 500 once and nothing
  rethrown. It also asserts that the limiter's hook fired; the earlier no-row assertion could
  not fail, because the handler never runs. `withExtensionToken` has no step there that a test can make throw;
- the module doc's caller contract now states the `writableEnded` condition.

## Migration / rollback

There is no migration. To roll back, revert the PR.
