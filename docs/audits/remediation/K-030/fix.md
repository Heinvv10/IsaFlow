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

---

# Round 2 — the five review findings on 1e41ba30

**H1 (HIGH) — a revert left a superseded run newest, and the ledger reads newest.**
`loanGlPostingService:164`, `loanComplianceService:259` and `loanPeriodCloseService:147`
all pick the run by `ORDER BY computed_at DESC LIMIT 1`. A cache hit returned an
older run and inserted nothing, so compute A, edit to B, revert to A left run B
newest: the screen showed A while the ledger posted B. The cache-hit branch now
`UPDATE loan_schedule_runs SET computed_at = now() WHERE id = ... AND company_id = ...`
and returns the touched timestamp, so the newest run is always the current-inputs
run. The revert test no longer treats run reuse as the whole story: it asserts the
consumers' own latest-run query returns the reverted run.

**M1 — the hash could move with SQL tie order.** `fetchEvents` and
`fetchRatePoints` had no tiebreaker, so same-date rows could arrive in either
order and hash differently, costing a full recompute and a new run on every read.
Both queries now order by `(date, id)`, and `buildInputsHash` sorts the mapped
arrays by date exactly as the compute path does.

**M2 — the guard did not run without `DATABASE_URL`.** `scripts/ci/run-ci.sh:42`
skips the integration step when `DATABASE_URL` is unset, so `bun run ci` was green
with the fix reverted. `buildInputsHash` is now exported and
`tests/unit/services/loanScheduleInputsHash.test.ts` covers it with no database:
principal, rate, term, residual, start date and day count each move the key,
identical inputs are stable, `updated_at`/`reference` do not move it, event
amounts do, and date ordering is normalised.

**L1 — module doc described the bug.** `src/modules/accounting/services/loans/.claude.md`
now states the real hash contents, the `ENGINE_VERSION` bump rule and the
cache-hit touch. `bun run agent-docs:generate` regenerated the mirror;
`agent-docs:check` reports 74 mirrors matching.

**L2 — `ENGINE_VERSION` had nothing tying it to the engine.** A comment at the
constant now requires a bump on any behavioural change to
`src/lib/amortisation/engine.ts`.

**Tests.** 6 integration (real Postgres) + 10 new unit + the existing 8-test
`tests/unit/services/loans/loanScheduleService.test.ts`, all passing. That existing
file needed one mock added for the new UPDATE, and now asserts the touch. Targeted
mutations, each with the rest of the fix intact: reset the file to `origin/master`
and 3 of 6 integration plus 7 of 10 unit go red; remove only the H1 touch and the
revert test alone goes red; remove only the M1 sort and the ordering unit test
alone goes red. Recorded in `green.log`.

**Still not done.** `updateLoan` still writes no invalidation of its own; the fix
is entirely on the read path. The cache lookup at `:164` still has no
`company_id` predicate (unexploitable, `fetchLoanData` already tenant-verified the
loan). The production impact query still returns 0 rows, so nothing to restate.

**Known-unstable, unrelated.** A full `tests/unit/services/` run fails 3 files, and
which files fail changes between identical runs. They all pass in isolation and the
same instability reproduces with this change's test file removed. Pre-existing
cross-file mock pollution.
