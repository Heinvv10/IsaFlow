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

`src/lib/rollbackFailed.ts` holds one function, `rollbackFailed(client, source)`. It sends
`ROLLBACK`, returns `false` when that worked, and on a failure logs
`<source>: ROLLBACK failed, destroying the connection` with the error text and returns `true`.
It never throws. Each owner in rows 1–15 keeps the result in a flag and calls
`client.release(flag)`, so pg-pool destroys the client. A ROLLBACK that succeeds keeps the
connection, including after a failed COMMIT. No owner needed a per-owner option. The portfolio
workbench rolls back in one function and releases in its caller, so the flag travels in a small
`tx` object.

The wait is bounded. `rollbackFailed` gives the ROLLBACK `ROLLBACK_TIMEOUT_MS` = 5000 ms. A
healthy server answers in milliseconds; five seconds is far beyond a loaded one and well inside
the pools' 15 s checkout timeout, so a connection that has stopped answering gives its slot back
before the callers queued for it give up. No answer in that time counts as a failed ROLLBACK.
The abandoned query's promise stays handled, so its late rejection cannot surface as an
unhandled rejection.

What `client.release(true)` does with a query still in flight, read from the installed source:

- pg-pool 3.13.0, `_release`: a truthy argument goes straight to `_remove(client)`. That drops
  the client from `_idle` and `_clients` at once, so the pool's slot is free immediately, and
  calls `client.end(cb)`.
- pg 8.20.0, `Client.end`: with an active query (or a client that is not queryable) it calls
  `connection.stream.destroy()`, "otherwise a hung query could block end forever". With nothing
  in flight it sends Terminate and closes cleanly. Either way the server discards the open
  transaction when the backend ends. A query still running on the server finishes first; its
  result goes nowhere and nothing commits.

In the three deferred-flush wrappers:

- a handler that answered 5xx is rolled back through `rollbackFailed`, and its own answer is
  replayed whether or not that ROLLBACK worked. Nothing was meant to commit, and a destroyed
  connection takes its transaction with it. Before, a failed ROLLBACK replaced a 503 with
  500 `COMMIT_FAILED`;
- a COMMIT that fails is unchanged: the outcome is unknown or the write did not land, so the
  buffered 2xx is replaced by 500 `COMMIT_FAILED` (or the response is aborted if its headers
  are out). That answer moved, unchanged, into `answerCommitFailed` in `deferredEnd.ts`, which
  took the three copies out of the wrappers and kept `bearerPipeline.ts` under 300 lines;
- the finalize log line carries `connectionDestroyed`; the throw log's `rolledBack` is the
  result of the ROLLBACK that the `catch` itself ran.

The census matcher treats `Reflect.defineProperty` like `Object.defineProperty`.

Sizes: `bearerPipeline.ts` 294, `withAuth.ts` 269, `accept.ts` 288 (was 292), `neon.ts` 478
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
- `r176-wrapper-edges.int.test.ts`, 14 cases. Per wrapper: an early return (403 or 429) whose
  ROLLBACK throws; a ROLLBACK that succeeds in the `catch` after an earlier one failed, logged
  `rolledBack: true`; a COMMIT that fails after the headers were flushed, aborted as a COMMIT
  failure and not answered as a throw. For `withAuth`: a ROLLBACK queued behind a 9 s query is abandoned at 5 s,
  the 500 goes out, the pool holds no slot, and the row is absent; and a real client-side
  `query_timeout` of 300 ms, where the COMMIT and then the ROLLBACK time out in the queue and
  the connection is destroyed with a query in flight.
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
  bound (pending at 4999 ms, failed at 5000 ms), a late rejection after abandonment, no timer
  left behind.
- `tests/unit/lib/releaseCensus.test.ts`: every `.release(` in `src/`, `pages/`, `scripts/`,
  `middleware.ts` and `instrumentation.ts` passes an argument that can be truthy, or is pinned
  with its reason. It reads `git ls-files`, pins each file's bare calls by exact text, and
  fails on a new one, an extra one in a pinned file, or a pinned one that is gone. A release
  reached through an alias is the named limit.
- `tests/unit/lib/auth/deferredEndCensus.test.ts`: the `Reflect.defineProperty` fixtures.

`public-route-tx.int.test.ts` proves eviction with `pg_terminate_backend`, which passes on a
bare release too. It is left as it is; the `withPublicRouteTransaction` cases above are the
guard.

Evidence: `red.int.log` (three rounds), `green.log`, `mutations.log`. Round 3 ran 84 mutants on
`6ab2cf3b7`: 83 RED, one survivor (a COMMIT failure after flushed headers reached the same
abort through the `catch`). It got a case in `c04a52944`, and round 3b re-ran all 84 on that
head: 84 of 84 RED, baseline green after.

## Not covered

- `verify-email.ts` and the five per-run-pool scripts (rows 16–17): not changed, not tested.
- The two simulate scripts (rows 14–15): changed, type-checked ad hoc, never executed. Only
  the census guards them. `simulate-fy2026-workflows.ts` has an unrelated type error on
  unchanged code (`markUifDeclarationPaid` is not exported).
- Still unbounded: `BEGIN`, `COMMIT`, the early-return `ROLLBACK`s in the three wrappers, the
  forced `ROLLBACK` after a failed critical audit, and every handler query. Only the ROLLBACK
  sent through `rollbackFailed` is bounded. A COMMIT is left unbounded on purpose: abandoning
  one leaves its outcome unknown.
- A half-open socket is exercised at unit level only (a `query` that never settles). The
  integration cases put a slow query ahead of the ROLLBACK instead. Not exercised: the
  finalising COMMIT itself in flight on the server when it times out, with the ROLLBACK queued
  behind that COMMIT. Exercised: release with a query in flight, and a ROLLBACK queued behind an
  in-flight query, both with and without `query_timeout`.
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

## Migration / rollback

There is no migration. To roll back, revert the PR.
