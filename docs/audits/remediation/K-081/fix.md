# K-081 — fix: the loan reclass posts the movement, not the whole balance

**Trigger.** `closeLoanPeriod` handed `buildReclassificationInput` the schedule row's whole
`st_liability` every month and nothing reversed the prior month, so after N closes the
current-portion account held the sum of N snapshots.

**Before / after.** Before, February posted its full twelve-month figure on top of January's.
After, the journal carries only `stLiability − priorStLiability`, reversed in direction when the
current portion falls and empty when it is unchanged. Both legs are liabilities, so no total moves,
only the current / non-current split.

**`prior` is read from what was posted, never inferred.** Migration 645 adds
`loan_reclass_postings`, written by `closeLoanPeriod` at the moment a reclass posts.

**Files.** `loanPeriodCloseService.ts`, new `loanReclassService.ts`,
`scripts/migrations/sql/645_loan_reclass_postings.sql`.

**Tests.** `tests/unit/services/loans/loanPeriodClose-k081-reclass-compounds.test.ts` — 8 passed.
`tests/integration/k081-loan-reclass-movement.int.test.ts` — 7 passed on real PostgreSQL.

**Mutation proof.** Full amount instead of the movement: unit 4 failed. Prior read off any earlier
lock (H2): integration 2 failed. Prior read off the latest schedule run (M3): integration 7 failed.

**Migration.** 645, applied to the fixture database. Creates the table under RLS and backfills it
from the reclass journals already posted, matching `closeLoanPeriod`'s deterministic narrative
exactly. Rollback: `DROP TABLE loan_reclass_postings;`.

## Review dispositions

**H2 — fixed.** A lock is written unconditionally, after the `missing GL accounts`, `no schedule
row` and zero-movement skips, so it was never evidence that THIS loan was reclassified. Reading a
prior off one drove the current-portion account to a debit balance that never self-corrected. The
new table carries no row when nothing posted. The reviewer's skip-then-close probe is now a test in
both suites.

**M3 — fixed.** The lateral read the LATEST schedule run, so a reprice between two closes restated
the earlier month. The recorded figure cannot move. Covered by a real-DB test that inserts a newer
run over an already-closed month.

**L1 — fixed.** `loanPeriodCloseService.ts` is 278 lines (was 312).
`loanComplianceService.ts` 299 (was 359) and `loanService.ts` 265 (was 386) via
`loanArrearsService.ts`, `loanValidation.ts` and `loanTypes.ts`. Every file in the module is now
under 300.

**Historical-data impact.** The backfill reconstructs the compounded balance the old code actually
left, so the FIRST close after deploy posts one large correcting movement that returns the account
to the right figure. Verified on the fixture: two legacy closes of 100 000 and 92 000 backfill to a
recorded balance of 192 000, which is what the GL holds. This changes the current / non-current
split in the period of the correction. Read-only detection, NOT run against production:

```sql
SELECT l.company_id, l.id AS loan_id, count(*) AS closes_posted
FROM loan_gl_postings p JOIN loans l ON l.id = p.loan_id AND l.company_id = p.company_id
GROUP BY 1,2 HAVING count(*) > 1;
```

**Limits.** A loan whose `reference` was renamed after a close will not match the backfill's
narrative join and gets no row for that month; its next close then reclassifies from the last month
that did match. Find them with:

```sql
SELECT e.company_id, e.description FROM gl_journal_entries e
 WHERE e.description LIKE 'Reclassification – loan % for %'
   AND NOT EXISTS (SELECT 1 FROM loan_reclass_postings r
                    WHERE r.company_id = e.company_id AND r.journal_entry_id = e.id);
```
