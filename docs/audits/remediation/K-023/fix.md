# K-023 fix — SDL leviability decided on twelve months of actual remuneration

**Trigger.** Every payroll calculation, every tenant. `payrollRunService.ts:143` set
`annualPayrollEstimate = employees.length * 25_000 * 12` and handed it to `calculateSDL`,
which uses it only as the R500,000 exemption gate. The gate therefore turned on headcount:
one employee was always treated as R300,000 and exempt however much they earned; two were
always treated as R600,000 and levied however little. `total_sdl` feeds EMP201.

**Before / after.** Before: SDL on or off by employee count, break point fixed at two
employees. After: `estimateAnnualRemuneration` reads the company's own trailing twelve
periods — the eleven `calculated|approved|paid` runs before this one, plus this run — and
annualises the mean of the periods that exist. The 1% is then charged per line on that line's
`sdlLeviable`.

**Basis, and why each half of it.** Section 4(b) of the Skills Development Levies Act exempts
an employer whose total *remuneration* payable to all employees over a twelve-month window
does not exceed R500,000. So the gate reads gross pay, not the leviable subset: gating on
`is_sdl_applicable` would let one mis-flagged component switch the levy off for the whole
employer instead of removing that component from the charge. And it reads a year, not a
month: annualising a single run makes a 13th-cheque month look like a R1m payroll and a short
month look exempt. Where history is missing the mean of the available periods is used, which
reduces to `thisRun * 12` for a company's first run and to the exact twelve-month total once a
full year exists.

**Files.**
- `src/modules/accounting/services/payroll/sdlLeviabilityService.ts` — new; the trailing-window
  estimate (company-scoped) and the per-line charge.
- `src/modules/accounting/services/payroll/payrollRunService.ts` — drop the invented estimate;
  apply the threshold in a second pass over the costed lines.
- `src/modules/accounting/services/payroll/payrollCalculator.ts` — return `sdlLeviable`; skip
  the levy when the caller defers.
- `src/modules/accounting/services/payroll/payrollTypes.ts` — `annualPayrollEstimate` is
  `number | 'defer'` so that forgetting it is a compile error, not a silent zero levy;
  `sdlLeviable` added to `PayrollLineResult`.
- `src/modules/accounting/services/payroll/.claude.md` (+ regenerated `AGENTS.md`).

**Tests.** `tests/integration/k023-sdl-invented-salary.int.test.ts` (2, validator's RED) and
`tests/integration/k023-sdl-threshold-boundary.int.test.ts` (6: cent-exact boundary either
side of R500,000, gate on remuneration while charging only the leviable part, a 13th-cheque
month that must not create a levy, a short month that must not cancel one, tenant scoping of
the history). Real Postgres, 8 passed. Payroll unit suite 334 passed / 2 skipped.

The full unit suite is NOT clean on this machine and was not made clean by this fix: it
reports 9,325 passed with 10 failures, all 10s timeouts in bank-allocation, cash-flow and
tracker tests. A control run of the same suite on this branch's unmodified base commit
(f57f71a7) fails 2 of the same tests the same way, the count varying with machine load, and
all 5 affected files pass in isolation on this branch (27 passed). The cause is contention
from parallel work on this box, not this change; none of the failures touch payroll.

Mutation-proofed against three separate wrong bases, each caught by the tests that assert it:
headcount x R25,000 x 12 turns 7 of 8 red; this run's remuneration x 12 turns the two
volatility tests red; gating on the leviable subset turns the remuneration test red.

**Migration / rollback.** None. Revert the commit to restore prior behaviour.

**Historical-data impact.** Runs already calculated keep the SDL the old gate produced.
Read-only query, never executed against production by this change:

```sql
SELECT h.company_id, h.id AS run_id, h.period_year, h.period_month, h.employee_count,
       h.total_gross, h.total_sdl,
       h.employee_count * 300000 AS estimate_used,
       h.total_gross * 12         AS annualised_actual
FROM payroll_run_headers h
WHERE h.status IN ('approved', 'paid')
  -- AND h.company_id = $1::uuid   -- optional: one tenant's exposure
  AND (h.employee_count * 300000 > 500000) <> (h.total_gross * 12 > 500000)
ORDER BY h.company_id, h.period_year, h.period_month;
```

Each hit either paid over a levy that was not due or omitted one that was; both are EMP201
misstatements needing an accounting decision, which this code change does not make.

**Limits.** The query annualises a single period because the trailing-window figure is not
stored on the header, so it reproduces the old defect's shape rather than the new basis;
treat hits as candidates. The statutory test is a forward estimate the employer makes, and a
company setting holding that estimate would still be more correct than any backward-looking
figure. Recalculating an existing run now moves its `total_sdl`. `payrollRunService.ts` is 509
lines, over the 300-line rule; that is pre-existing and extracting the rest of it is outside
this fix.
