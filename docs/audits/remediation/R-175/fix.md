# R-175 — the rate limiter admitted more calls than its limit

## Defect

`checkRateLimit` in `src/lib/rateLimit.ts` kept a 5-second in-process LRU copy of each counter.
For a cost-1 call, while that copy was below half of `max`, it admitted the call and bumped only
the copy (`cached.count += 1`). The `rate_limit_counters` row never saw that call.

Every call that did reach the database overwrote the copy with the database count. That count
was lower than the copy, because the local admissions were missing from it. So the copy dropped
back under the threshold and the limiter admitted locally again.

Every rate-limited route went through this: login, 2FA, password reset, invites, portal payment
create and verify, AI, email send, report export, MCP.

## Measurement

On unchanged code (`origin/master` 090497265), against real PostgreSQL, one process:

- A limit of 20 admitted **65** of 100 sequential calls. The team lead's estimate was about 70.
- Two module instances sharing the table, 100 alternating calls: 65 admitted.
- Three calls far below a limit left a stored count of 1, not 3.
- 9 cost-1 calls then one cost-11 call left a stored count of 12, not 20.
- After 20 admitted calls a refund of 2 found a stored count of 1, so it could not give back 2.

100 concurrent calls (`Promise.all`) on a fresh key admitted exactly 20 even before the fix. They
all start before the first database answer fills the LRU. That case passes on both sides and is
kept as a guard.

Output: `red.int.log` (7 failed, 4 passed) and `red.unit.log` (4 failed, 2 passed).

## Fix

The short-circuit is removed. There is no in-process state left in the limiter.

- Every `checkRateLimit` call does the atomic upsert. The verdict is `count <= max` on the row
  the database returns. The SQL is unchanged, except it no longer returns `window_start`.
- `refundRateLimit` no longer has an LRU entry to drop. Its SQL is unchanged.
- `clearRateLimitCache` is kept as an exported no-op. Three test files still call it.
- `lru-cache` is no longer imported here. Other modules still use the package.
- No exported signature changed. No caller's code changed.

Comments that described the old behaviour were corrected in
`pages/api/invitations/[token]/accept.ts`, `pages/api/mcp/index.ts` and
`src/lib/rateLimit.claude.md`. Invite-accept keeps `ATTEMPT_COST = 2`; it is still ten attempts
an hour, and changing it would change what the live counters mean.

A cache that only refuses early was considered and not built. It would save the upsert for a key
that is already over its limit. But over-limit calls already reached the database before this
change, so it buys nothing new, and it would need a rule for refunds made by another process and
for clock difference between the app and the database.

## The strongest argument against

One extra database write per rate-limited request. Calls under half their limit used to cost
nothing; now each is an upsert on `rate_limit_counters`.

The sharper form of that cost is K-103, which is still open. Inside a `withAuth` or
`withPlatformAdmin` transaction the upsert joins the request transaction (read from
`src/lib/neon.ts`; K-103 measured it). The key's row lock is then held until the request ends.
Before this fix that only happened once a key passed half its limit. Now it happens from the
first call. Two requests from one company to the same AI, send or report route will run one
after the other, not side by side. Routes wrapped only in `withRateLimit` (login, register,
password reset) have no request transaction and are not affected.

This was not measured here. It should be weighed before deploy, and K-103's fix (give the limiter
its own connection) removes it.

## Behaviour that changes for callers

- Limits now hold at their stated value. Callers that were getting about three times their limit
  will be refused sooner. This is the point of the fix.
- A refused call still adds to the counter, as it did before whenever it reached the database.
- Requests on the same key inside a request transaction serialise from the first call (above).

## Tests

- `tests/integration/r175-rate-limit-admits-over-max.int.test.ts` — 11 cases on real PostgreSQL:
  exactly `max` admitted, sequential and concurrent; a low-volume call is stored; cost-1 calls
  count against a later weighted call; weighted calls; window rollover; a window that has not
  ended; refund; refund floor, window and absent key; two module instances, alternating and
  concurrent. Red 7 of 11, green 11 of 11.
- `tests/unit/lib/rateLimitEveryCallCounted.test.ts` — 6 cases with `sql` mocked. Red 4 of 6,
  green 6 of 6.
- Every `tests/unit` file that mentions the limiter: 47 files, 539 tests, all pass.
- The three limiter unit files run against the fixture database: 28 pass.
- Every other `tests/integration` file that mentions the limiter or its table: 23 files. 16 pass.
  7 fail (15 tests), and the same 15 fail with `origin/master`'s limiter swapped in. The causes are
  the harness, not the limiter: no GoTrue on the fixture, a database-name guard, and a function
  owner. See `green.log`.
- `mutations.log`: 14 mutants, 14 red, baseline green afterwards.

Not verified: k-041 "L4" and "L7", the two existing tests that drive the limiter and the refund
through the invite-accept route. They need GoTrue, which this harness does not have.

Stale comments remain in `tests/unit/lib/rateLimit.test.ts` and `rateLimitSend.test.ts`. They
talk about flushing the LRU. The tests still pass and were left alone.

## Rollback

Revert the fix commit. No migration, no data change, no configuration. Counters written while
the fix was live stay valid for the old code.
