# R-175 and K-103 — the rate limiter admitted more calls than its limit, and wrote its counter on the request's transaction

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
  the database returns. The SQL logic is unchanged, except it no longer returns `window_start`.
- `refundRateLimit` no longer has an LRU entry to drop. Its SQL logic is unchanged.
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

## K-103 — fixed in the same branch

R-175 alone could not ship. The limiter used the shared `sql` template. Inside a request
transaction `sql` runs on the request's own connection. Two things followed:

- A request that rolled back was never charged.
- The key's row lock was held until the request ended, so same-key requests queued.

Before R-175 that only happened above half the limit. With R-175 it happened on every call.

Measured on 527dda3f4 (`../K-103/red.r175.int.log`, 5 failed, 2 passed): no counter row after a
rollback; a refund undone by a rollback; a second same-key request still blocked after 2 seconds.

### Fix

`checkRateLimit` and `refundRateLimit` run on the limiter's own pool,
`src/lib/rateLimitPool.ts`, outside any transaction. Each statement commits by itself. The charge
survives whatever the request does, and no lock outlives the statement. The refund takes the same
path as the charge.

### Why a separate pool

A request already holds one connection from the main pool for its transaction. If the limiter
took a second one from that pool, a full pool of requests would each wait for a connection that
none of them can free. Measured (mutant K3): with all 10 request connections held, a limiter on
the main pool waits the full 15-second connect timeout. K-103's validation proposed the main
pool; that was not used for this reason.

### Size, cost and failure

- 3 connections per process, fixed. Each statement takes about a millisecond.
- Cost: up to 3 more PostgreSQL connections per app process. They close after 30 seconds idle.
  The number of production processes and the server's connection limit were not checked.
- A call waits at most 5 seconds for a connection, then throws. No caller catches a limiter
  error, so the request fails with a 500. That is what a database error has always done here.
  Nothing is admitted unchecked.
- No statement timeout was added. A limiter statement can now only wait behind another limiter
  statement, which is over in milliseconds.

### Row security and role

On the fixture, `rate_limit_counters` has no row security, no policies and no triggers.
`app_user` and `platform_admin` hold INSERT, SELECT, UPDATE and DELETE.

The limiter pool connects with `DATABASE_URL`, the same role as the main pool before any
`SET LOCAL ROLE`. Login, register and password reset already write the table on that role,
outside any transaction. Inside `withAuth` the write used to run as `app_user`; it now runs as
the pool role. The production role's grants were not inspected.

## The strongest argument against

One extra database round-trip per rate-limited request, on a second connection. Calls under
half their limit used to cost nothing. Now each is an upsert, and the limiter keeps up to 3
connections of its own per process.

A flood of limited requests now queues on 3 connections instead of spreading over the request
pool. If the queue is longer than 5 seconds the requests fail with 500. This was not load-tested.

A request that fails is now charged. That is K-103's intent, but it is a change: a route that
returns 500 repeatedly will use up its caller's allowance.

## Behaviour that changes for callers

- Limits now hold at their stated value. Callers that were getting about three times their limit
  will be refused sooner.
- A refused call still adds to the counter, as it did before whenever it reached the database.
- A charge is kept when the request rolls back. `withAuth` and the bearer pipeline ROLLBACK
  after a 429; that used to undo the refused call's own increment and now does not.
- Same-key requests no longer wait for each other.
- `pages/api/invitations/[token]/accept.ts` wraps its charge and refund in `als.exit`. That is
  no longer needed and was left in place. Only its comment changed.

## Tests

- `tests/integration/r175-rate-limit-admits-over-max.int.test.ts` — 11 cases on real PostgreSQL:
  exactly `max` admitted, sequential and concurrent; a low-volume call is stored; cost-1 calls
  count against a later weighted call; weighted calls; window rollover; a window that has not
  ended; refund; refund floor, window and absent key; two module instances, alternating and
  concurrent. Red 7 of 11, green 11 of 11.
- `tests/integration/k103-rate-limit-rolls-back-with-request.int.test.ts` — 7 cases: the charge
  survives a rollback and is visible before the request ends; a handler that throws is charged;
  a refund survives a rollback; two same-key requests held open do not block each other, with
  both transactions checked as still open; 40 concurrent requests admit exactly `max`; the
  limiter answers while every request connection is held; the limiter fails within a bound and
  does not admit when its own pool is exhausted. Red 5 of 7, green 7 of 7.
  The register named this file, but it was not in the repository at any ref. It was rewritten
  from `../K-103/red.log`, keeping the two original cases.
- `tests/unit/lib/rateLimitEveryCallCounted.test.ts` — 6 cases with the pool mocked. Red 4 of 6
  on `origin/master`, green 6 of 6.
- The whole unit suite: 1117 files, 14881 pass, 6 skipped, the same as before the K-103 change.
  Two files mocked `sql` for the limiter and now mock its pool: `checkReportRateLimit.test.ts`
  and the new unit file.
- The four limiter unit files against the fixture database: 34 pass.
- Every other `tests/integration` file that mentions the limiter or its table: 23 files. 16 pass.
  7 fail (15 tests), and the same 15 fail with `origin/master`'s limiter swapped in. The causes
  are the harness: no GoTrue on the fixture, a database-name guard, and a function owner. See
  `green.log`.
- `mutations.log`: 14 mutants on the first commit, then 19 on the pool-based code (K1 to K7 for
  K-103, and the R-175 set repeated). All red. Baseline green afterwards. The pool size is
  tuning, not a guard, and has no mutant.

Not verified:

- k-041 "L4" and "L7", which drive the limiter and the refund through the invite-accept route.
  They need GoTrue, which this harness does not have.
- The rest of `tests/integration`, which was not run.
- The production role's grants and the connection budget, as noted above.
- Behaviour behind a connection pooler, if production uses one.

Stale LRU comments in `tests/unit/lib/rateLimit.test.ts` and `rateLimitSend.test.ts` were
corrected. Comments only; one test title still mentions the LRU.

## Rollback

Revert the branch's commits. No migration, no data change, no configuration. Counters written
while the fix was live stay valid for the old code.
