# Plan — withAuth commit-before-respond platform fix

Branch: `fix/withauth-commit-before-respond` (worktree `.claude/worktrees/withauth-commit`, base `1783f9ff`).

## Problem (verified against code at 1783f9ff)
`withAuth` runs the route handler — which flushes the HTTP response (`res.json`/`res.end`) — **inside** the open transaction, then `COMMIT`s at line 178 *after* the response is already on the wire. A client that fires a follow-up request immediately after a mutation can read the DB before COMMIT lands (reproduced twice: GET 404'd 78ms after a 201; deleted row visible 27ms after DELETE 200).

Secondary: handlers wrapped in `withErrorHandler` (which sits **inside** withAuth) catch their own errors, respond `500`, and return normally — so withAuth `COMMIT`s a failed request's partial writes.

## Fix
Defer the **final response flush** until after the transaction is finalised.

1. Just before running the handler, monkey-patch `res.end` on the instance to **buffer** its arguments instead of flushing (Next's `res.json`/`res.send` both funnel through `res.end` — verified in `next/dist/server/api-utils/node/api-resolver.js` lines 284–285 → `sendData`/`sendJson` → `res.end`, Next 14.2.35). Capturing `res.end` therefore captures every `apiResponse.*` helper, the xlsx `res.end(buffer)` routes, and the pdf `res.send(buffer)` route.
2. After the handler returns, inspect `res.statusCode`:
   - `>= 500` → `ROLLBACK` (the secondary-bug fix), then replay the buffered flush.
   - `< 500`  → `COMMIT`, then replay the buffered flush.
3. If `COMMIT` itself throws after a `< 500` buffered response, **do not** replay the lie: `ROLLBACK` (best-effort), log + Sentry, and send a fresh `500` JSON instead (headers were never flushed because the flush was deferred). This is the design's win — today a failed COMMIT after a 200 is silent.
4. Double-`end` guard: the patched `end` records the *first* call and ignores the rest, so a handler that ends twice still flushes once.

## Locked decisions (with receipts)
- **5xx → ROLLBACK, <5xx → COMMIT.** 5xx is unambiguously a failed request; committing partial writes on a 500 is the "worse than the race" bug. 4xx is left **COMMIT** (current behaviour) deliberately: handlers that validate-then-400 almost always return *before* any write (empty tx → commit/rollback equivalent), and any handler that intentionally writes-then-4xx (audit row, counter) would regress under a blanket 4xx-rollback. Mandate is "behaviorally invisible except for ordering" — so we tighten only the unambiguous 5xx case. Net behaviour change vs today: ordering (always) + 5xx now rolls back (was commit).
- **Patch `res.end` only, not `res.write`.** No `withAuth`-wrapped route streams via chunked `res.write` (grep: the only `res.write` routes — admin CSV exports — are wrapped in `withAdmin`, not `withAuth`). xlsx routes call `res.end(buffer)` once; pdf calls `res.send(buffer)` once. Buffering the single final `end` is correct for all of them. If a future route flushes headers before COMMIT (`res.headersSent` already true at handler return), we skip the 500-rewrite and just replay — no regression, the race simply isn't fixed for that hypothetical route.
- **Status read from `res.statusCode`.** Set synchronously by `res.status(n)` before the handler resolves.

## Blast radius
withAuth wraps ~750 routes. Behaviorally invisible except ordering. Verify: one normal CRUD page, one file-download/export route (xlsx), the two formerly-workaround pages (payroll parallel-run, bank/queries) with their `settle`/`retry` removed.

## Proof: remove the per-page workarounds
- `pages/payroll/parallel-run/index.tsx`: `settle` (600ms) + 1 retry in `loadComparison`.
- `pages/accounting/bank/queries.tsx`: `settle` (600ms) + retry in `load`.
Removing both and watching mutation→immediate-refetch succeed is the live proof.

## Gates
TDD RED-first (mock pg client recording call order), then `bun run type-check`, `bun run lint`, `bun run ci`, ≤300-line files, blind security review (mandatory — auth middleware), after-hours prod deploy + live verify.
