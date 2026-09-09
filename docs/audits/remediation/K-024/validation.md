# K-024 — Annual SARS exports include non-declarable payroll runs

**Claim (BB F42):** Neither the IRP5 nor the EMP501 export applies the canonical
declarable-status filter, so calculated and cancelled runs become declared remuneration.

**Corrected trigger:** Any company with a `draft`/`calculated`/`cancelled` run inside the
tax-year window. Both exports aggregate `payroll_run_lines` joined to `payroll_run_headers`
with **no** predicate on `prh.status`, so every run in the window is declared.

**Disposition: confirmed.**

## Evidence
- `git show ebeac9ca:pages/api/payroll/irp5/easyfile-export.ts` lines 87–104: the aggregate CTE
  filters only `prh.company_id` and the period window. No status predicate.
- `git show ebeac9ca:pages/api/payroll/emp501/export.ts` lines 51–72: same shape, same omission.
- Canonical filter exists and is used elsewhere: `src/lib/constants/payrollRunStatuses.ts:37`
  `EMP201_DECLARABLE_STATUSES = ['approved','paid']`, applied by
  `src/modules/accounting/services/reports/emp201Service.ts:120` and
  `src/modules/accounting/services/payroll/uifDeclarationService.ts:132,177`.
- Fixture DB `payroll_run_headers_status_check` admits exactly draft/calculated/approved/paid/cancelled.
- Neither file changed between 5661d6f0 and ebeac9ca (`git log --oneline 5661d6f0..ebeac9ca -- <path>` empty).

## Reachability
Both are `withAuth(withErrorHandler(withCsrf(handler)))` GET routes reachable by any authenticated
company user; both stream a file the user submits to SARS.

## RED test
`tests/integration/k024-annual-export-declarable-status.int.test.ts` — real Postgres, one employee,
three runs in tax year 2026: approved R10 000, calculated R500 000, cancelled R700 000.
Both tests fail: IRP5 emits `3601,1210000` (expected `3601,10000`); EMP501 emits
`1210000.00` gross / `501000.00` PAYE. Output: `red.log` (2 failed / 2).

## Proposed minimal fix (3–6 lines)
1. `pages/api/payroll/irp5/easyfile-export.ts` — import `EMP201_DECLARABLE_STATUSES`, add
   `AND prh.status = ANY(${[...EMP201_DECLARABLE_STATUSES]}::text[])` to the aggregate query.
2. `pages/api/payroll/emp501/export.ts` — same predicate on the single aggregate query.
Use the shared constant, not a literal, so IRP5/EMP501/EMP201/UI-19 cannot drift.

## Adjacent defect found (not in the claim, do not silently fix)
`pages/api/payroll/emp501/reconciliation.ts:61,79` filters
`status IN ('approved','posted','calculated')`. `'posted'` is not an admissible status under the
CHECK constraint (dead value), and `'calculated'` is explicitly non-declarable. The
EMP201-vs-IRP5 reconciliation therefore uses a third, wrong status set. Worth its own K id.

## Historical-data impact
Every IRP5/EMP501 file already downloaded for a company that had a calculated or cancelled run in
the window over-declares remuneration and PAYE. Read-only impact query:

```sql
SELECT prh.company_id,
       CASE WHEN prh.period_month >= 3 THEN prh.period_year + 1 ELSE prh.period_year END AS tax_year,
       prh.status, COUNT(*) AS runs, SUM(prh.total_gross) AS gross, SUM(prh.total_paye) AS paye
FROM payroll_run_headers prh
WHERE prh.status NOT IN ('approved','paid')
GROUP BY 1,2,3
ORDER BY gross DESC;
```
NOT run against production (out of scope for this validator).

## Risks
Adding the filter can shrink a company's export to zero employees, which the IRP5 route turns into
a 400 "No employees with payroll activity". That is correct behaviour but a visible change; the
message should say the runs were never approved (see `irp5DataService` excludedRows, which already
reports `run_not_declarable`).
