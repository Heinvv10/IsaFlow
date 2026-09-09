# R-005 fix — EMP501 reconciliation used a third, wrong status set

**Trigger.** Any company with a `calculated` or `paid` payroll run inside the tax-year
window. `pages/api/payroll/emp501/reconciliation.ts` filtered both of its aggregates with
`status IN ('approved','posted','calculated')`. `'posted'` is not admissible under the
`payroll_run_headers_status_check` CHECK constraint (dead value), `'calculated'` is
explicitly non-declarable, and `'paid'` — a real declarable status — was missing. The page
that exists to prove the EMP201 agrees with the IRP5 therefore reconciled a third set of
runs that neither declaration uses.

**Before.** Fixture tax year 2026 with approved R1 000 PAYE (Mar), calculated R200 000
(Apr), cancelled R300 000 (May) and paid R2 000 (Jun): the reconciliation reported June as
`no_data` and a total of R201 000, against an EMP501 export total of R3 000.

**After.** Both aggregates use `EMP201_DECLARABLE_STATUSES` (`['approved','paid']`), the
same constant as the EMP201 report, the UI-19 declaration and, since the sibling K-024 fix,
the IRP5 and EMP501 exports. A blind review found the identical wrong triple still in
`pages/api/payroll/year-end/status.ts`, which runs a SECOND EMP501 balance check off the
same header aggregate; the third commit aligns it, and `K-024/fix.md` carries the full
enumeration of declaration surfaces. March R1 000 and June R2 000 are balanced, April and May are
`no_data`, and the reconciliation total equals the export total exactly.

**Files.** `pages/api/payroll/emp501/reconciliation.ts` (+6 / -2, plus the taxYear guard in
commit 3); `pages/api/payroll/year-end/status.ts` in commit 3.

**Tests.** `tests/integration/r005-emp501-reconciliation-declarable-status.int.test.ts` —
real Postgres, 2 tests, both green. The second asserts the reconciliation totals equal the
PAYE the EMP501 export actually emits. Adjacent cases: an approved Feb-2025 run is outside
the tax year 2026 window, and a second tenant's approved R350 000 appears in no row.
Mutation check: restoring `IN ('approved','posted','calculated')` on both queries returns
the suite to 2 failed / 2. Details in `green.log`.

**Migration / rollback.** None.

**Historical-data impact.** No stored rows are wrong — the route computes on read. Every
reconciliation screenshot or decision taken from it for a company with a calculated or paid
run in the window was wrong. Same read-only query as K-024 identifies the companies; add
`'paid'` to see the runs that were being dropped:

```sql
SELECT company_id,
       CASE WHEN period_month >= 3 THEN period_year + 1 ELSE period_year END AS tax_year,
       status, COUNT(*) AS runs, SUM(total_paye) AS paye
FROM payroll_run_headers
WHERE status IN ('calculated', 'paid')
GROUP BY 1,2,3
ORDER BY paye DESC;
```

**Limits.** The reconciliation still compares header `total_paye` against the sum of line
`paye` for the same runs, so it detects header/line drift only. It does not prove the EMP201
was actually submitted.
