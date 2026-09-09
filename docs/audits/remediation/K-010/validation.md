# K-010 — two concurrent reversals of one journal entry both succeed

**Claim (audit B F07):** the original journal is not locked before the reversal check, so two
reversals post and leave a net opposite movement.

**Disposition: confirmed** (as stated).

**Mechanism.** `reverseJournalEntry` (`git show ebeac9ca:src/modules/accounting/services/gl/journalEntryPostingService.ts`)
reads the original at line 241 via `getJournalEntryById` — a plain SELECT, no `FOR UPDATE` — and
guards on `entry.reversedAt` at line 247. The `reversed_at` write only happens at lines 325-329,
after `createJournalEntry` and `postJournalEntry` have already run. Two requests that both read
before either writes both clear the guard. Nothing in the schema catches it: `\d gl_journal_entries`
on the fixture DB shows no unique index on `reversal_of_id` (only `uq_gl_je_company_entry_number`),
and `gl_journal_entries_reversal_of_id_fkey` is a plain FK.

**Reachability.** `POST /api/accounting/journal-entries-action` (action `reverse`), the MCP tool
`reverseJournalEntryTool`, plus internal callers in `customerInvoiceCancelService`,
`creditNoteCancelService`, `customerPaymentAllocationService`, `provisionalDismissService` and
`payrollJournalPostingService`. Two browser tabs, a retry, or an MCP call overlapping a UI click
is enough. File unchanged between 5661d6f0 and ebeac9ca.

**Evidence.** RED test `tests/integration/k010-concurrent-journal-reversal.int.test.ts`
(1 test / 1 failed, twice in a row — `docs/audits/remediation/K-010/red.log`). It interleaves two
real `reverseJournalEntry` calls with a barrier inside `createJournalEntry`, so both are past the
`reversedAt` guard before either writes. Result: `expected [ 'posted a reversal', 'posted a
reversal' ] to have a length of 1 but got 2` — two contras posted, the R100 cash debit ends at
-R100 rather than 0.

**Proposed minimal fix** (`journalEntryPostingService.ts`, in `reverseJournalEntry` before line 241):
- Take the row lock first on the request-scoped client:
  `SELECT reversed_at FROM gl_journal_entries WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID FOR UPDATE`
  (bare `sql`, not `withTransaction` — the comment at lines 320-324 explains why), then re-check
  `reversed_at` from that locked read rather than from the unlocked `getJournalEntryById` row.
- Back it with a migration adding
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_gl_je_reversal_of ON gl_journal_entries(company_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL`,
  so the second link-back UPDATE fails and rolls the duplicate contra back even for callers running
  outside a request transaction.

**Historical-data impact.** Any entry reversed twice has driven its accounts to the negative of the
original. Read-only probe:
```sql
SELECT company_id, reversal_of_id, count(*) AS contras
FROM gl_journal_entries
WHERE reversal_of_id IS NOT NULL AND status = 'posted'
GROUP BY 1, 2 HAVING count(*) > 1;
```
Run this before adding the unique index — existing duplicates would block index creation.

**Risks.** The `FOR UPDATE` serialises concurrent reversals of the SAME entry only. Outside a
request transaction (cron, scripts) the bare `sql` lock releases at statement end, which is why the
unique index is part of the fix rather than optional.
