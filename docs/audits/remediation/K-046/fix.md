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
- `src/modules/accounting/services/gl/yearEndJournalPoster.ts` — NEW. The write, the period lock, `validateJournalEntry` before either, and the dormant/already-closed branch. Split out of `yearEndCloseService.ts` to stay under 300 lines.
- `src/modules/accounting/services/gl/yearEndCloseService.ts` — delegates the write; `CloseYearResult` gains `periodsLocked` and `alreadyClosed`, and `closingEntry` is nullable.
- `pages/api/accounting/year-end.ts` — `no_fiscal_period` and `period_range_mismatch` cases, plus a `never` default so the switch stays exhaustive over `CloseYearError`.
- `src/lib/mcp/tools/writeFiscalPeriods.ts` — `year_end_close` reports a null journal id for a dormant year instead of throwing on it.
- `src/modules/accounting/services/gl/.claude.md` + `AGENTS.md` — module rule + recent-changes entry.
- `src/modules/accounting/types/gl.types.ts` — `'year_end'` added to `GL_ENTRY_SOURCES`.
- `tests/unit/services/glEntrySourceConstraint.test.ts` — `year_end` off the dead list, pinned to the new guard.
- `scripts/migrations/sql/627_gl_je_source_year_end.sql` — new.

**Tests.** `tests/integration/k-046-year-end-contra-balance-negative-debit.int.test.ts` (3, the
validator's RED file) and `tests/integration/k-046-year-end-close-adjacent.int.test.ts` (6:
contra revenue end-to-end with balance/retained-earnings/lock assertions, second tenant
untouched, re-run reports the existing journal, contra EXPENSE mirror, BREAK-EVEN year, DORMANT
year) — 9 passed on real Postgres. `tests/unit/services/glEntrySourceConstraint.test.ts` (6),
`tests/unit/services/yearEndClosePostingGuard.test.ts` (3, NEW — behavioural cover for the
guard the source-text pin only greps) and `tests/unit/services/gl/yearEndInsertColumnsDb.test.ts`
(3) — 12 passed. Full unit suite 9438 passed, 0 failed. Four mutations each go RED; see
`green.log`.

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

**Review follow-up (blind review of `3222d0a6` + `c16abdde`).** HIGH-1 fixed: a BREAK-EVEN year
appended a `debit: 0, credit: 0` retained-earnings line that `validateJournalEntry` refuses, and
a DORMANT year produced an empty journal — neither could close. The retained line is now omitted
when the rounded result is zero, and a year with no lines at all locks its periods and writes no
journal. MEDIUM-1 answered as a stated exemption, not a change: the close deliberately does not
apply `assertNoInactiveAccountLines`, because closing a withdrawn account is how its balance is
zeroed and refusing would strand the tenant forever; the equity side needs no exemption because
`systemAccountResolver` caches only `is_active = true` accounts. The reason is written into the
poster, the module doc and the constraint test's rationale. MEDIUM-2 fixed in the route.
LOW-1 fixed: 627 is `NOT VALID` (the new list is a strict superset of the enforced old one, so
the ACCESS EXCLUSIVE scan buys nothing). LOW-2: 627 re-checked against `origin/master`
(`53539623`) and still free. LOW-3 fixed by the new behavioural unit test. LOW-4 fixed.
LOW-5: `origin/master` merged into the branch before the final gate run.

**Limits.** K-113 (no already-closed guard) is NOT fixed and was not in scope. The dry run of an
already-closed year still reports a false zero. A LIVE re-run no longer fails and no longer
masquerades as a dormant year: the poster looks the year's journal up by entry number and
returns it with `alreadyClosed: true`. No second journal is written; the adjacent test pins that. Once the close actually writes, running it LOCKS every period in the year — run
`dryRun` per company and read the preview before any live close.
