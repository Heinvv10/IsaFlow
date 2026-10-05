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
Warn only when no idle client and no new connection can serve the waiter:
`totalCount >= max && waitingCount > idleCount`. A pool that is not full opens a new
client for a waiter; a full pool with idle clients serves them on the next tick.

## Tests
- `tests/unit/lib/auth/poolTelemetryIdleQueue.test.ts` (real `pg.Pool`, fake client):
  - idle client, pool not full (the prod shape): no warning;
  - full pool with an idle client: no warning;
  - a burst larger than the idle clients on a pool that can still grow: no warning;
  - full pool with the waiters outnumbering the idle clients: warns with the counts.
- `poolTelemetryRealPool.test.ts`: the fake client was not `_queryable`, so pg-pool
  discarded every released client. Its "does not warn when a connection is free" test
  therefore never had an idle client and passed vacuously. The client is now queryable,
  and the test asserts `idleCount` 1 before the second acquire. It fails against the R-188 check.

## Evidence
`mutations.log`: baseline 74/74; M1 (the R-188 check) 3 red; M2 (no full-pool term)
1 red; M3 (no idle comparison) 1 red; M4 (never warn) 6 red. Baseline again 74/74.

## Not changed
The message text, the 10 s rate limit and the error path are unchanged.
