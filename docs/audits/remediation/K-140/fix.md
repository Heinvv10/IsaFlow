# K-140 — one failed row must not abort the whole auto-post sweep

**Trigger.** Two people work the same statement, or an import runs while someone
allocates. `allocateTransaction` opens with `SELECT … FOR UPDATE` under
`SET LOCAL lock_timeout = '5s'`, outside its own `withTransaction`, so a
contended row raises a real Postgres error inside the request transaction.

**Before.** `sweep` wrapped each row in a bare `try/catch` with no savepoint.
The first Postgres error aborted the request transaction; the catch swallowed it
and carried on, so every later row failed 25P02 and reported a skip reason about
the abort rather than about itself. The final COMMIT was a rollback that threw
away the posts the sweep had already made, while the response still said success.

**After.** Each row runs inside `withSavepoint('auto_post_gate_line', …)`, as the
sibling rule sweep already did. A failed row rolls back alone; the rows around it
post and survive the COMMIT. `runId` is restored on rollback, because `ensureRun`
INSERTs the run row inside the savepoint and a rolled-back row would otherwise
leave the in-memory id pointing at a row that no longer exists. The
"JE posted but run-tag failed — JE orphaned" branch is removed: the savepoint now
takes the JE and the tag back together, so that state can no longer arise.

**Files.** `src/modules/accounting/services/bank/autoPostGateService.ts`.

**Tests.** `tests/integration/k140-autopost-sweep-no-savepoint.int.test.ts` — 3
passed against a real database (validator's case plus a later-row failure and a
declined row). `tests/unit/services/bank/autoPostGateService.test.ts` — 38 passed
(its `@/lib/neon` mock gained a pass-through `withSavepoint`). Mutation proof and
full-suite totals in `green.log`.

**Migration.** None. Prefix 652 was reserved for this item and is not used — it
is free again.

**Historical-data impact.** No wrong rows: an aborted transaction writes nothing.
The damage is silent non-work — sweeps reported as successful that posted nothing.
Read-only smell test (not run here):
`SELECT id, created_at, posted_count, total_amount FROM bank_auto_post_runs
 WHERE posted_count IS NULL OR posted_count = 0 ORDER BY created_at DESC;`

**Limits.** One savepoint round trip per row, at the same cardinality the rule
sweep already pays. If the ROLLBACK TO SAVEPOINT itself fails, `withSavepoint`
marks the context unusable and the next row fails naming that cause — correct,
but the sweep then skips its remaining rows.
