# K-030 fix — loan schedule cache hash ignores every financial term

**Trigger.** `buildInputsHash` hashed `{ loan: loan.id, events, points }`. Editing a
loan's principal, rate, term, residual, start date, day count or any of the three
modes left the hash unchanged, so `getOrComputeSchedule` returned the pre-edit
amortisation. `loanGlPostingService`, `loanComplianceService` and
`loanPeriodCloseService` all read that same run, so the stale schedule reached
the general ledger, not only the screen.

**Before / after.** Before: edit R100 000 / 60m / 12% to R250 000 / 84m / 18%,
ask again, get the original 60-period R100 000 schedule with `cached: true`.
After: the hash covers `loanRowToInputs(loan)`, the engine-mapped events, the
engine-mapped rate points and `ENGINE_VERSION`, so the edit misses the cache and
a new run is computed and persisted. An `updated_at`-only touch still hits the
cache, because `updated_at` is not an engine input.

**Files.** `src/modules/accounting/services/loans/loanScheduleService.ts`
(one function, +8/-1).

**Tests.** `tests/integration/k-030-loan-schedule-cache-hash.int.test.ts` —
5 passed against the disposable Postgres fixture: principal/rate/term edit
recomputes; `updated_at` touch stays cached on the same run id; residual-only
edit recomputes and moves the final closing balance; reverting an edit reuses
the original run id (hash determinism); a second tenant asking for the loan
throws "not found". Logs: `red.log` (1 failed pre-fix), `green.log`.
Mutation check: reverting only the production change turns 3 of the 5 red; the
two controls stay green. Recorded in `green.log`.

**Migration / rollback.** None. Rollback is reverting the commit; no schema or
data change.

**Historical-data impact.** Existing `loan_schedule_runs` rows keep their old
hashes, so the first read of every loan after deploy recomputes and persists a
fresh run. Figures on screen will move for any loan edited since its last run.
Read-only scope query:
```sql
SELECT l.company_id, l.id, l.reference, l.updated_at, MAX(r.computed_at) AS last_run
FROM loans l JOIN loan_schedule_runs r ON r.loan_id = l.id
GROUP BY 1,2,3,4 HAVING l.updated_at > MAX(r.computed_at);
```
Run against production (`isaflow`) on 2026-09-09: 0 rows, over 9 loans, 7 runs on
4 loans and 9 `loan_gl_postings`. No production loan is currently serving a stale
schedule, so no ledger correction is needed today.

**Limits.** The fix changes cache-key coverage only; it does not add a run-
invalidation write to `updateLoan`, and it does not touch the cache lookup's
missing `company_id` predicate in `getOrComputeSchedule` (the loan row is already
tenant-scoped by `fetchLoanData`, so that is unexploitable but worth a separate
look). Historical figures are not restated; the next read simply recomputes.
