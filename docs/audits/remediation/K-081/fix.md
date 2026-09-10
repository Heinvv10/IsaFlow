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

## Round-4 dispositions (blind review of `259c45453`: 0 HIGH, 2 MEDIUM, 7 LOW)

**M1 — fixed.** `assertClosesInOrder` now throws unless `als.getStore()?.client` is present, the
same line `lockLoanForUpdate` takes. `pg_advisory_xact_lock` on a pooled connection is released the
instant it is taken, so the guard was present in the source and serialised nothing outside a request
transaction. The one in-repo caller on that path, `scripts/simulate-fy2026-workflows.ts`, now runs
each close inside a real `als.run` + BEGIN/COMMIT, the shape `scripts/ap-backfill-supplier-payments.ts`
uses.

**M2 — fixed.** `closeLoanPeriod` takes the ordering guard (and with it the company's advisory lock)
BEFORE the `isPeriodLocked` read. Two concurrent closes of the SAME month previously both read it
unlocked, and the loser re-created and re-posted the whole month's reclass journals before the
`loan_period_locks` PK rejected it ~60 lines later — a raw 23505 instead of the named error.

**L1 — fixed.** `hashtextextended(company_id, 621)` replaces `hashtext(company_id || ':…')`. 621 is
this feature's tag; 617/619/620 are taken by whatsapp-inbox, opening-balance and goods-received.

**L2 — fixed.** The notice listener now drops a `NOTICE` that carries a non-`00000` SQLSTATE — that
is Postgres' own `IF NOT EXISTS` chatter (42P07/42710/42704), 1 946 clauses across the corpus. A
migration's own `RAISE NOTICE` defaults to `00000` and survives; `WARNING` and above are never
filtered. Proven end-to-end on a scratch database against the real runner: the round-3 listener
prints `relation "…" already exists, skipping`, the round-4 one does not, and both the probe's
`RAISE NOTICE` and `RAISE WARNING` come through in both.

**L3 — fixed.** The refusal WARNING aggregates at most 50 distinct lines and appends
`… and N more; see loan_reclass_backfill_refusals`. Every refusal is still a row in that table.

**L4 — fixed.** The rebuild's per-tenant loop is driven from
`SELECT company_id FROM loans UNION SELECT company_id FROM loan_reclass_backfill_refusals`, so a
company whose last loan was deleted is revisited and its stale refusals cannot read as current.

**L5 — closed by outcome.** The shared fixture now holds no `schema_migrations` row matching `65%`
(verified: only 621/622/624 remain), so no runner there can silently skip 659. The two tables are
left in place, empty — the K-081 integration suites need them outside their own transactions, and
659 is idempotent, so their presence costs nothing.

**L6 — fixed.** The notice listener is captured in a named const and removed in the outer `finally`
next to `client.release()`.

**L7 — fixed.** The M4 test polls `pg_stat_activity` for a backend blocked by the holder's PID
instead of sleeping 750 ms, and captures the close's outcome into a settled-result object so its
rejection is never briefly unhandled.

**Round-4 files.** `loanPostingGuards.ts`, `loanPeriodCloseService.ts`, `scripts/apply-migrations.ts`,
`scripts/migrations/sql/659_…sql`, `scripts/simulate-fy2026-workflows.ts`, `.claude.md` + `AGENTS.md`,
and the three test files below.

**Round-4 tests.** New `tests/integration/k081-loan-close-concurrency.int.test.ts` (M1/M2) — 3
passed. New `tests/integration/k081-loan-reclass-refusal-sweep.int.test.ts` (L3/L4) — 2 passed.
`k081-loan-close-ordering.int.test.ts` reworked for L7 — 4 passed. All k081/k082/k083 integration
files: 41 passed. `tests/unit/services/loans/`: 124 passed. Full unit suite with the fixture env
unset: 9469 passed / 234 skipped, 0 failed. `tsc --noEmit` clean; `eslint` clean on the changed
`src` files; `agent-docs:check`, `audit-migration-naming`, `check-migration-rls` and
`check-internal-apis` all OK.

**Round-4 mutation proof.** Each mutation applied to the working tree, run, then restored (the
restored tree is byte-identical to the pre-mutation diff). M1 assert removed → `refuses to close
outside a request transaction (M1)` red. `assertClosesInOrder` moved back below `isPeriodLocked` →
the M2 case red with exactly the defect's signature, `duplicate key value violates unique constraint
"loan_period_locks_pkey"` instead of `Period 202603 is already locked`. `hashtextextended` reverted
to `hashtext` → the M4 ordering case red (the holder no longer blocks it). The `UNION` reverted to
`SELECT DISTINCT company_id FROM loans` → the L4 sweep case red. `ORDER BY 1 LIMIT 50` removed →
the L3 case red.

**Deploy notes (unchanged in substance).** `deploy.sh` applies migrations before the service
restart, so 645 and 659 land before any code reads `source`. The first close after deploy posts one
correcting movement per loan; re-running compliance moves loans into stages 2/3; and a loan 659
REFUSED gets no `loan_reclass_postings` row, so its next close reclassifies the full current
portion — overstating the current / non-current split until its refusal is resolved and 659 re-run.

---

## Round 5 review (0 HIGH, 2 MEDIUM, 3 LOW) — dispositions

**M1 — fixed.** 659 resolved a loan per JOURNAL, so a loan whose `reference` changed between two
closes had its earlier journals refused ("no loan carries this reference") while its later ones
reconstructed: the running sum started at the rename and the recorded prior was lower than the
current-portion account held. Reproduced (GL 192 000, row 92 000). 659 now carries each refusal
from the journal to the LOAN via a `tmp_k081_tainted` temp table: any journal that could not be
attributed to a loan — unparsed, or a key no loan carries — taints every loan whose
`current_portion_account_id` that journal moved, and a tainted loan is refused rather than
reconstructed from the part of its history that resolved. `n_loans > 1` needs no taint rule: a
loan's key is the single-valued `COALESCE(reference, id::text)`, so an ambiguous loan's every
journal carries that same ambiguous key and is already excluded. Refusal is scoped by ACCOUNT, not
by company — a loan on its own current-portion account, or one an ambiguous key names but an orphan
never touched, still reconstructs. 659's and 645's stale headers ("gets no row for that month; its
next close then reclassifies from the last month that did match") are corrected.

**M2 — fixed.** 645's backfill now returns early when `loan_reclass_postings.source` exists, i.e.
when 659 has already rebuilt the table. Without it, a database that ran 659 and then lost its
`schema_migrations` rows (a restored dump, a hand-rolled clone — and the shared fixture was exactly
in that state) re-ran 645's defective narrative rebuild, and because 659 leaves the column
DEFAULTing to `'app'` the fabricated rows came back stamped as application writes that 659's
`DELETE … WHERE source = 'backfill'` can never remove. The guard keys off the schema, not the
tracking row, so it holds on any database. The fixture's tracking rows for 644/645/659 were also
recorded with their file checksums.

**L1 — fixed.** The notice filter dropped every NOTICE with a non-zero SQLSTATE, which also
swallowed `identifier "…" will be truncated` (42622 — an object created under a different name than
written) and any migration's own `RAISE NOTICE … USING ERRCODE`. It now filters exactly 42P07,
42710 and 42701 (the `IF NOT EXISTS` chatter). The comment's claim that 42704 was filtered was
wrong — `DROP … IF EXISTS` notices carry 00000 and always printed — and is gone.

**L2 — fixed.** `scripts/apply-migrations.ts` was 306 lines, over the 300-line cap. The notice
listener and its rationale moved to `scripts/migrationNoticeListener.ts` (46 lines); the runner is
back to 290 and the filter is now unit-testable.

**L3 — fixed.** The M4 ordering case proves the close waits on a peer holding the same key, but its
holder hard-codes `hashtextextended(…, 621)`, so the `hashtext` mutation went red only because the
two sides stopped agreeing — the property L1 actually addresses (a 2^32 collision with
`shareLinkService` / `mcp/audit`) was untested. New
`tests/integration/k081-loan-lock-keyspace.int.test.ts` asserts it by outcome: a foreign
`hashtext(company)::bigint` lock held on the SAME company must not hold the close up. Under the
mutation it fails with `canceling statement due to statement timeout`.

**Round-5 files.** `scripts/migrations/sql/659_…sql`, `scripts/migrations/sql/645_…sql`,
`scripts/apply-migrations.ts`, new `scripts/migrationNoticeListener.ts`, new
`tests/integration/k081-loan-reclass-rename-hole.int.test.ts`, new
`tests/integration/k081-loan-lock-keyspace.int.test.ts`, new
`tests/unit/scripts/migrationNoticeListener.test.ts`.

**Round-5 tests.** k081-loan-reclass-rename-hole — 7 passed; k081-loan-lock-keyspace — 1 passed;
migrationNoticeListener unit — 7 passed. All ten k081/k082/k083 integration files: 49 passed. Full
unit suite with the fixture env unset: **9476 passed / 234 skipped, 0 failed** (833 files).
`bun run type-check` clean; `eslint` clean on the changed `src` files; `agent-docs:check` OK (74
mirrors); `check-migration-rls` OK.

**Round-5 mutation proof.** Each applied, run, restored byte-identical. (1) tainted-loan exclusion
removed from the posting INSERT → 4 of 7 rename-hole cases red. (2) the unattributable-journal taint
INSERT removed → 4 red. (3) the taint narrowed to `n_loans = 0`, ignoring unparsed journals → the
unparsed-hole case red. (4) 645's `IF EXISTS … RETURN` guard removed → the M2 case red. (5) the
notice filter reverted to "any non-00000 NOTICE" → the two L1 unit cases red. (6)
`hashtextextended` → `hashtext` in `loanPostingGuards.ts` → the key-space case red with
`canceling statement due to statement timeout`.

**Historical impact (unchanged).** `origin/master` still carries no 644/645/659, so production has
never applied them and no `loan_reclass_postings` row exists anywhere but a fixture. After deploy,
review what the rebuild refused before trusting any close:
`SELECT company_id, loan_key, yyyymm, reason FROM loan_reclass_backfill_refusals ORDER BY 1,3;`
A refused loan reclassifies its full current portion at its next close — visible and correctable —
until the underlying journal is repaired and 659 re-run.

**Limits.** Taint is per current-portion account, so one unattributable journal on an account shared
by many loans refuses all of them. That is deliberate: the alternative is reconstructing a prior
that may be missing a movement. The refusals table names the offending journal in every case.

---

## Round 6 review (0 HIGH, 1 MEDIUM, 3 LOW) — dispositions

**Can reconstruction from `reference` be made safe at all? No — so the key stopped being the
authority.** Three rounds each found a new way for a mutable text key to mis-attribute history
(shared reference, rename mid-history, now swap/reuse), and round 6's case proves the class is not
exhaustible by anticipation: a SWAPPED or REUSED reference leaves every journal resolving to exactly
ONE loan, no key ambiguous, no journal unattributable, and the per-account totals footing
identically under either attribution — nothing in the journals distinguishes it from the truth. The
rebuild therefore no longer decides attribution by the key; it decides it by OUTCOME. It
reconstructs as before and then confirms every figure against an oracle the key never touches.

**M1 — fixed.** `updateLoan` writes `reference = COALESCE(…, reference)` and `loans.reference`
carries no unique constraint, so a swap (two loans exchange references) and a reuse (a freed
reference taken by a second loan) are ordinary API operations. Reproduced on the fixture: the swap
moved a 117 000 prior onto the wrong loan and the reuse split a 192 000 history into 130 000 /
92 000 — in both cases with `loan_reclass_backfill_refusals` EMPTY and the migration reporting
success, and in both cases the next close would have journalled the difference as a fabricated
movement. 659 now holds its reconstruction in `tmp_k081_recon` and records a row only where the
loan's OWN `loan_schedule_rows.st_liability` for that month agrees to within a cent, over every run
the loan has (`recordReclass` writes exactly that figure, and the running sum of the movements to a
month IS that month's `st_liability`; a reprice restates the month in later runs, so agreement with
ANY of the loan's runs is agreement). One unconfirmed period refuses the loan whole, with the reason
in the refusals table. The GL was not used as the oracle: on the shared current-portion account that
makes this defect reachable, the account total is identical under either attribution, so the GL
cannot see a swap at all.

**M1 — the cost, stated plainly.** A loan whose schedule cache no longer covers a month it was
closed in is now refused even where its reconstruction was right, and a loan with no schedule run at
all reconstructs nothing. That is the price of deciding by outcome. The remedy is the same for every
refusal and is now named in the WARNING and in 659's header: record the true prior by hand in
`loan_reclass_postings` with `source = 'app'`, which the rebuild never deletes.

**L1 — fixed.** The unattributable-journal taint joined `gl_journal_lines` on the loan's
current-portion account alone, so a loan whose current-portion account was merely the CONTRA leg of
a foreign reclass was tainted too. A reclass moves both of a loan's accounts, so the taint now
requires a line on the loan's `current_portion_account_id` AND one on its `gl_account_id`.

**L2 — fixed.** Both `information_schema.columns` lookups (645 and 659) now qualify
`table_schema = 'public'`; a same-named table in a `backup_*` or restored snapshot schema silently
skipped 645's backfill and 659's column add.

**L3 — fixed.** Four test files were over the 300-line cap. `k081-loan-reclass-backfill.int.test.ts`
(361) split into it (173) plus `k081-loan-reclass-backfill-rerun.int.test.ts` (118), over a shared
`k081-loan-reclass.helpers.ts`; `k083-loan-period-journal-idempotency.int.test.ts` (311) → 180 over
a new `k083-loan-period-journal.helpers.ts` (148); `loanComplianceService.test.ts` (315) → 229 plus
`loanComplianceService.persistence.test.ts` (113); `loanGlPostingService.test.ts` (310) → 156 plus
`loanGlPostingService.posting.test.ts` (218). Every file in the diff is now under 300.

**Round-6 files.** `scripts/migrations/sql/659_…sql`, `scripts/migrations/sql/645_…sql`, new
`tests/integration/k081-loan-reclass-key-swap.int.test.ts`, new
`tests/integration/k081-loan-reclass.helpers.ts`, new
`tests/integration/k081-loan-reclass-backfill-rerun.int.test.ts`, new
`tests/integration/k083-loan-period-journal.helpers.ts`, new
`tests/unit/services/loans/loanComplianceService.persistence.test.ts`, new
`tests/unit/services/loans/loanGlPostingService.posting.test.ts`, and the four files they were split
from. No `src/` change this round.

**Round-6 tests.** k081-loan-reclass-key-swap — 6 passed (swap, reuse, mixed company, reprice,
no-schedule, contra-leg); the four rebuilt K-081 backfill files — 24 passed together; all twelve
k081/k082/k083 integration files — **55 passed** with `--no-file-parallelism`. Run in parallel these
suites interfere on the one shared fixture database (the M2 case takes an ACCESS EXCLUSIVE lock via
`ALTER TABLE loan_reclass_postings DROP COLUMN`, and the rebuild loops over every company in the
database), and a different two or three fail on each run, including files this round did not touch;
sequentially they are green. Full unit suite with the fixture env unset: **9476 passed / 234 skipped,
0 failed** (799 files, 36 skipped). `tsc --noEmit` clean, and clean again with `noUnusedLocals` over
the changed test files (`tests/**` is outside the repo tsconfig, so eslint cannot parse them; no
`src` file changed this round).

**Round-6 mutation proof.** Each applied, run, restored byte-identical to the pre-mutation file.
(1) the schedule-confirmation taint neutered (`WHERE FALSE AND NOT EXISTS …`) → 4 of the 6 key-swap
cases red, including both money-fabricating ones. (2) the `gl_account_id` half of the L1 taint
removed → the contra-leg case red.

**Historical impact (unchanged in kind).** `origin/master` still carries no 644/645/659. After
deploy, read the refusals before trusting any close — the round-6 rule will refuse more loans than
round 5 did:
`SELECT company_id, loan_key, yyyymm, reason FROM loan_reclass_backfill_refusals ORDER BY 1,3;`

**Limits.** The oracle is the schedule cache, which the application can restate; agreement with any
run of the loan is accepted, so a reconstruction that coincidentally equals a stale figure of the
SAME loan is accepted too. It cannot be corroborated across loans, which is the property that
matters here. Loans with no cached schedule for a closed month are refused rather than guessed.
