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

Hein chose to fix this in the wrappers (2026-09-30). The no-rethrow detail is to be confirmed
with Hein before merge.

- `src/lib/auth/deferredEnd.ts` holds the swap (`deferEnd`), which used to be copied into each
  wrapper, and `answerThrow`. On a throw, after the ROLLBACK, `answerThrow`:
  - logs the throw with the route, company and user, and reports it to Sentry with the same
    tags. The capture runs outside the wrapper's isolation scope, so the tags go with it;
  - puts the real `res.end` back;
  - if the headers were already sent, closes the response with what the handler buffered;
  - otherwise answers through `respondToUnhandledError`;
  - never rethrows.
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

- `tests/integration/r159-auth-wrapper-throw-responds.int.test.ts`, 34 cases. Each runs through
  the real wrappers as `app_user` with RLS and real credentials (cookie JWT, PAT, extension
  JWT), on a fixture clone. For each of `withAuth`, `withBearerOrCookieAuth`, `withBearerAuth`
  and `withExtensionToken`, a handler writes a customer row and then:
  - throws: the row is rolled back, nothing is rethrown, the answer is 500 with
    `withErrorHandler`'s body, the response's own `end` runs once, and the log line carries the
    company and user;
  - answers 200, then throws: the 200 is replaced by the 500;
  - flushes its headers, then throws: the response is closed once and the row is rolled back;
  - throws a lock timeout: the answer is 503;
  - fails at COMMIT (a deferred FK): 500 `COMMIT_FAILED`, or the buffered end after flushed
    headers. This behaviour is unchanged; the cases pin the renamed lines;
  - answers normally, including twice: 200, the row is committed, and the first body is sent
    once.

  `invitations/revoke/[id]` gets a throw forced after its DELETE: the invitation survives, the
  answer is 500, `end` runs once and nothing is rethrown. The hook is asserted to have fired. A
  GET still gets 405.
- `tests/unit/lib/auth/deferredEnd.test.ts`: the Sentry capture carries the company, route and
  user, and is gated on `SENTRY_ENABLED`; a refused Login-as session gets 403; in production the
  500 says only "An unexpected error occurred", with no details; a throw before the swap still
  gets one 500.
- `tests/unit/lib/auth/deferredEndCensus.test.ts` pins the contract on the tracked tree:
  - only `deferredEnd.ts` assigns `res.end`;
  - the callers of `deferEnd` are exactly the three wrappers;
  - in each, the `try` around `deferEnd` catches with `answerThrow` and has no `throw`.

Evidence:

- `red.int.log`: 17 of the 22 original cases fail on origin/master `7c49109f5`, because every
  throw is rethrown and `end` is never called. The positive paths and the 405 pass;
- `green.log`: the suites on the final head;
- `mutations.log`: 41 of 41 mutants are RED. Every changed line was mutated in `deferredEnd.ts`,
  the three wrappers (recording the deferral, the answer, the company and user, the replay, and
  both COMMIT-failure replays) and `api-error-handler.ts` (the delegation, the lock-timeout and
  impersonation branches, the error code and the production masking). The extension's
  `connectionId` in the log line is included too (M39–M41, review round 1).

## Review round 1

The general reviewer returned SHIP with three LOWs, all fixed:

- the module doc said a throw is never rethrown. A throw before the transaction, such as token
  validation or the pool `connect()`, still propagates. Nothing is buffered at that point, so
  it cannot hang. The doc now says so;
- no test proved the production masking on the paths that now reach it. A unit case was added,
  and mutant M39 is RED;
- the extension's throw log had lost the `connectionId`. `ThrowContext.extra` now carries it,
  the integration case asserts it, and M40 and M41 are RED.

## Migration / rollback

There is no migration. To roll back, revert the PR.
