# K-140 — auto-post gate sweep has no per-row savepoint

**Claim.** "One failed row aborts the transaction so every later row reports a bogus skip reason."

**Disposition: confirmed**, and worse than claimed: the sweep's own successful posts are lost too.

**Mechanism.** `sweep` (`src/modules/accounting/services/bank/autoPostGateService.ts:276-352`,
origin/master) wraps each row in a bare `try/catch` that pushes a skip reason and continues. Every
request is one PostgreSQL transaction on the ALS client (`src/lib/neon.ts:102-108` routes bare
`sql` through `als.getStore().client`), so a row whose failure is a Postgres ERROR raised outside a
nested savepoint aborts that transaction. Later rows then fail 25P02, and the final COMMIT is a
rollback while the response still reports success.

`allocateTransaction`'s first statement is such a case: `lockBankTransactionForUpdate`
(`bankTxLock.ts`) issues `SELECT … FOR UPDATE` under `SET LOCAL lock_timeout = '5s'`, outside the
`withTransaction` block further down (`bankAllocationService.ts:106` vs `:404`). The sibling loop
already does it right — `bankRulesMatchingService.ts:249` wraps each candidate in
`withSavepoint('rule_autopost_line', …)`.

**RED.** `tests/integration/k140-autopost-sweep-no-savepoint.int.test.ts` — 1 failed of 1. A peer
holds row A; the sweep is asked for [A, B]. Observed skip reasons:
`A :: … is being allocated by another request — retry in a moment.` and
`B :: current transaction is aborted, commands ignored until end of transaction block`;
`posted: 0`. Log: `red.log`.

**Reachability.** `pages/api/accounting/smart-categorize.ts:124` (`source: 'categorization'`) and
`bankImportService.ts:103,247` (`source: 'import'`). Contention on a bank row is ordinary — two
people working the same statement, or an import running while someone allocates.

**Proposed minimal fix.** Wrap the per-row body in `withSavepoint`, exactly as the rule sweep does:
`await withSavepoint('auto_post_gate_line', async () => { …existing try body… })` inside the loop,
keeping the catch outside it. Savepoint names must stay ≤31 chars. Also skip the row rather than
tag it when the savepoint rolls back.

**Historical-data impact.** No wrong rows: an aborted transaction writes nothing. The damage is
silent non-work — sweeps reported as successful that posted nothing, and `bank_auto_post_runs` rows
whose `posted_count` was never written. Read-only smell test:
`SELECT id, created_at, posted_count, total_amount FROM bank_auto_post_runs
 WHERE posted_count IS NULL OR posted_count = 0 ORDER BY created_at DESC;`

**Risks.** Savepoints per row cost a round trip each; the rule sweep already pays it at the same
cardinality (capped at 500 candidates), so this is proven-acceptable.
