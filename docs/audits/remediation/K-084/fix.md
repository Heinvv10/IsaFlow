# K-084 — fix: a loan skipping every month is refused

**Trigger.** `POST /api/accounting/loans` hands `req.body` straight to `createLoan`, and
`validateCreate` checked principal, term, rate and origination fee only. With all twelve calendar
months in `recurringSkipMonths` and `skipMode` EXTEND_TERM, `amortise` pushed its loop bound out
once per skipped period. It escaped only by accident, when `addMonths` reached a five-digit year
and `calendarMonth` misread `'10000-01-31'.slice(5,7)` as `'-0'` so the skip stopped matching:
95 699 rows, last dated 10000-12-31, about 7 s of synchronous CPU, then ~95 700 persisted
`loan_schedule_rows`.

**Before / after.** Two guards. `validateCreate` and `updateLoan` now reject the combination at the
boundary: skip months are deduped and clamped to 1..12, and covering all twelve with EXTEND_TERM
throws. `updateLoan` reads the stored loan only when `skipMode` is being changed, since
`recurring_skip_months` is not editable there, so only a mode switch can create the condition.
Defensively, `amortise` caps `extendedPeriods` at five times the contractual term and throws when
the cap is hit, so no future caller reaches the loop. MAINTAIN_TERM with every month skipped stays
legal, and a normal payment holiday is unaffected.

**Files.** `src/modules/accounting/services/loans/loanService.ts`, `src/lib/amortisation/engine.ts`.

**Tests.** `tests/unit/services/loans/loanService-k084-skip-validation.test.ts` — 7 passed,
covering the duplicated out-of-range list, MAINTAIN_TERM accepted, a normal holiday accepted, the
refused mode switch writing no UPDATE, and no read when `skipMode` is left alone.
`tests/unit/lib/amortisation/k084-skip-every-month-never-terminates.test.ts` — 3 passed; it runs
the engine out of process via `k084-skip-every-month.runner.mts` so a true hang fails instead of
hanging the suite.

**Mutation proof.** Removing both `assertSkipScheduleRepayable` calls gave 3 failed / 4 passed.
Separately removing the engine cap gave 2 failed / 1 passed, back to 95 699 rows. Restored.

**Migration.** None.

**Historical-data impact.** Existing loans in this state have nonsense schedules that should be
recomputed after deploy. Read-only detection, NOT run against production:

```sql
SELECT id, company_id, reference FROM loans
 WHERE skip_mode = 'EXTEND_TERM'
   AND cardinality(ARRAY(SELECT DISTINCT unnest(recurring_skip_months))) >= 12;
```

**Limits.** The `calendarMonth` five-digit-year bug is a separate latent defect and is untouched
here. Fixing it alone would have turned this slow path into a genuinely endless one; the engine cap
now bounds it either way.
