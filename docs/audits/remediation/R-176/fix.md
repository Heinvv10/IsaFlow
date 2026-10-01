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

## Every `.release(` and `.connect(` in `src/` and `pages/`

Enumerated with `grep -rnE "\.release\(|\.connect\(" src pages`, and cross-checked against
every `BEGIN` in the same trees. "Before" is `090497265`.

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
| 11 | `src/lib/publicRouteTx.ts` | yes | `release(err)`, destroyed | unchanged |
| 12 | `src/lib/alsTransaction.ts` | yes | `release(err)`, destroyed | unchanged |
| 13 | `pages/api/auth/verify-email.ts` | yes | logged; bare release, then `admin.end()` in the same `finally` | unchanged |
| 14 | `src/lib/auth/impersonationSessions.ts` (`client.connect()`) | no: one autocommit INSERT on its own `pg.Client`, then `end()` | n/a | out of scope |
| 15 | `sentMirrorService.ts`, `imapMirrorService.ts` (`client.connect()`, `lock.release()`) | no: an IMAP client and a mailbox lock | n/a | out of scope |

Row 10 was not in the brief; the enumeration found it. Row 13 was in the brief and is left
alone: `verify-email.ts` builds a new pool on every request and ends it in the `finally` that
releases the client, so no later caller can receive that connection. No test drives it. The
ALS branches of `sql.transaction` and `withTransaction` use a SAVEPOINT on the request's client
and own no transaction.

## Fix

`src/lib/rollbackFailed.ts` holds one function, `rollbackFailed(client, source)`. It sends
`ROLLBACK`, returns `false` when that worked, and on a failure logs
`<source>: ROLLBACK failed, destroying the connection` and returns `true`. Each owner in rows
1–10 keeps the result in a flag and calls `client.release(flag)`, so pg-pool destroys the
client. A ROLLBACK that succeeds keeps the connection, including after a failed COMMIT. No
owner needed a per-owner option. The portfolio workbench rolls back in one function and
releases in its caller, so the flag travels in a small `tx` object.

In the three deferred-flush wrappers the finalize log line also gains `connectionDestroyed`,
and the throw log's `rolledBack` is `!unusable`. The census matcher treats
`Reflect.defineProperty` like `Object.defineProperty`.

Sizes: `bearerPipeline.ts` 299, `accept.ts` 288 (was 292), `neon.ts` 478 (was 483; it was
already over 300 and shrank).

## Strongest argument against

Nothing in production can reach this today, so the change adds a branch that only tests
exercise, across ten owners. Against that: it is one shared function and one flag per owner,
the healthy paths are pinned to reuse their connection, and the failure it prevents is one
request committing another request's rolled-back writes, possibly another tenant's.

## Tests

All on real Postgres. Each case refuses the owner's `ROLLBACK` and/or `COMMIT` on its own
client before it reaches the server, counts the refusals, then runs a healthy call on the same
owner and asserts by outcome: the backend is gone from `pg_stat_activity`, the next user is on
another pid, and the failed row is absent after the next user commits. The healthy cases
assert the backend is `idle` and the same pid is reused.

- `tests/integration/r176-failed-rollback-evicts-connection.int.test.ts`, 29 cases: `withAuth`,
  `withBearerOrCookieAuth`, `withBearerAuth`, `withExtensionToken` (6 each) and
  `withPublicRouteTransaction` (5).
- `tests/integration/r176-other-owners-evict-connection.int.test.ts`, 29 cases:
  `withInviteToken`, the `withPlatformAdmin` handler, `withAlsTransaction`, `withTransaction`,
  `sql.transaction` (5 each); the `withPlatformAdmin` role gate (2); the portfolio workbench
  (2). The gate writes nothing, so its proof is the backend and the pid. The workbench is
  read-only, so its proof is that the next admin write succeeds.
- `tests/integration/r176-invite-accept-evicts-connection.int.test.ts`, 5 cases, through the
  real route on the K-041 harness (GoTrue stubbed at `fetch`).
- `tests/integration/r176-evict.helpers.ts`: the shared arming and backend probe.
- `tests/unit/lib/auth/deferredEndCensus.test.ts`: a fixture that must be flagged and one that
  must not.

`public-route-tx.int.test.ts` proves eviction with `pg_terminate_backend`, which passes on a
bare release too. It is left as it is. The `withPublicRouteTransaction` cases in the first
suite replace it as the guard: mutant R2-M44 (bare release there) is RED.

Evidence: `red.int.log` (round 1: 16 of 29 red; round 2: 10 of 29 and 2 of 5 red),
`green.log`, `mutations.log` (round 2: 48 mutants on the final head, all RED).

## Not covered

- `pages/api/auth/verify-email.ts` (row 13): not changed and not tested.
- An early return (403, 429) in the three wrappers whose `ROLLBACK` throws. It reaches the same
  `catch` line, but no case drives it.
- A real client-side `query_timeout`. The tests refuse the statement instead.
- `withInviteToken`'s test row is written after `SET LOCAL ROLE NONE`, because `app_user` with
  no tenant cannot insert a customer.
- These fail on unchanged source too in the fixture environment and are outside the run set:
  `tests/integration/withAuth.test.ts` (2), `admin-forbidden.test.ts` (1),
  `admin-rls-bypass.test.ts` (1), `k104-k105-invitation-token-encoding.int.test.ts` (1). The
  K-041 and K-042 suites pass only with `GOTRUE_URL` at the origin (no `/auth/v1`).

## Migration / rollback

There is no migration. To roll back, revert the PR.
