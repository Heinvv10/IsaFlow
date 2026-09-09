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

**L1 — fixed.** `loanPeriodCloseService.ts` is 282 lines (was 312).
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
`n_loans <> 1` is REFUSED, never guessed, and recorded in `loan_reclass_backfill_refusals` (round 3
corrected this: the round-2 claim that a `RAISE WARNING` reached a human was FALSE — see round-3 H1
below). A refused loan gets no row, so its next close reclassifies the full current portion — an
overstatement an operator can see, not a movement nobody can trace. 645 is untouched: both migrations ship in this unmerged
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
(Round 3 L3: it now THROWS when there is no request transaction rather than running unbounded, so
the bound is unconditional and the round-2 wording no longer needs its "inside a request" caveat.)

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

**Migration.** 659 (657 was reassigned to another branch), applied to the fixture through the real
runner. It adds `loan_reclass_postings.source` and the `loan_reclass_backfill_refusals` table, then
rebuilds `loan_reclass_postings` from posted reclass journals, per company, and is a no-op on an
unchanged ledger. The round-2 per-tenant abort is GONE (round-3 M1/M5): the rebuild deletes only
`source = 'backfill'`, so a row the application wrote is never at risk and the migration can always
be re-run. Rollback: none needed; re-running reproduces the same rows.

**Deploy note (unchanged).** The first close after deploy posts one correcting movement per loan, and
re-running compliance moves loans into stages 2/3.

## Review round 3 dispositions (blind review of 4ceaf1aca)

**H1 — fixed.** 659's entire safety argument was that an ambiguous loan key is refused and *named in
a WARNING for a human*. `scripts/apply-migrations.ts` calls `client.query(file.content)` on a
`pg.PoolClient` and registered no `notice` listener, so node-postgres discarded every NOTICE and
WARNING; `scripts/deploy.sh:146` runs exactly that path, so on a real deploy the operator saw
neither the refused loans nor the row count. Two changes: (1) the runner now registers
`client.on('notice', …)` and prints `[SEVERITY] message` — general, and it surfaces every other
migration's notices too; (2) 659 records each refusal as a row in `loan_reclass_backfill_refusals`
(company_id, journal_entry_id, loan_key, yyyymm, description, reason), rebuilt per tenant on every
run, because deploy console output scrolls past. Proved end to end, not by unit test: an ambiguous
loan and an unparseable description were seeded in the fixture and migration 659 applied through
`bun scripts/apply-migrations.ts` itself — operator-visible output was

```
applying 659_loan_reclass_postings_backfill_rebuild.sql ...
  [WARNING] loan_reclass_postings backfill refused to reconstruct these loans; …
  [WARNING] company_id=1111…e2 loan_key=LN-AMB reason=reference is shared by 2 loans
  [WARNING] company_id=1111…e2 loan_key=(unparsed) reason=description does not parse into a loan key and period
  [NOTICE] loan_reclass_postings rebuilt: 0 row(s) reconstructed from posted reclass journals
```

The same file run through `origin/master`'s copy of the runner printed only `ok (12ms)`.

**M1 — fixed.** The round-2 per-tenant guard made the documented "re-run 659 for that tenant"
recovery impossible: the first close after deploy writes a lock and a `loan_reclass_postings` row in
one transaction, so `locked_at >= MIN(created_at)` held forever after. `loan_reclass_postings.source`
replaces the heuristic — the rebuild deletes only its own `'backfill'` rows, so an application row is
never at risk and the guard is unnecessary. `recordReclass` writes `source = 'app'`.

**M2 — fixed.** The round-2 detection query reported loans that were reconstructed *correctly*: 659
stores one `journal_entry_id` per `(loan_id, yyyymm)`, so the second journal of a month looked
refused. Detection is now the refusals table itself, which is written from the same temp table the
INSERT reads, and therefore cannot disagree with it. The query is below.

**M3 — fixed.** Candidates are selected on the loose `description LIKE 'Reclassification%loan%'` and
anything the strict parse rejects is refused with `reason = 'description does not parse into a loan
key and period'` instead of being dropped with neither a row nor a warning. The length bound is now
`>= 35`, so a loan whose `reference` is `''` (description exactly 35 characters) reconstructs
correctly — round 2 was a regression against 645 for that loan.

**M4 — fixed.** `assertClosesInOrder` was a read-then-act check with nothing serialising it: the
later-lock read and the `loan_period_locks` INSERT sit either side of every journal post, and the PK
`(company_id, yyyymm)` only stops the same month twice, so two concurrent closes of adjacent months
both read an empty later-lock set and both posted their full current portion. It now takes
`pg_advisory_xact_lock(hashtext(company_id || ':loan_period_close'))` first, held to COMMIT.

**M5 — fixed** by the same change as M1. A close that reclassified nothing still wrote a lock and no
posting row, which tripped the round-2 guard, and because `RAISE EXCEPTION` aborts the whole `DO`
block it abandoned every OTHER tenant's rebuild and failed the deploy.

**L1 — fixed.** `loanComplianceService.ts` was 301 lines; the inlined `notes` local brings it to 299.
`loanPeriodCloseService.ts` is 282, and the round-2 claim of 278 is corrected above.

**L2 — fixed.** `SET LOCAL lock_timeout = DEFAULT` after the `FOR UPDATE` returns, on the success
path only — an error above has already aborted the transaction and a reset there would raise 25P02
over the real cause.

**L3 — fixed.** `lockLoanForUpdate` throws when `als.getStore()?.client` is absent instead of
running the `FOR UPDATE` unbounded on a pooled connection. Both callers are `withAuth` routes; the
unit tests wrap the call in `als.run`.

**L4 — fixed.** 659 refuses at the top of the rebuild unless the connected role is superuser or
`BYPASSRLS`. `loan_reclass_postings` FORCEs row level security and its only policy is `TO app_user`,
which binds the table owner too, so a lesser role would have matched zero rows in silence.

**L5 — resolved, not a risk.** `schema_migrations` on `isaflow_dev` holds no `64x`/`65x` row at all
(`SELECT name FROM schema_migrations WHERE name LIKE '64%' OR name LIKE '65%'` → 0 rows), and
production is behind this branch, so neither 645 nor 659 has been applied anywhere but the
disposable fixture. No checksum conflict is possible on deploy.

**L6 — no longer reachable.** The guard that read `loan_period_locks.locked_at` is gone (M1/M5), so
a NULL `locked_at` can no longer hide a row from it.

**Round-3 files.** `scripts/apply-migrations.ts` (notice listener only — no change to ordering,
transaction handling or error behaviour), `scripts/migrations/sql/659_…sql`, `loanPostingGuards.ts`,
`loanReclassService.ts`, `loanComplianceService.ts`, `.claude.md` + `AGENTS.md`.

**Round-3 tests.** `tests/integration/k081-loan-reclass-backfill.int.test.ts` — 11 passed (was 8;
the tenant-abort case is replaced by "an application row survives a rebuild", plus the durable
refusal record, the unparseable description and the empty reference). Now runs the WHOLE migration
file, not a slice of it. `tests/integration/k081-loan-close-ordering.int.test.ts` — 4 passed (M4).
All k081/k082/k083 integration files: 35 passed. Full unit suite with the fixture env unset: 9469
passed / 234 skipped. `tsc --noEmit` clean; `eslint` clean on the changed `src` files.

**Round-3 mutation proof.** Notice listener removed (ran the same migration through
`origin/master`'s runner): the refusals vanish from the operator's output entirely. Advisory lock
removed: `serialises two concurrent closes of adjacent months (M4)` red 3/3, green 3/3 restored.
`AND source = 'backfill'` dropped from the DELETE: the M1/M5 case red. Loose candidate filter
reverted to the round-2 strict one: the M3 and empty-reference cases red. Refusal INSERT removed:
the H1 durable-record case red.

**Refused-group detection, to run AFTER 659 (read-only, NOT run against production):**

```sql
SELECT company_id, loan_key, yyyymm, description, reason
  FROM loan_reclass_backfill_refusals
 ORDER BY company_id, yyyymm, loan_key;
```

Every row is a reclass journal 659 declined to reconstruct: a duplicate or absent reference, a
re-pointed current-portion account, or a description it could not parse. Resolve the reference, the
account mapping or the description, then re-run 659 — which is now always possible, for any tenant,
at any time. Until then that loan's next close reclassifies its full current portion: the trial
balance still balances (both legs are liabilities) but the current / non-current split is overstated
by that amount, which is an AFS misstatement rather than an out-of-balance ledger.

**Historical-data impact (round 3).** Unchanged in direction. `loan_reclass_postings` and
`loan_reclass_backfill_refusals` do not exist in production yet, so nothing existing is rewritten;
659 populates both on the deploy that first applies 645.
