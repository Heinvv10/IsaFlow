# K-010 fix — one reversal per journal entry

**Trigger.** `reverseJournalEntry` read the original, checked `entry.reversedAt`, then created and posted the contra and wrote `reversed_at` only afterwards. Two callers overlapping that window both read NULL, both cleared the guard, both posted a contra. Reachable from `POST /api/accounting/journal-entries-action` (`reverse`), the reverse MCP tool, and the invoice/credit-note/payment/provisional/payroll cancel paths — a double-click or a retry is enough.

**Before/after.** Before: two contras, the reversed accounts land at the negative of the original instead of zero. After: the reversal is claimed atomically before anything is written; the loser throws `Journal entry already reversed` having created nothing.

**Files.** `journalEntryReversalClaim.ts` (new) — `claimJournalReversal` (`UPDATE ... WHERE reversed_at IS NULL RETURNING id`, `SET LOCAL lock_timeout = '5s'` when a request transaction exists) and `releaseJournalReversalClaim`. `journalEntryPostingService.ts` — claim before `createJournalEntry`, release on create/post failure, late `reversed_at` write removed (the contra link-back UPDATE stays). Plus migration 619 and the gl `.claude.md`/`AGENTS.md`.

A predicated UPDATE rather than the `SELECT ... FOR UPDATE` the validation proposed: several callers run outside a request transaction, where `FOR UPDATE` releases at statement end and locks nothing. The UPDATE serialises in both cases; the unique index stays as the storage-layer backstop.

**Tests.** `tests/integration/k010-concurrent-journal-reversal.int.test.ts` — 3 passed against the fixture DB: the concurrent race, a sequential retry, and a cross-tenant reversal that must not touch the entry or leak a row. Each asserts one posted contra, a zero net on the reversed account, and no unbalanced journal. The barrier sits immediately after the unlocked `getJournalEntryById` and releases in arrival order, so the separate JE-entry-number collision cannot mask the defect. `red.log` / `green.log` hold both directions. Three existing unit suites moved with the extra write: `gl/journalEntryReversal.test.ts` and `journalEntryReversalPeriod.test.ts` / `journalEntryReversalDate.test.ts` now let the claim UPDATE return a row, and the dangling-draft test asserts the stronger invariant — a failed post issues no `reversal_of_id` AND releases the claim, rather than never writing `reversed_at` at all. Full unit suite: 9320 passed, 234 skipped.

**Migration / rollback.** 619 creates `ux_gl_je_reversal_of` on `(company_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL`, `IF NOT EXISTS`, applied to the fixture DB (0 pre-existing duplicates there). Rollback: `DROP INDEX ux_gl_je_reversal_of`. **Run the impact query first — existing duplicates block index creation.**

**Historical impact (read-only, not run against production from here).**
```sql
SELECT e.company_id, e.reversal_of_id, count(*) AS contras,
       array_agg(e.entry_number ORDER BY e.created_at)
FROM gl_journal_entries e
WHERE e.reversal_of_id IS NOT NULL AND e.status = 'posted'
GROUP BY 1, 2 HAVING count(*) > 1;
```

**Limits.** Does not repair existing duplicates. The claim guards `reverseJournalEntry` only; a direct `UPDATE reversed_at` elsewhere still bypasses it, which is what the index covers. The concurrent JE-entry-number collision seen while building the harness is a separate defect, untouched.
