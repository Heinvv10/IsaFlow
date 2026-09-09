# K-023 fix — SDL leviability decided on twelve months of actual remuneration

**Trigger.** Every payroll calculation, every tenant. `payrollRunService.ts:143` set
`annualPayrollEstimate = employees.length * 25_000 * 12` and handed it to `calculateSDL`,
which uses it only as the R500,000 exemption gate. The gate therefore turned on headcount:
one employee was always treated as R300,000 and exempt however much they earned; two were
always treated as R600,000 and levied however little. `total_sdl` feeds EMP201.

**Before / after.** Before: SDL on or off by employee count, break point fixed at two
employees. After: `estimateAnnualRemuneration` reads the company's own trailing twelve
periods — the eleven `calculated|approved|paid` runs before this one, plus this run — and
divides by ELAPSED CALENDAR MONTHS since the company's first run, capped at twelve. The 1% is
then charged per line on that line's `sdlLeviable`.

**Basis, and why each half of it.** Section 4(b) of the Skills Development Levies Act exempts
an employer whose total *remuneration* payable to all employees over a twelve-month window
does not exceed R500,000. So the gate reads gross pay, not the leviable subset: gating on
`is_sdl_applicable` would let one mis-flagged component switch the levy off for the whole
employer instead of removing that component from the charge. And it reads a year, not a
month: annualising a single run makes a 13th-cheque month look like a R1m payroll and a short
month look exempt. The denominator is elapsed months rather than runs found, so a month
with no run counts as zero for an established employer: a seasonal business paying R60,000 in
six months of the year reads as R360,000 and stays exempt, where dividing by the six runs
found would read R720,000 and levy it. Only a company younger than twelve months extrapolates,
because for it a missing month is absent history rather than a month of no pay. An empty
window divides by one whatever the company's age, so a dormant business resuming payroll, or
migrated data carrying a single ancient run, is not spread over twelve months it did not pay.

**Files.**
- `src/modules/accounting/services/payroll/sdlLeviabilityService.ts` — new; the trailing-window
  estimate (company-scoped), the elapsed-months denominator, and the per-line charge. Logs the
  basis at `log.info`, since it is not stored on the run and looks strictly backwards.
- `src/modules/accounting/services/payroll/payrollRunService.ts` — drop the invented estimate;
  apply the threshold in a second pass over the costed lines.
- `src/modules/accounting/services/payroll/payrollCalculator.ts` — return `sdlLeviable`; skip
  the levy when the caller defers.
- `src/modules/accounting/services/payroll/payrollTypes.ts` — `annualPayrollEstimate` is
  `number | 'defer'` so that forgetting it is a compile error, not a silent zero levy;
  `sdlLeviable` added to `PayrollLineResult`.
- `src/modules/accounting/services/payroll/.claude.md` (+ regenerated `AGENTS.md`).

**Tests.** `tests/integration/k023-sdl-invented-salary.int.test.ts` (2, validator's RED) and
`tests/integration/k023-sdl-threshold-boundary.int.test.ts` (8: cent-exact boundary either
side of R500,000, gate on remuneration while charging only the leviable part, a 13th-cheque
month that must not create a levy, a short month that must not cancel one, a seasonal employer
whose unpaid months must count as zero, a three-month-old employer that must still
extrapolate, a company resuming after dormancy, tenant scoping of the history). Real Postgres,
11 passed.

The full unit suite is NOT clean on this machine and was not made clean by this fix: it
reports 9,325 passed with 10 failures, all 10s timeouts in bank-allocation, cash-flow and
tracker tests. A control run of the same suite on this branch's unmodified base commit
(f57f71a7) fails 2 of the same tests the same way, the count varying with machine load, and
all 5 affected files pass in isolation on this branch (27 passed). The cause is contention
from parallel work on this box, not this change; none of the failures touch payroll.

Mutation-proofed against five separate wrong bases, each caught by the tests that assert it:
headcount x R25,000 x 12 turns 8 of 10 red; this run's remuneration x 12 turns 3 red; gating on
the leviable subset turns the remuneration test red; dividing by runs found instead of months
elapsed turns the seasonal test red and nothing else; dropping the empty-window guard turns
the dormancy test red and nothing else.

**Migration / rollback.** None. Revert the commit to restore prior behaviour.

**Historical-data impact.** Runs already calculated keep the SDL the old gate produced.
Read-only query, never executed against production by this change:

```sql
WITH runs AS (
  SELECT h.id, h.company_id, h.period_year, h.period_month, h.employee_count,
         h.total_gross, h.total_sdl, h.status,
         (h.period_year * 12 + h.period_month) AS idx
  FROM payroll_run_headers h
  WHERE h.status IN ('calculated', 'approved', 'paid')
    AND h.total_gross > 0
), basis AS (
  SELECT r.*, b.window_gross,
         CASE WHEN b.window_periods = 0 THEN 1
              ELSE LEAST(12, GREATEST(1, r.idx - b.first_idx + 1)) END AS elapsed_periods
  FROM runs r
  -- Calendar months, not preceding ROWS: a company with gaps would otherwise
  -- reach further back than twelve months and disagree with elapsed_periods.
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(p.total_gross)
             FILTER (WHERE p.idx BETWEEN r.idx - 11 AND r.idx - 1), 0) AS window_gross,
           COUNT(*) FILTER (WHERE p.idx BETWEEN r.idx - 11 AND r.idx - 1) AS window_periods,
           MIN(p.idx) AS first_idx
    FROM runs p
    WHERE p.company_id = r.company_id AND p.idx <= r.idx
  ) b
)
SELECT company_id, id AS run_id, period_year, period_month, employee_count,
       total_gross, total_sdl,
       employee_count * 300000 AS estimate_used,
       ROUND((window_gross + total_gross) / elapsed_periods * 12, 2) AS basis_now
FROM basis
WHERE status IN ('approved', 'paid')
  -- AND company_id = $1::uuid   -- optional: one tenant's exposure
  AND (employee_count * 300000 > 500000)
      <> ((window_gross + total_gross) / elapsed_periods * 12 > 500000)
ORDER BY company_id, period_year, period_month;
```

Each hit either paid over a levy that was not due or omitted one that was; both are EMP201
misstatements needing an accounting decision, which this code change does not make.

**Limits.**
- The basis is a proxy, not SARS practice. Section 4(b) is a test the employer applies when it
  registers, on the estimate for the FOLLOWING twelve months, and a registered employer then
  declares SDL on every EMP201 until it deregisters; SARS does not re-run the exemption
  monthly. This recomputes it every run, so an employer sitting on the line can flip between
  months. A company-level "registered for SDL" flag is the real answer and is not built here;
  until it exists, the basis is logged so a nil-SDL month is explainable.
- The basis is not persisted. Because the window looks strictly backwards, recalculating an
  old period once later periods exist yields a different estimate than the original run used,
  and only `total_sdl` records the outcome. An `sdl_annual_basis` column would fix that and
  needs a migration, so it is out of scope here; the log line stands in.
- One small run inside the window still spreads a month over up to twelve, so an employer
  with eleven empty months and one tiny run reads low. That residual is inherent to any
  backward-looking proxy and is what the registration flag would settle.
- The impact query reproduces the shipped basis, but a run's ORIGINAL basis is unrecoverable
  for the reason above, so hits are candidates for review rather than proven errors.
- `payrollRunService.ts` is 509 lines, over the 300-line rule. Pre-existing; extracting the
  rest of it is outside this fix.
