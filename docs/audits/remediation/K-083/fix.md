# K-083 — fix: a loan period posts its journals once

**Trigger.** `postPeriodJournals` validated the loan, schedule row, NCA flag and period lock and
then posted unconditionally. No lookup, no row lock, no key over
`(company_id, loan_id, period)`. A retry after a client timeout, or a second period-close over a
range already closed, doubled the interest expense and the loan-liability movement.

**Before / after.** Two sequential calls for period 1 used to produce two journals and debit
interest twice. The loan row is now taken `FOR UPDATE`, which serialises concurrent posts, and a
lookup on `company_id + loan_id + period AND reversal_of IS NULL AND journal_entry_id IS NOT NULL`
refuses the repeat by name.

**Files.** `loanGlPostingService.ts`, `scripts/migrations/sql/644_loan_gl_postings_period_once.sql`.

**Tests.** `tests/integration/k083-loan-period-journal-idempotency.int.test.ts` — 6 passed on real
PostgreSQL. `tests/unit/services/loans/loanGlPostingService.test.ts` — 12 passed.

**Mutation proof.** Removing the service lookup: 1 failed — the constraint still protects the
ledger, but the caller sees an opaque 23P01 instead of the named refusal. Removing
`journal_entry_id IS NOT NULL` from the guard: 1 failed.

**Migration.** 644, applied to the fixture database. A btree_gist EXCLUDE constraint, not a unique
index: the table holds one row per journal LINE, so it permits any number of rows for a period that
share one `journal_entry_id` and rejects a second, different one. Rollback:
`ALTER TABLE loan_gl_postings DROP CONSTRAINT loan_gl_postings_one_journal_per_period;`.

## Review dispositions

**M1 — corrected by removing the false claim, not by adding machinery.** A reversal row carries
`reversal_of`; the ORIGINAL keeps `reversal_of IS NULL` and still blocks. Reversing a GL journal
writes `gl_journal_entries` / `gl_journal_lines` only and never touches this table, so re-posting
after a reversal was never possible. The predicate cannot express "not itself reversed" — an
EXCLUDE predicate admits no subquery — and adding a `reversed_at` column for a workflow nothing in
the repo performs would be speculative. The claim is removed from the code comment, the migration
header, `.claude.md`, `AGENTS.md` and this file. The misleading test, which inserted a reversal for
a period that never had an original, is replaced by one that posts a period, marks its rows
reversed, proves the re-post is still refused, and then proves it succeeds after the rows are
deleted.

**M2 — fixed.** `fix.md` previously told the operator to reverse the extra journals, which leaves
`loan_gl_postings` untouched and the migration still refusing. The real remediation is below, and
the migration's exception now names the superseded ROW ids, not just the journal count.

**L3 — documented.** The migration header records that `CREATE EXTENSION` needs a role permitted to
create extensions (btree_gist is trusted from PG13; PG12 and older need a superuser) and that
`ADD CONSTRAINT ... EXCLUDE` holds ACCESS EXCLUSIVE on `loan_gl_postings` while it builds a GiST
index over the whole table.

**L4 — fixed.** The guard now carries `journal_entry_id IS NOT NULL`, matching the constraint
predicate, with a test that posts a period holding an orphan row with no journal id.

**L2 — acknowledged, no change.** 644 and 645 skip 627–643. Those prefixes are held by an unmerged
branch; taking the next free number defends against the known prefix race, and the lead confirmed
644 and 645 in the register.

**Historical-data impact and remediation.** Any loan period posted twice carries doubled interest
expense and a doubled liability movement. The migration refuses to install while duplicates exist
and names the rows. Remediation, in order, per named group (NOT run against production):

```sql
-- 1. identify
SELECT company_id, loan_id, period, COUNT(DISTINCT journal_entry_id) AS journals
  FROM loan_gl_postings WHERE reversal_of IS NULL AND journal_entry_id IS NOT NULL
 GROUP BY 1,2,3 HAVING COUNT(DISTINCT journal_entry_id) > 1;
-- 2. reverse the superseded GL journals through the app so the ledger is right
-- 3. delete the superseded loan_gl_postings rows the migration names, keeping
--    the earliest journal's rows for each (company_id, loan_id, period)
-- 4. re-run the migration
```

Step 3 is required: without it the rows remain and both the migration and any re-post keep
refusing.
