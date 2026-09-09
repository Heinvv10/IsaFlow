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

**Backfill scoping and idempotency.** The INSERT runs inside a `DO` loop, once per company, with
`company_id` bound as a parameter and repeated on the `gl_journal_lines` join, the `loans` join and
the `gl_journal_entries` predicate, so no statement can read or write across tenants even if an
account or loan id were reused. It ends with `ON CONFLICT (company_id, loan_id, yyyymm) DO NOTHING`,
so re-running after a partial failure changes nothing and a row written by the running application
always wins over a reconstructed figure. It reports the row count it reconstructed as a NOTICE.
Proven on the fixture inside a rolled-back transaction: two legacy closes of 100 000 and 92 000
reconstruct to 202602 = 100 000 and 202603 = 192 000, matching the GL balance; a second run inserts
0 rows; an application-written row is left untouched by a third run; and no row lands under any
other `company_id`.

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

## Review round 2 dispositions (blind review of 33c5fd2f7)

**H1 — fixed by migration 659.** 645's backfill identified a loan by rebuilding its narrative
(`'Reclassification – loan ' || COALESCE(reference, id::text) || ' for ' || yyyymm`) and matching the
line on the loan's CURRENT `current_portion_account_id`. Neither is unique — `loans.reference` has no
unique constraint, one current-portion account serves every loan — so two loans sharing a reference
each absorbed the other's journals and `closeLoanPeriod` posted a fabricated movement off the wrong
prior. 659 extracts the key OUT of the description and resolves it against the company's loans;
`n_loans <> 1` is REFUSED, never guessed, and named in a `RAISE WARNING` for a human. A refused loan
gets no row, so its next close reclassifies the full current portion — an overstatement an operator
can see, not a movement nobody can trace. 645 is untouched: both migrations ship in this unmerged
branch, and 659 rebuilds every row 645 wrote.

**M2 — fixed.** `assertClosesInOrder` (`loanPostingGuards.ts`) refuses a close when any
`loan_period_locks` row exists for a later `yyyymm`. `fetchPriorReclass` reads the latest EARLIER
record, so closing April and then the skipped March gave March a prior of 0, posted the full current
portion, and no later close unwound it.

**M3 — fixed by 659.** Two reclass journals in one month produced two peer rows with the same
`ORDER BY` key; the running sum gave each a different total and `ON CONFLICT DO NOTHING` kept
whichever landed first (192 000 in the GL, 92 000 recorded). 659 aggregates to one row per
`(loan_id, yyyymm)` before the window.

**M4 — fixed.** `tests/integration/k081-loan-reclass-backfill.int.test.ts` runs the `DO` block out of
the migration file itself (never a copy) — 8 real-DB cases: the duplicate reference, a clean loan
alongside a refused pair, two journals in a month, the re-pointed account, the reversed entry,
cross-tenant independence of the same reference, a second run, and the tenant-named abort.

**M5 — fixed.** `lockLoanForUpdate` issues `SET LOCAL lock_timeout = '5s'` before the `FOR UPDATE`
and maps `55P03` to `LoanPostLockTimeoutError`, per `bankTxLock.ts`. Proven with two pool clients.

**L1 — fixed.** `company_id` added to the `loan_schedule_runs` lateral in `closeLoanPeriod` and to
the latest-run reads in `loanGlPostingService` and `loanComplianceService`.

**L2 — accepted, claim corrected.** `assertSkipScheduleRepayable` bounds RECURRING skips only;
`SKIP` rows in `loan_events` also skip periods and the validator never sees them, so a loan at k = 11
plus enough SKIP events can still reach the engine's 12x cap. The cap throws a named error rather
than looping, so the outcome is a refused recompute, not a hang. `loanValidation.ts`, `engine.ts`'s
message and `.claude.md` now say exactly that instead of "accept exactly the same loans".

**L3 — fixed by 659.** A loan whose current-portion account holds no line on one of its own reclass
journals has been re-pointed; 659 refuses it rather than reconstructing a history with a period
missing. Detection SQL below.

**L4 — fixed by 659.** `je.reversed_at IS NULL` excludes a reversed reclass entry, which the
description-pattern filter alone counted at full value.

**L5 — fixed.** The `computeDaysPastDue` cases asserted the removed `paid − scheduled` semantics and
passed only because `asOf` equalled `paid`. Re-pointed to the arrears-from-oldest-unsettled reading,
including a case where an early payment does NOT reduce arrears and a loop proving the first argument
does not change the answer.

**L6 — fixed.** `assertFiscalPeriodResolved` refuses to post either loan journal when
`createJournalEntry` resolved no fiscal period (date outside the ±10y/2y auto-create window). The
throw rolls the request back, so nothing posts and no lock is written. Covered by a real-DB test
closing a 2032 period.

**Migration.** 659 (657 was reassigned to another branch), applied to the fixture. No DDL — it
rebuilds `loan_reclass_postings` from posted reclass journals, per company, and is a no-op on an
unchanged ledger. It aborts, naming the tenant, if a `loan_period_locks` row exists at or after that
company's earliest `loan_reclass_postings` row (the application has written there since the
backfill). Rollback: none needed; re-running reproduces the same rows.

**Deploy note (unchanged).** The first close after deploy posts one correcting movement per loan, and
re-running compliance moves loans into stages 2/3.

**Refused-group detection, to run AFTER 659 (read-only, NOT run against production):**

```sql
SELECT e.company_id, e.description
  FROM gl_journal_entries e
 WHERE e.description LIKE 'Reclassification – loan % for %'
   AND e.status = 'posted' AND e.reversed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM loan_reclass_postings r
                    WHERE r.company_id = e.company_id AND r.journal_entry_id = e.id)
 ORDER BY 1, 2;
```

Every row is a loan 659 refused — a duplicate/absent reference, or a re-pointed current-portion
account. Resolve the reference or the account mapping, then re-run 659 for that tenant.

**Limits (round 1, superseded above).** A loan whose `reference` was renamed after a close will not match the backfill's
narrative join and gets no row for that month; its next close then reclassifies from the last month
that did match. Find them with:

```sql
SELECT e.company_id, e.description FROM gl_journal_entries e
 WHERE e.description LIKE 'Reclassification – loan % for %'
   AND NOT EXISTS (SELECT 1 FROM loan_reclass_postings r
                    WHERE r.company_id = e.company_id AND r.journal_entry_id = e.id);
```
