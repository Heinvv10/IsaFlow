# K-084 — A loan skipping every month never terminates

**Claim.** With twelve recurring skip months and EXTEND_TERM the loop extends indefinitely,
consuming CPU and memory synchronously.

**Corrected trigger.** The mechanism is real but the loop is NOT endless. `amortise`
(engine.ts:92 `for (let p = 1; p <= totalPeriods + extendedPeriods; p++)` and engine.ts:178
`if (skip && loan.skipMode === 'EXTEND_TERM') extendedPeriods++`) pushes the bound out once per
iteration, and the early-exit at engine.ts:196 is unreachable because a skipped period pays
nothing and the NCA in-duplum cap freezes the interest. It escapes only by accident: once
`addMonths` reaches a five-digit year, `calendarMonth` (engine.ts:26) reads
`'10000-01-31'.slice(5,7)` as `'-0'`, `isSkipPeriod` stops matching and the loan amortises.
Measured on this baseline: **95 699 rows, last row dated 10000-12-31, ~7 s of synchronous CPU**
per call. The harm is that, not a hang.

**Disposition: confirmed (corrected trigger).**

**Evidence.** `bun tests/unit/lib/amortisation/k084-skip-every-month.runner.mts` prints
`rows=95699` / `lastDate=10000-12-31` in 7,4 s. RED test asserts a bounded, prompt schedule.
Log: `red.log`.

**Reachability.** `POST /api/accounting/loans` (index.ts:32) hands `req.body` straight to
`createLoan`; `validateCreate` (loanService.ts:163-172) checks principal, termMonths, fixedRate
and originationFee only — `recurringSkipMonths` and `skipMode` are never validated, and
`recurring_skip_months` is a bare array column. Computing the schedule afterwards blocks the
Node process for seconds and `loanScheduleService` then persists ~95 700 `loan_schedule_rows`.

**RED test.** `tests/unit/lib/amortisation/k084-skip-every-month-never-terminates.test.ts`
(out-of-process, so a true hang fails instead of hanging the suite) — 1 failed / 1.

**Proposed minimal fix.** Reject the impossible loan at the input boundary: in `validateCreate`
and `validateUpdate`, throw when `recurringSkipMonths` (deduped, each in 1..12) covers all twelve
months. Defensively, cap `extendedPeriods` in `amortise` at some multiple of `termMonths` and
throw when the cap is hit, so no future caller can reach the same loop.

**Historical-data impact.** Detect existing loans (read-only, not run here):
```sql
SELECT id, company_id, reference FROM loans
 WHERE skip_mode = 'EXTEND_TERM'
   AND cardinality(ARRAY(SELECT DISTINCT unnest(recurring_skip_months))) >= 12;
```
Any such loan's `loan_schedule_rows` are nonsense and should be recomputed after the fix.

**Risks.** The `calendarMonth` five-digit-year bug is a separate latent defect; fixing it in
isolation would turn this slow path into a genuinely infinite one. Fix the validation first.
