# K-010 fix — one reversal per journal entry, and it cannot outlive its contra

**Trigger.** `reverseJournalEntry` read the original, checked `entry.reversedAt`, then created and posted the contra and wrote `reversed_at` only afterwards. Two callers overlapping that window both read NULL, both cleared the guard, both posted a contra. Reachable from `POST /api/accounting/journal-entries-action` (`reverse`), the reverse MCP tool, and the invoice/credit-note/payment/provisional/payroll cancel paths — a double-click or a retry is enough.

**Before/after.** Before: two contras, the reversed accounts land at the negative of the original instead of zero. After: the reversal is claimed atomically before anything is written, inside a transaction that also carries the contra; the loser throws `Journal entry already reversed` having created nothing.

**Why the claim needs its own transaction.** `reversed_at IS NOT NULL` is read as "this entry is reversed" by `gl/auditTrailLedgerService`, `gl/auditTrailAttribution`, `bank/agentActivityService`, `gl/reclassification/batchService`, `items/depreciationRunPlan` (which EXCLUDES such an entry from a run) and `ap/supplierPaymentWorkflowService` (which SKIPS the reversal it owes). A claim stranded by a crash would make all of them describe an un-reversed journal as reversed. `withReversalTransaction` runs on the request transaction when there is one and opens its own otherwise (`scripts/fixes/reverse-cancelled-invoice-journals.ts` and cron paths have none), so claim and contra commit together or not at all. Widening the predicate to "reclaimable when no contra exists" was rejected: outside a transaction the winner's claim commits before its contra exists, so the second caller would re-evaluate it as true and reopen the race.

**Files.** `journalEntryReversalClaim.ts` (new) — `withReversalTransaction`, `claimJournalReversal` (predicated UPDATE, 5s `lock_timeout` set and restored), `releaseJournalReversalClaim` (best-effort, cannot displace the error that reached it). `journalEntryReversalDate.ts` (new) — `resolveReversalDate` moved out unchanged, which brings the posting service to 298 lines, inside the 300 cap. `journalEntryPostingService.ts` — claim before `createJournalEntry`; release only when the failed contra was actually deleted; `ux_gl_je_reversal_of` violations mapped to the same wording. `src/lib/neon.ts` — `getPool` exported for the transaction above. Plus migration 619 and the gl `.claude.md`/`AGENTS.md`.

**Tests.** `k010-concurrent-journal-reversal.int.test.ts` (3) — the race, a sequential retry, a cross-tenant reversal. `k010-reversal-claim-atomicity.int.test.ts` (4) — the claim is invisible to another connection while the reversal is in flight, a failed post leaves no claim/draft/contra and the entry still reversible, the in-request path restores the `lock_timeout` it borrowed, and a second request-scoped reversal is refused. `tests/unit/services/gl/journalEntryReversalClaim.test.ts` (4) — no-transaction refusal, `55P03` mapped to a retryable error, timeout restored on failure, winner/loser from the returned rows. Three existing reversal suites moved with the new write order; the dangling-draft case is now two tests, one per branch of the release. `red.log` / `green.log` hold both directions.

**Migration / rollback.** 619 creates `ux_gl_je_reversal_of` on `(company_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL` and drops the now-redundant `idx_gl_je_reversal_of`. It opens with a `DO` block that RAISES a named exception listing the duplicate count, so a book already carrying duplicates fails with something an operator can act on instead of a bare index error. Proven both ways on the fixture DB: seeded duplicates → `K-010: 1 journal entr(ies) already carry more than one contra (2 contra rows)`; clean table → `DO / CREATE INDEX / DROP INDEX`. Rollback: `DROP INDEX ux_gl_je_reversal_of` and recreate `idx_gl_je_reversal_of`.

**Required deploy steps, in order.**
1. Run the duplicate probe below against production. If it returns rows, repair them before deploying; the migration will refuse otherwise.
2. `CREATE UNIQUE INDEX` here is NOT concurrent and holds a SHARE lock on `gl_journal_entries` for the build, blocking writes. `scripts/apply-migrations.ts` wraps each file in `BEGIN`/`COMMIT`, so `CONCURRENTLY` cannot run through the runner. Either apply after hours, or build the index out of band with `CONCURRENTLY` first and let `IF NOT EXISTS` make the migration a no-op. The migration header carries both paths.
3. Run the stuck-claim probe after deploying, as an ongoing check.

**Historical impact (read-only, not run against production from here).**
```sql
-- 1. Entries reversed twice: their accounts sit at the negative of the original.
SELECT e.company_id, e.reversal_of_id, count(*) AS contras,
       array_agg(e.entry_number ORDER BY e.created_at)
FROM gl_journal_entries e
WHERE e.reversal_of_id IS NOT NULL AND e.status = 'posted'
GROUP BY 1, 2 HAVING count(*) > 1;

-- 2. Claims with no contra behind them: entries the ledger reports as reversed
--    that were never reversed. None can predate this change, but run it after
--    deploying — it is the detector for the failure mode the claim introduces.
SELECT e.company_id, e.id, e.entry_number, e.reversed_at, e.reversed_by
FROM gl_journal_entries e
WHERE e.reversed_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM gl_journal_entries c
                  WHERE c.company_id = e.company_id AND c.reversal_of_id = e.id);
```

**Limits.** Does not repair existing duplicates, and ships no repair script for them. The claim guards `reverseJournalEntry` only; a direct `UPDATE reversed_at` elsewhere still bypasses it, which is what the index covers. If `postJournalEntry` throws after its status UPDATE has landed, a posted contra survives with `reversal_of_id` NULL — the index cannot see it, so the claim is deliberately KEPT and the orphan logged rather than cleared for a retry that would post a second one. The concurrent JE-entry-number collision seen while building the harness is a separate defect, untouched.
