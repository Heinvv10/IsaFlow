# K-071 — best-effort SQL after a bank import has no savepoint

**Claim.** A failure in the post-import statement aborts the whole import transaction.
(`bankImportService.ts:219`, audited at `5661d6f0`.)

**Corrected trigger.** Line 219 is now the transfer-link call, and that half was fixed by the
merged K-019 work: `bankTransferLinkPasses.ts:69` runs both passes inside `withSavepoint` and
reports `failed` upward. What is still unguarded is the auto-post sweep at
`origin/master:src/modules/accounting/services/bank/bankImportService.ts:236-251` — a bare
`try { … await sweep(…) } catch { log.warn(…) }` with no savepoint.

**Disposition: confirmed.**

**Reachability.** `importParsedTransactions` is called from `pages/api/accounting/bank-transactions-bulk-commit.ts:266`,
`pages/api/accounting/bank-feeds/[id]/extension-ingest.ts:183`, `bankStatementImportService.ts:215`
and `src/lib/mcp/tools/writeBankImport.ts` — all request-scoped, so `als` holds an open
transaction (`src/lib/neon.ts:102-109`). `withTransaction` at :173 runs the batch insert in a
SAVEPOINT on that same client, so the import rows live in the request transaction, not a
separate one. A SQL error inside the swallowed sweep block therefore aborts the request
transaction; the catch hides it, the function returns a `batchId` with an empty error list, and
`withAuth`'s COMMIT is answered by Postgres with a ROLLBACK. Outside a request (cron, scripts)
`sql` autocommits and the failure really is non-fatal.

**Evidence (executed).** `tests/integration/k071-bank-import-best-effort-savepoint.int.test.ts`,
real PostgreSQL fixture. The sweep is mocked to run one failing query on the request client.
Result: 1 test, 1 failed. `transactionCount = 1`, COMMIT raised nothing, and
`bank_import_batches` / `bank_transactions` both held **0 rows**. The swallowed `22012` appears
in the captured log. Output: `red.log`.

**Code-state caveat.** This worktree branch predates the K-019 merge, so its
`bankImportService.ts` still has the old inline transfer-link SQL. The sweep block under test is
byte-identical to `origin/master:236-251` (verified with `diff`), so the result transfers.

**Proposed minimal fix.** In `bankImportService.ts`, wrap the auto-post block in
`withSavepoint('bank_import_autopost', …)` from `@/lib/neon`, exactly as
`bankTransferLinkPasses.ts:69` does, and surface a `failed` flag into the returned `errors`
array so a swallowed sweep failure is reported rather than only logged.

**Historical-data impact.** No corrupt rows: the failure mode is total loss, not partial write.
Affected imports left nothing behind, so they are invisible in the data. The only trace is the
log line `auto-post sweep failed after parsed import — non-fatal`; grep production logs for it
and reconcile those statements against `bank_import_batches`.

**Risks.** The sweep posts journals; a savepoint rolls those back while keeping the import,
which changes today's accidental all-or-nothing outcome.
