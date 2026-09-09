# K-046 + R-027 fix — the year-end close can run at all, and survives a contra balance

**Trigger.** Two defects, both on `closeFiscalYear`.
R-027: `postClosingJournal` writes `source = 'year_end'`, which
`gl_journal_entries_source_check` never listed, so EVERY close of EVERY company aborted with
23514 at the header INSERT. K-046: `buildPreview` copied the SIGNED net balance straight into
`debit` (revenue) or `credit` (expense), so a P&L account carrying a contra balance produced
`debit: -500` and `gl_journal_lines_debit_check` rejected it with 23514.

**Before / after.** Before: no company could close a year; after admitting the source, any
tenant with one contra P&L account still could not. After: the close posts a balanced journal,
the side of each closing line comes from the SIGN of the net balance, retained earnings takes
the year's result, and every period in the year locks.

**The guard the constraint was providing.** Migration 509 excluded `'year_end'` on purpose:
this path INSERTs at `status='posted'` without `validateJournalEntry`, and `trg_gl_je_balanced`
is BEFORE UPDATE only, so nothing checked the result. Converting to
`createJournalEntry`/`postJournalEntry` is not available — the close requires every period
CLOSED and `postJournalEntry` refuses a period that is not OPEN. So `postClosingJournal` now
runs `validateJournalEntry` over the preview lines itself, before the transaction opens.
`'opening_balance'` and `'bank_transfer'` stay excluded on the original 509 grounds.

**Files.**
- `src/modules/accounting/services/gl/yearEndJournalBuilder.ts` — side from sign, both directions.
- `src/modules/accounting/services/gl/yearEndCloseService.ts` — `validateJournalEntry` before the write.
- `src/modules/accounting/types/gl.types.ts` — `'year_end'` added to `GL_ENTRY_SOURCES`.
- `tests/unit/services/glEntrySourceConstraint.test.ts` — `year_end` off the dead list, pinned to the new guard.
- `scripts/migrations/sql/627_gl_je_source_year_end.sql` — new.

**Tests.** `tests/integration/k-046-year-end-contra-balance-negative-debit.int.test.ts` (3, the
validator's RED file) and `tests/integration/k-046-year-end-close-adjacent.int.test.ts` (4, new:
contra revenue end-to-end with balance/retained-earnings/lock assertions, second tenant
untouched, second close, contra EXPENSE mirror) — 7 passed on real Postgres.
`tests/unit/services/glEntrySourceConstraint.test.ts` — 6 passed. Full unit suite 9435 passed.
Three mutations each go RED; see `green.log`.

**Migration / rollback.** 627 drops and re-adds `gl_journal_entries_source_check` with the live
list plus `'year_end'`; idempotent, no data change. Rollback = re-apply 509 — safe only while
no closing journal has been written, since afterwards the constraint would reject existing rows.

**Historical data.** No wrong rows exist: every close failed inside `withTransaction` and rolled
back, so no `source='year_end'` row and no negative debit was ever committed. The damage is the
ABSENCE of closing journals — retained earnings is a computed residual and periods that should
be locked are not. Read-only query listing companies with a closed fiscal year and no closing
journal (NOT run against production):

```sql
SELECT fp.company_id, fp.fiscal_year,
       count(*) FILTER (WHERE fp.status = 'locked') AS locked_periods,
       count(*) AS periods
FROM fiscal_periods fp
WHERE fp.status IN ('closed', 'locked')
  AND NOT EXISTS (
    SELECT 1 FROM gl_journal_entries je
    WHERE je.company_id = fp.company_id
      AND je.source = 'year_end'
      AND je.entry_number = 'YE-' || fp.fiscal_year::text
  )
GROUP BY fp.company_id, fp.fiscal_year
ORDER BY fp.company_id, fp.fiscal_year;
```

**Limits.** K-113 (no already-closed guard) is NOT fixed and was not in scope. It still
reproduces in changed form: the dry run of an already-closed year still reports a false zero,
and the live call still fails rather than reporting the state — it now throws the
`validateJournalEntry` refusal (a one-line zero journal) instead of reaching 23505 on
`uq_gl_je_company_entry_number`. No second journal is written either way; the adjacent test
pins that. Once the close actually writes, running it LOCKS every period in the year — run
`dryRun` per company and read the preview before any live close.
