# R-176 — a transaction owner whose ROLLBACK fails destroys the connection instead of pooling it

## Defect

(a) Most transaction owners released their client with a bare `client.release()` on every path.
pg-pool evicts a client on a bare release only when its socket is already dead. A live
connection whose ROLLBACK never reached the server went back to the pool inside its open (or
aborted) transaction. The next user of that pool got it. Its `BEGIN` was a no-op with a
warning, and its `COMMIT` landed the failed work.

Proved on unchanged code (`red.int.log`):

- `withAuth`, the Bearer pipeline, `withExtensionToken`, `withInviteToken`, `withPlatformAdmin`,
  `withTransaction`: a request writes a row and fails, its ROLLBACK is refused, the backend is
  left `idle in transaction`, and the next request's COMMIT commits the row
  (`expected 1 to be +0`).
- `sql.transaction`: after a failed statement the pooled connection is in an aborted
  transaction, and the next batch fails.
- Invite accept: an invitee who was answered 500 gets the membership anyway, committed by the
  next invitee's accept. After `EMAIL_IN_USE` the next invitee is answered 500.
- Portfolio workbench: the next platform-admin write runs inside the leftover READ ONLY
  transaction and is refused.

Reach today: low. No pool sets a client-side `query_timeout`, and a dropped socket is evicted
by pg-pool itself. The defect needs a ROLLBACK that fails on a connection that stays alive. It
becomes live the day a `query_timeout` is set on these pools.

(b) The `res.end` census did not catch `Reflect.defineProperty(res, 'end', …)`.

## Every `.release(` and `.connect(` in `src/`, `pages/`, `scripts/`, `middleware.ts`, `instrumentation.ts`

Enumerated with `git ls-files src pages scripts middleware.ts instrumentation.ts | xargs grep -nE "\.release\(|\.connect\("`,
and cross-checked against every `BEGIN` in the same trees. "Before" is `090497265`.
`middleware.ts` and `instrumentation.ts` have neither call.

| # | Site | Owns a transaction? | Before, on a failed ROLLBACK | Now |
|---|---|---|---|---|
| 1 | `src/lib/auth/withAuth.ts` | yes | not recorded; bare release, pooled | destroyed |
| 2 | `src/lib/auth/bearerPipeline.ts` (`runBearerRequest`) | yes | same | destroyed |
| 3 | `src/lib/auth/withExtensionToken.ts` | yes | same | destroyed |
| 4 | `src/lib/auth/withInviteToken.ts` | yes | swallowed; bare release, pooled | destroyed |
| 5 | `src/lib/auth/withPlatformAdmin.ts`, role gate (`appClient`) | yes, read-only | swallowed; pooled | destroyed |
| 6 | `src/lib/auth/withPlatformAdmin.ts`, handler (`adminClient`) | yes | swallowed; pooled | destroyed |
| 7 | `src/lib/neon.ts`, `sql.transaction` (pool path) | yes | swallowed; pooled | destroyed |
| 8 | `src/lib/neon.ts`, `withTransaction` (pool path) | yes | swallowed; pooled | destroyed |
| 9 | `pages/api/invitations/[token]/accept.ts` | yes | logged; bare release, pooled | destroyed |
| 10 | `src/modules/accounting/services/workbench/portfolioWorkbenchService.ts` | yes, READ ONLY, one per company | swallowed; pooled | destroyed |
| 11 | `src/lib/publicRouteTx.ts` | yes | `release(err)`, destroyed; logged at warn, no error text | destroyed, through `rollbackFailed` |
| 12 | `src/lib/alsTransaction.ts` | yes | `release(err)`, destroyed | destroyed, through `rollbackFailed` |
| 13 | `scripts/_pg.ts`, `withTransactionPg` (memoised pool) | yes | swallowed; pooled | destroyed |
| 14 | `scripts/simulate-fy2026-loans.ts` (module pool) | yes | swallowed; pooled | destroyed |
| 15 | `scripts/simulate-fy2026-workflows.ts` (memoised pool) | yes | swallowed; pooled | destroyed |
| 16 | `pages/api/auth/verify-email.ts` | yes | logged; bare release, then `admin.end()` in the same `finally` | unchanged, pinned |
| 17 | `scripts/ap-backfill-supplier-payments.ts`, `apply-migrations.ts`, `auto-apply-unapplied-dryrun.ts`, `migrations/resolve-checksum-conflicts.ts`, `r088-posted-receipt-key-census.ts` | yes | bare release, then `pool.end()` in the same `finally` | unchanged, pinned |
| 18 | `scripts/fixes/backfill-je-fiscal-periods.ts`, `repairs/2026-07-05-p1-1-reverse-je-2026-00927.ts`, `run-sql.mjs`, `seed-historical-data.mjs`, `seed-prd05-qa-data.ts` | a `pg.Client` of their own, ended with `client.end()`; no pool | n/a | out of scope |
| 19 | `src/lib/auth/impersonationSessions.ts` (`client.connect()`) | no: one autocommit INSERT on its own `pg.Client`, then `end()` | n/a | out of scope |
| 20 | `sentMirrorService.ts`, `imapMirrorService.ts` (`client.connect()`, `lock.release()`) | no: an IMAP client and a mailbox lock | n/a | out of scope, pinned |

Rows 16 and 17 build a pool for one request or one run and end it in the `finally` that
releases the client, so no later caller can receive that connection. They keep their bare
release and are pinned in `tests/unit/lib/releaseCensus.test.ts`. No test drives them. The ALS
branches of `sql.transaction` and `withTransaction` use a SAVEPOINT on the request's client and
own no transaction.

Every owner in rows 1–15 has its `BEGIN` inside the `try` whose `catch` rolls back. Two did not
(rows 9 and 10); see review round 1.

## Fix

`src/lib/rollbackFailed.ts` holds `rollbackError(client, source)` and
`rollbackFailed(client, source)`. They send `ROLLBACK`. On a failure they log
`<source>: ROLLBACK failed, destroying the connection` with the error text, ask Postgres to
cancel what the backend is running, and return the error (`rollbackError`) or `true`
(`rollbackFailed`). They never throw. Each owner in rows 1–15 keeps the result in a flag and
calls `client.release(flag)`, so pg-pool destroys the client. A ROLLBACK that succeeds keeps the
connection, including after a failed COMMIT. No owner needed a per-owner option.

The wait is bounded at `rollbackBound.ms` = 5000 ms. A healthy server answers in milliseconds;
five seconds is far beyond a loaded one and well inside the pools' 15 s checkout timeout, so a
connection that has stopped answering gives its slot back before the callers queued for it give
up. No answer in that time counts as a failed ROLLBACK. The abandoned query's promise stays
handled, so its late rejection cannot surface as an unhandled rejection. The bound is an object
field so a test can shorten it; nothing in production writes it.

What `client.release(true)` does with a query still in flight, read from the installed source:

- pg-pool 3.13.0, `_release` (index.js 384–397): a truthy argument goes straight to
  `_remove(client)` (172–187). That drops the client from `_idle` and `_clients` at once, so the
  pool's slot is free immediately, and calls `client.end(cb)`.
- pg 8.20.0, `Client.end` (client.js 706–733): with an active query (or a client that is not
  queryable) it calls `connection.stream.destroy()`; with nothing in flight it sends Terminate.

What the server then does, measured on the fixture (PostgreSQL 16.15,
`client_connection_check_interval = 0`), socket destroyed 500 ms into the statement:

| Statement | Socket destroyed only | Cancel request, then destroyed |
|---|---|---|
| `pg_sleep(12)` | backend gone after 11 529 ms | 103 ms |
| `count(*)` over 60 M generated rows (about 3.7 s of CPU) | 3 245 ms | 102 ms |

So the statement runs to completion: the backend only notices the dead socket when it next
reads. Freeing the pool slot at the bound would let a burst put more backends on Postgres than
the pool's `max`. `src/lib/cancelBackend.ts` therefore sends the protocol's CancelRequest for
that backend before the owner destroys the connection. It uses a socket of its own (no pooled
connection), is not awaited, tears its socket down after 2 s at the latest, and swallows its
own errors. A cancel that reaches an idle backend is ignored by Postgres.

In the three deferred-flush wrappers:

- the answer the caller is owed stands whenever nothing is meant to commit, whatever the
  ROLLBACK did: an early 403 or 429, and a handler's own 5xx. A failed ROLLBACK destroys the
  connection, and the server discards the transaction with it;
- a COMMIT that fails is unchanged: the outcome is unknown or the write did not land, so the
  buffered 2xx is replaced by 500 `COMMIT_FAILED` (or the response is aborted if its headers
  are out), through `answerCommitFailed` in `deferredEnd.ts`;
- both failures are reported by `reportFinalizeFailure` (`deferredEnd.ts`): one line,
  `<source>: transaction finalize failed after handler responded`, with the url, status,
  `handlerFailed`, `connectionDestroyed`, company and user, and a Sentry capture with the tenant;
- the throw log's `rolledBack` is the result of the ROLLBACK that the `catch` itself ran.

The early returns, and what had been written before each:

| Owner | Early return | Written on this connection before it | Driven by a test |
|---|---|---|---|
| `withAuth` | membership lookup threw, 403 | nothing (BEGIN, SET LOCAL ROLE, two set_config, one SELECT) | yes |
| `withAuth` | not a member, 403 | nothing | yes |
| `withAuth` | no profile, 403; suspended, 403 | nothing | no |
| `withAuth` | rate limit, 429 | nothing (the limiter runs on the pool, not this client) | yes |
| `runBearerRequest` | rate limit, 429 | nothing | yes, both Bearer wrappers |
| `runBearerRequest` | invalid company id, not a member, no profile, suspended, 403 | nothing | no |
| `withExtensionToken` | connection inactive or unknown, 403 | nothing (one SELECT) | yes |
| `withExtensionToken` | wrong provider, 403 | nothing | no |
| `withPlatformAdmin` | critical audit write failed, 500 `AUDIT_WRITE_FAILED` | the handler's writes | yes |

Every one now goes through `rollbackFailed`. The last one has written, and still keeps its
answer: it is a 500 either way, and a destroyed connection discards the unaudited write.

Pools and the `error` event (pg-pool index.js 51–63, pg client.js 387–394): on release pg-pool
attaches its idle listener to the client, and that listener re-emits a client error as
`pool.emit('error')`. A pool with no `error` listener turns that into an uncaught exception.
With `_ending` set by `client.end()`, the socket's close does not emit an error (client.js
179–205), but a socket error (a reset) still does. The pools in `withInviteToken`,
`withExtensionToken` and invite accept had no listener; they have one now.

The census matcher treats `Reflect.defineProperty` like `Object.defineProperty`.

Sizes: `bearerPipeline.ts` 292, `withAuth.ts` 264, `accept.ts` 290 (was 292), `neon.ts` 478
(was 483; it was already over 300 and shrank).

## Strongest argument against

Nothing in production can reach this today, so the change adds a branch that only tests
exercise, across fifteen owners. Against that: it is one shared function and one flag per owner,
the healthy paths are pinned to reuse their connection, and the failure it prevents is one
request committing another request's rolled-back writes, possibly another tenant's.

## Tests

Integration, on real Postgres. Each case makes the owner's `ROLLBACK`, `COMMIT` or `BEGIN` fail
on its own client, counts that it fired, then runs a healthy call on the same owner and asserts
by outcome: the backend is gone from `pg_stat_activity`, the next user is on another pid, and
the failed row is absent after the next user commits. The healthy cases assert the backend is
`idle` and the same pid is reused.

- `r176-failed-rollback-evicts-connection.int.test.ts`, 29 cases: `withAuth`,
  `withBearerOrCookieAuth`, `withBearerAuth`, `withExtensionToken` (6 each) and
  `withPublicRouteTransaction` (5). One of the six is the 503 whose ROLLBACK fails: the client
  gets the handler's 503 and body.
- `r176-wrapper-edges.int.test.ts`, 16 cases. Per wrapper: an early return (403 or 429) whose
  ROLLBACK fails, still answered 403 or 429 with the connection destroyed and the pool surviving
  a client error; a ROLLBACK that succeeds in the `catch` after an earlier one failed, logged
  `rolledBack: true`; a COMMIT that fails after the headers were flushed, aborted as a COMMIT
  failure and not answered as a throw. For `withAuth`: two more early returns; a ROLLBACK queued
  behind a 60 s query, abandoned at a bound shortened to 300 ms: the 500 goes out and the backend
  is gone within 4 s (cancelled, not left to finish); and a real client-side `query_timeout` of
  300 ms, where the COMMIT and then the ROLLBACK time out in the queue. No case asserts elapsed
  time.
- `r176-other-owners-evict-connection.int.test.ts`, 36 cases: `withInviteToken`, the
  `withPlatformAdmin` handler, `withAlsTransaction`, `withTransaction`, `sql.transaction`,
  `withTransactionPg` from `scripts/_pg.ts` (5 each); the role gate (2); a failed critical audit
  write whose forced ROLLBACK fails (1); the portfolio workbench (3, one of them a BEGIN that
  fails after reaching the server).
- `r176-invite-accept-evicts-connection.int.test.ts`, 6 cases through the real route on the
  K-041 harness (GoTrue stubbed at `fetch`), one of them the BEGIN case.
- `r176-evict.helpers.ts`, `r176-wrapper-fixture.helpers.ts`: the arming, the backend probe and
  the wrappers' fixture.

Unit:

- `tests/unit/lib/rollbackFailed.test.ts`: success, rejection, a `query()` that throws, the
  bound under fake timers (pending one tick before it, failed at it; a shortened bound is
  honoured), the cancel on a failure and none on success, a cancel that throws, a late rejection
  after abandonment, no timer left behind.
- `tests/unit/lib/cancelBackend.test.ts`: against a plain TCP listener, the 16-byte
  CancelRequest carries the pid and key; no socket for a client that is not a connected pg
  client; the socket is torn down at 2 s; a refused connection raises nothing.
- `tests/unit/lib/auth/deferredEnd.test.ts`: `reportFinalizeFailure` logs the request and
  tenant, captures to Sentry only when it is on, and never throws.
- `tests/unit/lib/releaseCensus.test.ts`, on `git ls-files` of `src/`, `pages/`, `scripts/`,
  `middleware.ts`, `instrumentation.ts`. A release with no argument or a constant-falsy one
  (`false`, `null`, `undefined`, `0`, `''`, `void 0`, `!1`) must be pinned by exact text with its
  reason. A pinned per-run-pool release must sit in a `finally` that also ends a pool. Any other
  release must pass a value that, in the same function, is or is assigned from a
  `rollbackFailed(` / `rollbackError(` result, or an error caught there. `.call`, `.apply`,
  `.bind`, a spread argument, an alias, a callback and destructuring fail closed. Each escape
  has a fixture. Its limits are in the file header: untracked files, a key held in a variable,
  a client handed to another function, and that it proves derivation, not every path.
- `tests/unit/lib/auth/deferredEndCensus.test.ts`: the `Reflect.defineProperty` fixtures.

`public-route-tx.int.test.ts` proves eviction with `pg_terminate_backend`, which passes on a
bare release too. It is left as it is; the `withPublicRouteTransaction` cases above are the
guard.

Evidence: `red.int.log` (four rounds), `green.log`, `mutations.log`. The last batch, round 4c,
ran 140 mutants on `860cc7fd2` with the baseline green three times before and once after:
140 of 140 RED. Before it, round 4 had three survivors, all in the release census's own
matcher, which got fixtures; round 4b was discarded because its baseline failed once.

## Not covered

- `verify-email.ts` and the five per-run-pool scripts (rows 16–17): not changed. The census
  asserts that each ends its pool in the same `finally`; nothing drives them.
- The two simulate scripts (rows 14–15): changed, never executed. The loans script's imports
  resolve under `bun build`. The workflows script does not resolve on unchanged code
  (`markUifDeclarationPaid` is not exported) and runs `main` on import, so it is type-checked
  ad hoc only. Only the census guards them.
- Early returns not driven by a test: see the table under Fix.
- Still unbounded: `BEGIN`, `COMMIT` and every handler query. A COMMIT is left unbounded on
  purpose: abandoning one leaves its outcome unknown.
- A half-open socket is exercised at unit level only (a `query` that never settles). The
  integration cases put a slow query ahead of the ROLLBACK instead. Not exercised: the
  finalising COMMIT itself in flight on the server when it times out, with the ROLLBACK queued
  behind that COMMIT.
- The cancel request is sent without TLS negotiation, as node-postgres's own `Client#cancel`
  does. Not tested against a server that requires TLS.
- A checked-out client that is idle between queries has no `error` listener. A FATAL that
  reaches it then (an administrator terminates the backend) is an uncaught exception
  (pg client.js 397–410). This is not new and not changed here; it surfaced as an intermittent
  failure in `public-route-tx.int.test.ts` under load, and that test now listens.
- One unit file failed 3 tests in one baseline run under load average ~31. It was not
  identified and did not recur in 20 further runs.
- `withInviteToken`'s test row is written after `SET LOCAL ROLE NONE`, because `app_user` with
  no tenant cannot insert a customer.
- These fail on unchanged source too in the fixture environment and are outside the run set:
  `tests/integration/withAuth.test.ts` (2), `admin-forbidden.test.ts` (1),
  `admin-rls-bypass.test.ts` (1), `k104-k105-invitation-token-encoding.int.test.ts` (1). The
  K-041 and K-042 suites pass only with `GOTRUE_URL` at the origin (no `/auth/v1`).

## Review round 1

Both blind reviewers said SHIP on `6c30dbec8` with LOWs. Each is fixed in `6ab2cf3b7`.

1. `sql.transaction` and `withTransaction` logged "rolled back" after a failed ROLLBACK. They
   now log "failed; its ROLLBACK failed too, connection destroyed" in that case.
2. `rolledBack: !unusable` read a sticky flag. The `catch` now logs the result of its own
   ROLLBACK; the flag still condemns the connection.
3. `withPublicRouteTransaction` and `withAlsTransaction` moved onto `rollbackFailed`. One log
   line, at error, with the error text, for every owner. `withAlsTransaction` still releases
   with an `Error`, as its unit test pins.
4. `scripts/_pg.ts` `withTransactionPg` had the defect on a memoised pool. Fixed and tested.
   The enumeration now covers `scripts/`, `middleware.ts` and `instrumentation.ts`, and found
   two more (rows 14–15).
5. `BEGIN` sat outside the guarded region in the portfolio workbench and in invite accept. It
   is inside now. The other owners already had it inside.
6. `rollbackFailed` waited without limit. It is bounded at 5 s; see Fix.
7. A handler's 5xx was replaced by 500 `COMMIT_FAILED` when its ROLLBACK failed. The handler's
   answer is replayed now. COMMIT failures still answer 500: their outcome is unknown.

New tests for each, and the release census, are listed under Tests.

## Review round 2

Both blind reviewers said SHIP on `eb9661c22` with LOWs. Each is fixed in `4dcfecf94`, with
test-only follow-ups in `85624ab1c`, `41b2ae8fa` and `860cc7fd2`.

1. Early-return and forced ROLLBACKs were bare and unbounded, and a failure turned a 403 or 429
   into 500. They go through `rollbackFailed` now and keep their answer. The table under Fix
   says what each had written; only the audit one had, and its answer is a 500 either way.
2. A handler 5xx whose ROLLBACK failed was no longer reported with its request. It is again,
   under the same message, with `handlerFailed`, the tenant and a Sentry capture. The extension
   wrapper gains the url and a Sentry capture it did not have.
3. The release census was syntactic. It now proves the released value derives from a ROLLBACK
   outcome in the same function, fails closed on indirect calls, and asserts the per-run-pool
   reason. To satisfy it the portfolio workbench rolls back in the function that releases.
4. The bounded-wait test slept 5 s and asserted elapsed time and `totalCount`. The bound is read
   from `rollbackBound.ms`; the test shortens it and asserts the outcome. The unit case that
   asserted the constant is gone.
5. Measured: a destroyed socket does not stop the statement (table under Fix). A cancel request
   is sent first now.
6. (a) `scripts/_pg.ts` and the helper were imported and called under bun and under tsx with no
   database: both resolve. Plain `node` cannot import a `.ts` script at all, before or after.
   (b) The loans script resolves under `bun build`; the workflows script cannot be resolved on
   unchanged code and runs on import, so it stays type-checked only. (c) Three pools had no
   `error` listener and could turn a destroyed client's socket error into an uncaught exception;
   they have one now, with a test.

## Migration / rollback

There is no migration. To roll back, revert the PR.
