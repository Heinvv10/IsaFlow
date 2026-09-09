# K-103 — Rate-limit counter rolls back with the request

**Baseline:** origin/master `31fc2f10`; `rateLimit.ts` unchanged since the audited `5661d6f0`.

**Claim vs corrected trigger.** Both halves of the claim confirmed. `src/lib/rateLimit.ts:89` uses
the plain `sql` tagged template, which binds to the ALS request client whenever one is open
(`src/lib/neon.ts:102`), so the UPSERT joins the request transaction. A request that ends in a
ROLLBACK is never charged, and the row lock the UPSERT takes is held until the request ends.

**Disposition: confirmed.**

**Evidence.** Executed against the fixture database. (1) `checkRateLimit` inside an ALS-bound
transaction that then ROLLBACKs leaves no `rate_limit_counters` row at all. (2) A second client
calling `checkRateLimit` for the same key while the first request's transaction is still open
blocks and dies on `lock_timeout` — `55P03`, `while inserting index tuple in relation
"rate_limit_counters"`.

**Reachability.** Two live paths. `withAdmin` calls `checkRateLimit` from inside the
`withPlatformAdmin` transaction (`src/modules/admin/middleware/withAdmin.ts:17`, invoked at
`withPlatformAdmin.ts:137`). `checkAiRateLimit`, `checkSendRateLimit` and `checkReportRateLimit`
are all called from handlers running inside the `withAuth` transaction. Only `withRateLimit` on
unauthenticated routes (login, register, forgot-password) escapes, because no ALS client exists
there. So the routes the limiter exists to protect — AI spend, bulk email, heavy exports, the admin
console — are exactly the ones where it can be rolled back.

**RED test.** `tests/integration/k103-rate-limit-rolls-back-with-request.int.test.ts` — 2 failed.
Output in `red.log`.

**Proposed fix.** Give `checkRateLimit` its own connection. Take a client from the pool directly
rather than through the ALS-bound `sql`, run the UPSERT with its own implicit commit, and release
it. That makes the charge durable regardless of the request's outcome and releases the row lock
immediately. The LRU short-circuit and the counter semantics stay as they are.

**Historical impact.** No corrupted rows. Counters have been systematically under-counted for
failed requests, which means the AI, send and export ceilings have been softer than configured.
Read-only sizing is not possible after the fact, because the rolled-back increments left nothing
behind. Current pressure is visible with `SELECT key, count, window_start FROM rate_limit_counters
ORDER BY count DESC LIMIT 20;`

**Risk.** A dedicated connection per limiter call adds pool pressure on hot routes; the LRU
short-circuit at `rateLimit.ts:84` already absorbs most of that. The change also makes the charge
survive a request the operator might consider not worth charging — that is the intended trade.
