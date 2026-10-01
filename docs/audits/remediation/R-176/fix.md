# R-176 — a transaction owner whose ROLLBACK fails destroys the connection instead of pooling it

## Defect

(a) `withAuth`, the Bearer pipeline (`runBearerRequest`) and `withExtensionToken` released their
client with a bare `client.release()` on every path. pg-pool evicts a client on a bare release
only when its socket is already dead. A live connection whose ROLLBACK never reached the server
went back to the pool inside its open transaction. The next request on that pool got it. Its
`BEGIN` was a no-op with a warning, and its `COMMIT` landed the failed request's writes.

Proved on unchanged code (`red.int.log`): a request writes a customer row and throws, its
ROLLBACK is refused, the backend is left `idle in transaction`, and the next request's COMMIT
commits the row (`expected 1 to be +0`).

Reach today: low. No auth pool sets a client-side `query_timeout`, and a dropped socket is
evicted by pg-pool itself. The defect needs a ROLLBACK that fails on a connection that stays
alive. It becomes live the day a `query_timeout` is set on these pools.

(b) The `res.end` census did not catch `Reflect.defineProperty(res, 'end', …)`.

## How each owner behaved before

| Owner | Throw, ROLLBACK fails | COMMIT fails, then ROLLBACK fails | 5xx answer, ROLLBACK fails twice |
|---|---|---|---|
| `withAuth` | bare release, pooled | bare release, pooled | bare release, pooled |
| `runBearerRequest` | bare release, pooled | bare release, pooled | bare release, pooled |
| `withExtensionToken` | bare release, pooled | bare release, pooled | bare release, pooled |
| `withPublicRouteTransaction` | `release(err)`, destroyed | `release(err)`, destroyed | not applicable |

In the three wrappers the release is one line in `finally`. The early returns (403, 429) run
`ROLLBACK` inside the `try`; if that throws it lands in the same `catch`. The finalize path
swallowed a failed secondary ROLLBACK with an empty `catch`. `withPublicRouteTransaction`
already evicted and is unchanged; `withAlsTransaction` already evicts too.

## Fix

Each of the three wrappers keeps one flag, `unusable`. It is set where a ROLLBACK fails: the
secondary ROLLBACK after a failed COMMIT or ROLLBACK, and the ROLLBACK in the `catch`. The
`finally` calls `client.release(unusable)`, so pg-pool destroys the client. A ROLLBACK that
succeeds leaves the flag false and the connection is reused, including after a failed COMMIT.
The finalize log line gains `connectionDestroyed`; the throw log's `rolledBack` is now
`!unusable`. No file grew past 300 lines (`bearerPipeline.ts` stays at 298).

The census matcher treats `Reflect.defineProperty` like `Object.defineProperty`.

## Strongest argument against

Nothing in production can reach this today, so the change adds a branch that only a test
exercises. Against that: the cost is one flag per wrapper, the healthy paths are pinned to
reuse the connection, and the failure it prevents is one tenant's request committing another
request's rolled-back writes.

## Tests

`tests/integration/r176-failed-rollback-evicts-connection.int.test.ts`, 29 cases on real
Postgres (6 per wrapper for `withAuth`, `withBearerOrCookieAuth`, `withBearerAuth`,
`withExtensionToken`; 5 for `withPublicRouteTransaction`). The handler takes its own client
from ALS and makes `ROLLBACK` and/or `COMMIT` reject before they reach Postgres, so the
transaction really stays open. Each case counts the refusals, then runs a healthy request on
the same owner, and asserts by outcome:

- throw, ROLLBACK fails: backend gone from `pg_stat_activity`, next request on another pid,
  the row absent after that request commits, throw log `rolledBack: false`;
- COMMIT fails, then ROLLBACK fails: the same, with 500 `COMMIT_FAILED`;
- 500 answer, ROLLBACK fails twice: the same;
- throw, ROLLBACK succeeds: backend `idle`, same pid reused;
- COMMIT fails, ROLLBACK succeeds: backend `idle`, same pid reused, row absent;
- 200: committed, same pid reused.

`tests/unit/lib/auth/deferredEndCensus.test.ts`: a fixture that must be flagged
(`Reflect.defineProperty(res, 'end', …)`) and one that must not (`'status'`).

Evidence: `red.int.log` (16 of 29 red on `090497265`; the 13 green are the healthy paths and
all of `withPublicRouteTransaction`), `green.log`, `mutations.log` (21 mutants, all RED; M6
survived the first run and got a case).

## Not covered

- An early return (403, 429) whose `ROLLBACK` throws. It reaches the same `catch` line, but
  no case drives it: the handler never runs, so the test cannot arm the client.
- A real client-side `query_timeout`. The test refuses the statement instead.
- `tests/integration/withAuth.test.ts` fails 2 of 2 with 401 on unchanged source in the
  fixture environment. It is not part of this change.

## Follow-up (not in this change)

The same bare release after a swallowed ROLLBACK failure is in: `src/lib/auth/withInviteToken.ts`,
`src/lib/auth/withPlatformAdmin.ts` (two clients), `src/lib/neon.ts` (`sql.transaction` and
`withTransaction`), `pages/api/auth/verify-email.ts` and `pages/api/invitations/[token]/accept.ts`.
`tests/integration/public-route-tx.int.test.ts` proves eviction with `pg_terminate_backend`,
which pg-pool evicts on a bare release too, so that case cannot fail.

## Migration / rollback

There is no migration. To roll back, revert the PR.
