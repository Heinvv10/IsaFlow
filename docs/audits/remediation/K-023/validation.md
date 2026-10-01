# K-023 — SDL leviability uses an invented R25,000 salary per employee

**Claim.** The annual payroll estimate is employee count times R25,000 times 12 regardless of actual remuneration, so SDL and EMP201 are wrong on both sides of the threshold.

**Corrected trigger.** Every payroll run. The R500,000 SDL threshold is decided by headcount alone: one employee is always treated as R300,000 and exempt, two as R600,000 and levied. The break point is fixed at two employees.

**Disposition: confirmed.**

## Evidence
- `git show ebeac9ca:src/modules/accounting/services/payroll/payrollRunService.ts:143`: `const annualPayrollEstimate = employees.length * 25_000 * 12;`, passed to `calculatePayrollLine` (198) and reaching `calculateSDL` via `payrollCalculator.ts:64`.
- `sdlEngine.ts:8-10`: `if (estimatedAnnualPayroll <= config.sdlThresholdAnnual) return 0;` — the estimate is only a threshold gate, so a wrong estimate flips SDL entirely on or off rather than scaling it.
- `taxTables.ts:47`: `sdlThresholdAnnual: 500_000`.
- Files unchanged between 5661d6f0 and ebeac9ca.
- RED `tests/integration/k023-sdl-invented-salary.int.test.ts` (2 failed), two real companies:
  - One employee on R100,000/month (R1.2m annual, leviable): expected R1,000 SDL, got R0.
  - Two employees on R5,000/month (R120,000 annual, exempt): expected R0, got R100.
  Log: `red.log`.

## Reachability
`calculatePayrollRun` — every payroll calculation for every tenant. `total_sdl` on the run header feeds the EMP201 figures, so both errors reach the SARS submission.

## Proposed minimal fix
Derive the estimate from the run's own SDL-leviable remuneration. The per-employee leviable amount is already computed inside the loop, so accumulate `sdlLeviable` in the existing pass and compute SDL in a second pass over `lineInserts` with `annualPayrollEstimate = totalSdlLeviable * 12`. That reuses figures already produced and adds no query. Longer term the employer's own SARS estimate belongs in company settings, since the statutory test is forward-looking; headcount times R25,000 is not that estimate under any reading.

## Historical-data impact
```sql
SELECT h.company_id, h.id AS run_id, h.period_year, h.period_month, h.employee_count,
       h.total_gross, h.total_sdl, h.employee_count * 300000 AS estimate_used,
       h.total_gross * 12 AS annualised_actual
FROM payroll_run_headers h
WHERE (h.employee_count * 300000 > 500000) <> (h.total_gross * 12 > 500000);
```
Each hit is a period where SDL was charged and paid over when not due, or omitted when due. Both are EMP201 misstatements: the first overpays the levy, the second creates a SARS liability with penalties and interest.

## Risks
The fix starts charging SDL for single-employee companies over the threshold and stops it for small two-employee companies, so `total_sdl` moves on future runs. Prior EMP201 submissions are untouched by the code fix and need a separate accounting decision.
