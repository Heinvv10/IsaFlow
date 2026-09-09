# K-129 — statement send budget is charged inside the request transaction

**Claim.** `pages/api/accounting/statement-bulk-email.ts:102` charges the send budget
inside the transaction, so a 500 after mail has gone out rolls the charge back.

**Corrected trigger.** `checkSendRateLimit(..., { count: customerIds.length })` runs an
UPSERT on `rate_limit_counters` through `sql` from `@/lib/neon`. `LazyQuery#run`
(`src/lib/neon.ts:101-107`) routes any query issued during a request through the
`withAuth` transaction client, and `withAuth` ROLLBACKs on any 5xx. The sends
themselves happen after the charge, in an unwrapped `for` loop of
`await sendStatementEmail(...)`; `fetchStatementData`'s SQL or `sendEmail` throwing on
recipient k+1 is a 500. Recipients 1..k keep their mail and the whole N-unit charge is
erased. The budget is an abuse control, so this is not a metering nicety.

**Disposition: confirmed.**

**Evidence.**
- Route line 102-107; `src/lib/rateLimit.ts:161-180` and `:88-104` (the UPSERT).
- `src/lib/neon.ts` `LazyQuery#run` — ALS client takes precedence over the pool.
- Executed RED test: the counter reads 5 inside the transaction and the row is
  ABSENT after ROLLBACK.

**Reachability.** Any 5xx raised after the charge. The `count > 1` path always reaches
the database (the LRU short-circuit is restricted to `cost === 1`), so the charge is
always transactional here, never cached-only.

**RED test.** `tests/integration/k129-send-budget-rolls-back-with-request.int.test.ts`
(1 test, 1 failed) — output in `red.log`.

**Scope beyond this route.** The same shape applies to every counter charged from
inside a request transaction: `checkAiRateLimit` (LLM spend) and `checkReportRateLimit`.
Fix the primitive, not the call site.

**Proposed minimal fix.** In `src/lib/rateLimit.ts#checkRateLimit`, issue the UPSERT on
a dedicated pool connection rather than the ALS client — e.g. take
`getPool().query(...)` directly instead of the `sql` tagged template — so the counter
commits independently of the request. The counter table has no FK to request data, so
it needs no transactional consistency with the handler's writes.

**Historical-data impact.** None to the ledger. Under-counted send budgets cannot be
reconstructed. No impact query is meaningful.

**Risks.** Moving the charge off the request transaction means a request that fails
BEFORE sending still consumes budget. That is the correct trade for an abuse control,
and the volumes (2,000 / 15 min) absorb it.
