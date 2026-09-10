# K-084 — fix: a loan skipping every month is refused

**Trigger.** `POST /api/accounting/loans` hands `req.body` straight to `createLoan`, and
`validateCreate` checked principal, term, rate and origination fee only. With all twelve calendar
months in `recurringSkipMonths` and `skipMode` EXTEND_TERM, `amortise` pushed its loop bound out
once per skipped period, escaping only when `addMonths` reached a five-digit year and
`calendarMonth` misread the slice: 95 699 rows dated to 10000-12-31, about 7 s of synchronous CPU,
then ~95 700 persisted schedule rows.

**Before / after.** `validateCreate` and `updateLoan` reject all twelve months with EXTEND_TERM.
`updateLoan` reads the stored loan only when `skipMode` changes, since `recurring_skip_months` is
not editable there. `amortise` caps `extendedPeriods` and throws when the cap is hit.

**Files.** `src/lib/amortisation/engine.ts`, new `loanValidation.ts`, `loanService.ts`.

**Tests.** `tests/unit/services/loans/loanService-k084-skip-validation.test.ts` — 7 passed.
`tests/unit/lib/amortisation/k084-skip-every-month-never-terminates.test.ts` — 5 passed; the
never-terminating case runs out of process so a true hang fails instead of hanging the suite.

**Mutation proof.** Removing both `assertSkipScheduleRepayable` calls: 3 failed. Returning the cap
to 5x the term: 2 failed.

**Migration.** None.

## Review dispositions

**H3 — fixed.** The validator and the cap did not meet. With k of the twelve months skipped the
extension converges to `termMonths * k / (12 - k)`, which passes 5x at k = 11, not k = 12. A 60-month
loan skipping 11 months is an ordinary finite 719-row schedule that the validator accepted and the
5x cap then threw on, so `getOrComputeSchedule`, `previewSchedule` and `postPeriodJournals` would
have 500ed on a stored loan while its cached run kept serving.

The cap is now 12x, which accepts every k the validator accepts and refuses exactly k = 12. Both
bounds are documented in terms of the same formula, in the engine and in `loanValidation.ts`, so
they are changed together. Two tests cover it: the k = 11 case at term 60, and a sweep asserting
every k from 1 to 11 computes and k = 12 throws, at terms 12, 24, 60, 120 and 360.

**ENGINE_VERSION is not bumped, and the claim is now true.** The pre-fix and post-fix engines were
run against each other over 144 combinations (terms 6/12/24/60/120/360 x EXTEND_TERM and
MAINTAIN_TERM x k = 0..11): zero differences. Bumping would force a recompute of every cached run on
every company for no change in output. The `.claude.md` and `AGENTS.md` wording the review called
false has been rewritten to state the cap, the formula and the basis of this claim.

**Historical-data impact.** Loans skipping all twelve months have nonsense schedules and should be
recomputed after deploy. Read-only detection, NOT run against production:

```sql
SELECT id, company_id, reference FROM loans
 WHERE skip_mode = 'EXTEND_TERM'
   AND cardinality(ARRAY(SELECT DISTINCT unnest(recurring_skip_months))) >= 12;
```

**Limits.** The `calendarMonth` five-digit-year bug is a separate latent defect and is untouched.
Fixing it alone would turn this slow path into a genuinely endless one; the cap bounds it either way.
