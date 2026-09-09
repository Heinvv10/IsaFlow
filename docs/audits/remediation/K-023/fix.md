# K-023 fix — SDL leviability derived from actual leviable remuneration

**Trigger.** Every payroll calculation, every tenant. `payrollRunService.ts:143` set
`annualPayrollEstimate = employees.length * 25_000 * 12` and handed it to `calculateSDL`,
which uses it only as the R500,000 exemption gate. The gate therefore turned on headcount:
one employee was always treated as R300,000 and exempt however much they earned; two were
always treated as R600,000 and levied however little. `total_sdl` feeds EMP201.

**Before / after.** Before: SDL on/off by employee count, break point fixed at two employees.
After: the run accumulates the SDL-leviable remuneration it already computes per line, and
applies the threshold once, in a second pass, at `totalSdlLeviable * 12`.

**Annualisation basis.** Section 4(b) of the Skills Development Levies Act exempts an
employer whose total remuneration payable to all employees over the following 12 months will
not exceed R500,000. That is forward-looking and the run cannot see it, so the run's own
leviable remuneration annualised is the nearest estimate available from run data. It is the
same quantity the levy is charged on, so the gate and the charge no longer disagree.

**Files.**
- `src/modules/accounting/services/payroll/payrollRunService.ts` — drop the invented estimate;
  accumulate `totalSdlLeviable`; compute per-line SDL and `totalSdl` in a second pass.
- `src/modules/accounting/services/payroll/payrollCalculator.ts` — return `sdlLeviable`; skip
  the levy when no estimate is supplied.
- `src/modules/accounting/services/payroll/payrollTypes.ts` — `annualPayrollEstimate` optional
  (documented), `sdlLeviable` added to `PayrollLineResult`.

**Tests.** `tests/integration/k023-sdl-invented-salary.int.test.ts` (2, validator's RED) and
`tests/integration/k023-sdl-threshold-boundary.int.test.ts` (4: cent-exact boundary either
side of R500,000 annualised, leviability decided on SDL-applicable earnings not gross, second
tenant untouched). Real Postgres, 6 passed. Full unit suite 9,335 passed / 234 skipped.
Mutation check: restoring the headcount estimate turns 3 of the 6 red.

**Migration / rollback.** None. Revert the commit to restore prior behaviour.

**Historical-data impact.** Runs already calculated keep the SDL the old gate produced.
Read-only query (never run against production by this change):

```sql
SELECT h.company_id, h.id AS run_id, h.period_year, h.period_month, h.employee_count,
       h.total_gross, h.total_sdl, h.employee_count * 300000 AS estimate_used,
       h.total_gross * 12 AS annualised_actual
FROM payroll_run_headers h
WHERE (h.employee_count * 300000 > 500000) <> (h.total_gross * 12 > 500000)
ORDER BY h.company_id, h.period_year, h.period_month;
```

Each hit either paid over a levy that was not due or omitted one that was; both are EMP201
misstatements needing an accounting decision, which this code change does not make.

**Limits.** The query above uses `total_gross` because the leviable total is not stored on the
header; gross overstates leviability where components are flagged not SDL-applicable, so treat
hits as candidates. The statutory test is a forward estimate the employer makes; a company
setting holding that estimate would be more correct than annualising one month, and is not
built here. Recalculating an existing run now moves its `total_sdl`.
