# R-196: `auth pool saturated` warns on every acquire an idle client serves

## Defect
`connectObserved` (`src/lib/auth/poolTelemetry.ts`, R-188) warned whenever
`pool.waitingCount > 0` right after `pool.connect()`. pg-pool 3.13 (`connect()`) pushes
every acquire onto `_pendingQueue` when an idle client exists, and serves it on the next
tick (`process.nextTick(() => this._pulseQueue())`). So almost every acquire looked like
a queued one.

Prod, 2026-10-04 16:48 to 2026-10-05 06:20 SAST (`sudo journalctl -u isaflow`):
- 628 warnings, almost all from `bearerPipeline`; 597 of them were `{waitingCount 1, totalCount 1, idleCount 1, max 10}`.
- The largest `totalCount` seen was 4. None had `totalCount = max`.
- `auth pool acquire failed`: 0.

The warning is R-188's documented rollback trigger (`AUTH_POOL_MAX=20`), so a false one
invites a needless rollback, and it hides a real saturation in noise.

## Fix
Warn only when no idle client and no new connection can serve the waiters:
`waitingCount > idleCount + max(0, max - totalCount)`. A full pool with idle clients serves
its waiters from them on the next tick. A pool that is not full opens new clients only when
the next-tick pulses run, so a burst in ONE tick can exceed the idle clients plus the
remaining headroom while every snapshot still shows `totalCount < max`. Round 1's
`totalCount >= max && waitingCount > idleCount` missed that burst (review rev-r196 [M]: a
`max 3` pool with 2 open, 1 idle, and 3 acquires in one tick left a waiter on a release
unreported).

## Tests
- `tests/unit/lib/auth/poolTelemetryIdleQueue.test.ts` (real `pg.Pool`, fake client):
  - idle client, pool not full (the prod shape): no warning;
  - full pool with an idle client: no warning;
  - a burst larger than the idle clients on a pool that can still grow: no warning;
  - full pool with the waiters outnumbering the idle clients: warns with the counts;
  - a same-tick burst larger than idle + headroom on a pool that is not full: warns once.
- `poolTelemetryRealPool.test.ts`: the fake client was not `_queryable`, so pg-pool
  discarded every released client. Its "does not warn when a connection is free" test
  therefore never had an idle client and passed vacuously. The client is now queryable,
  and the test asserts `idleCount` 1 before the second acquire. It fails against the R-188 check.

## Evidence
`mutations.log` (run on the committed test files; each mutant's expression is recorded):
baseline 75/75; M1 (the R-188 check) 5 red; M2 (round 1, no headroom) 1 red; M3 (ignore
idle clients) 2 red; M4 (ignore headroom) 2 red; M5 (never warn) 7 red. Baseline again 75/75.

## Not changed
The message text, the 10 s rate limit and the error path are unchanged. The
`.gitignore` rule for audit storage states is a separate PR (review: out of scope here).
