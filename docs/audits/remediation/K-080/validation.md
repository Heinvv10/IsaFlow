# K-080 — the ETI engine matches neither SARS table

**Claim.** The SARS formula gives 50% of remuneration below R2,000; the engine gives R0, so the
lowest-paid eligible employees get nothing.

**Corrected trigger.** The 50% citation is wrong and the defect is wider than the floor. Official
SARS tables (sars.gov.za, *Employment Tax Incentive*, and *ETI changes with effect from
1 April 2025*):

| Band (1 Mar 2022 – 31 Mar 2025, min wage R2,000 / 160h) | First 12 months | Second 12 months |
|---|---|---|
| R0 – R1,999.99 | 75% of remuneration | 37.5% |
| R2,000 – R4,499.99 | R1,500 | R750 |
| R4,500 – R6,499.99 | R1,500 − 75%×(rem−4,500) | R750 − 37.5%×(rem−4,500) |
| R6,500+ | nil | nil |

| Band (from 1 Apr 2025, min wage R2,500 / 160h) | First 12 months | Second 12 months |
|---|---|---|
| R0 – R2,499.99 | 60% of remuneration | 30% |
| R2,500 – R5,499.99 | R1,500 | R750 |
| R5,500 – R7,499.99 | R1,500 − 75%×(rem−5,500) | R750 − 37.5%×(rem−5,500) |
| R7,500+ | nil | nil |

`taxTables.ts` carries a single config — floor 2,000, ceiling 7,500, taper anchored at 4,500 —
which is the old floor and old taper start bolted to the new ceiling. It matches neither table.
Four consequences:

1. Below the floor the engine returns R0 instead of the 75%/60% share. The plan's claim, confirmed.
2. The taper slope is 1,500/3,000 = 0.50 where SARS specifies 0.75, and it starts 1,000 too early.
   The plan's worked example reproduces exactly: a qualifying first-year employee at R5,000 in
   May 2025 should draw R1,500 and draws R1,250.
3. Before April 2025 the ceiling is R1,000 too high, so the engine claims ETI for employees who did
   not qualify — an overclaim to SARS carrying penalty and interest risk, not a shortfall.
4. There is no 160-hour normalisation. SARS requires remuneration to be grossed up to 160 hours and
   the result proportionally reduced for part-month employees; `EtiInput` has no hours field at all.

Underneath all four is a design defect: the table changed on 1 April 2025, mid-way through tax year
2026 (Mar 2025 – Feb 2026). A config keyed on the tax year cannot express that. Selection must be
on the period date.

**Disposition: confirmed.**

**Evidence** (`git show origin/master:<path>`; unchanged since 5661d6f0):
- `src/modules/accounting/services/payroll/etiEngine.ts:66-75` the floor-returns-zero branch and
  the taper; `:39` the ceiling test.
- `src/modules/accounting/services/payroll/taxTables.ts:48-51` the four ETI constants;
  `:54-57` TAX_2026 clones TAX_2025 wholesale; `:64-67` `getTaxYear` is the only date input.
- `src/modules/accounting/services/payroll/payrollTypes.ts:64-70` — `EtiInput` has no hours field.

**Reachability.** `resolveEtiForEmployee` → `calculateEti`, from `payrollCalculator` on every pay
run. Currently masked in production: `etiEngine.ts:87-99` records that all 11 `payroll_employees`
rows have a null `date_of_birth`, so every run takes the not-determinable branch and claims R0.
The engine goes live the moment anyone fills in a date of birth. Production was not queried.

**Proposed minimal fix.** Replace the four scalar constants with an effective-dated table: an array
of `{ from: '2022-03-01', floor, flatUpTo, taperTo, yearOneMax, slope }` entries selected by the
period date rather than the tax year, and rewrite the branch in `calculateEti` as
`rem < floor ? rem × share : rem <= flatUpTo ? max : max − slope × (rem − flatUpTo)`, with year-two
rates at half of year one. Add `hoursWorked` to `EtiInput` and gross up to 160 hours before the
lookup, prorating the result back. Change `calculateEti`'s signature to take the period date it
already receives on `input.periodDate` instead of the `taxYear` argument.

**Historical-data impact.** Two directions, both in `payroll_run_lines`/`payroll_run_headers`:
under-claimed ETI for anyone below the floor or in the taper band, and over-claimed ETI for anyone
earning R6,500–R7,499.99 before April 2025. Over-claims are the serious ones — they were declared
on EMP201 returns. Read-only impact query:

```sql
SELECT h.company_id, h.period_year, h.period_month, sum(l.eti_amount) AS eti
FROM payroll_run_lines l
JOIN payroll_run_headers h ON h.id = l.payroll_run_id AND h.company_id = l.company_id
WHERE COALESCE(l.eti_amount, 0) > 0
GROUP BY h.company_id, h.period_year, h.period_month
ORDER BY 1, 2, 3;
```

NOT run against production. If it returns nothing, no EMP201 has carried a wrong figure and the
correction is forward-only.

**Risks.** K-079 must land with or before this. Once the engine returns a non-zero ETI, every
affected pay run hits the unbalanced blocker and cannot post. Any correction to a prior period also
means an EMP501 reconciliation adjustment, which is an accounting decision, not a code one.

**Sources.**
- [SARS — Employment Tax Incentive (ETI)](https://www.sars.gov.za/types-of-tax/pay-as-you-earn/employment-tax-incentive-eti/)
- [SARS — ETI changes with effect from 1 April 2025](https://www.sars.gov.za/latest-news/employment-tax-incentive-eti-changes-with-effect-from-1-april-2025/)
- [SARS — Guide for Employers in respect of the Employment Tax Incentive (PAYE-GEN-01-G05)](https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G05-Guide-for-Employers-in-respect-of-Employment-Tax-Incentive-External-Guide.pdf)
