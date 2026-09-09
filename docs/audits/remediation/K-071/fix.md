# K-071 fix — savepoint around the post-import auto-post sweep

**Trigger.** `importParsedTransactions` ran the auto-post sweep in a bare `try/catch` that logged
failures as "non-fatal". Inside a request there is no separate connection: `withAuth` holds the
transaction on the ALS-bound client and `withTransaction` puts the batch in a SAVEPOINT on that
same client. A SQL error in the swallowed block aborts the REQUEST transaction, the catch hides it,
the function returns a `batchId` with an empty error list, and the COMMIT that follows is executed
by Postgres as a ROLLBACK. The whole import is silently lost.

**Before / after.** Before: a failing sweep discarded the import and the caller was told it
succeeded. After: the sweep runs inside `withSavepoint('bank_import_autopost', …)`, so its failure
rolls back only its own work, the import survives, and the failure reaches the caller in `errors`
instead of living only in a log line.

**Files.** `src/modules/accounting/services/bank/bankImportService.ts` (savepoint +
`autoPostErrors`); `tests/unit/services/bank/bankImportService.bulk.test.ts` (`withSavepoint`
pass-through mock, 1 new test); `tests/integration/k071-bank-import-best-effort-savepoint.int.test.ts`
(1 test); `tests/integration/k071-bank-import-autopost-adjacent.int.test.ts` (3 adjacent tests —
reported failure, a second company imported in the same request transaction, clean import when the
sweep succeeds).

**Tests.** 4 integration tests on the real PostgreSQL fixture, 1 new unit test, full unit suite
9439 passed. Mutation proof in `green.log`: removing the savepoint turns all 4 red.

**Migration / rollback.** None. Rollback is a straight revert of the service change.

**Historical-data impact.** No corrupt rows: the failure mode was total loss, not a partial write,
so affected imports left nothing behind and are invisible in the data. Detection is a log grep, not
SQL — `journalctl -u isaflow --since '30 days ago' | grep 'auto-post sweep failed after parsed
import'` — then check each logged `batchId` against `bank_import_batches`; one that appears in the
log but not the table is a lost import.

**Limits.** The savepoint changes today's accidental all-or-nothing outcome: a sweep failure now
leaves the transactions imported but unposted, which is what the new error message says.
