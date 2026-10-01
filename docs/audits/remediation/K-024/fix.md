# K-024 fix — annual SARS exports declare only approved/paid runs

**Trigger.** Any company with a `draft`, `calculated` or `cancelled` payroll run inside the
tax-year window. Both annual export routes aggregated `payroll_run_lines` joined to
`payroll_run_headers` with no predicate on `prh.status`, so every run in the window was
declared to SARS.

**Before.** Fixture with approved R10 000, calculated R500 000 and cancelled R700 000 in
tax year 2026: IRP5 emitted `3601,1210000`; EMP501 emitted `1210000.00` gross /
`501000.00` PAYE.

**After.** Both aggregates carry `AND prh.status = ANY(${declarableStatuses}::text[])`
built from the existing `EMP201_DECLARABLE_STATUSES` (`['approved','paid']`), the same
constant `emp201Service`, `uifDeclarationService` and `irp5DataService` already use. IRP5
now emits `3601,10000`; EMP501 `10000.00`.

A blind review then found two sibling surfaces on `payroll_run_headers` that the first two
commits had left behind, so the third commit extends the same predicate to them — see
"Remaining surfaces" below.

**Files.**
- `pages/api/payroll/irp5/easyfile-export.ts` (+5, plus the taxYear guard in commit 3)
- `pages/api/payroll/emp501/export.ts` (+6)
- `pages/api/payroll/irp5/summary.ts` (commit 3)
- `pages/api/payroll/year-end/status.ts` (commit 3)

**Tests.** `tests/integration/k024-annual-export-declarable-status.int.test.ts` — real
Postgres, 2 tests, both green. Adjacent cases added: a `paid` run for a second employee is
still exported; an approved Feb-2025 run (tax year 2025) is excluded by the window; a second
tenant's approved R800 000 run never appears in either file. Mutation check: removing both
predicates returns the file to 2 failed / 2. Details in `green.log`.

**Migration / rollback.** None. Revert is the two-line removal.

**Historical-data impact.** Every IRP5 and EMP501 file already downloaded for a company that
had a non-declarable run inside the window over-declared remuneration and PAYE. Read-only
query (NOT run against production):

The `IN` list below is deliberately wider than `NOT IN ('approved','paid')`: the exports
over-declared on `calculated` and `cancelled`, while the reconciliation, the year-end
checklist and the IRP5 summary additionally DROPPED `paid` runs. One query covers both
directions.

```sql
SELECT prh.company_id,
       CASE WHEN prh.period_month >= 3 THEN prh.period_year + 1 ELSE prh.period_year END AS tax_year,
       prh.status, COUNT(*) AS runs, SUM(prh.total_gross) AS gross, SUM(prh.total_paye) AS paye
FROM payroll_run_headers prh
WHERE prh.status IN ('draft','calculated','cancelled','paid')
GROUP BY 1,2,3
ORDER BY gross DESC;
```

## Remaining surfaces

Every SARS-declaration query on `payroll_run_headers` now uses
`EMP201_DECLARABLE_STATUSES`. Enumerated by call site, not by directory:

| File | State |
|---|---|
| `services/reports/emp201Service.ts` | already used the constant |
| `services/payroll/uifDeclarationService.ts` | already used the constant (UI-19 alias) |
| `services/payroll/irp5DataService.ts` | already used the constant |
| `pages/api/payroll/irp5/easyfile-export.ts` | fixed, commit 1 |
| `pages/api/payroll/emp501/export.ts` | fixed, commit 1 |
| `pages/api/payroll/emp501/reconciliation.ts` | fixed, commit 2 |
| `pages/api/payroll/irp5/summary.ts` | fixed, commit 3 (had no predicate at all) |
| `pages/api/payroll/year-end/status.ts` | fixed, commit 3 (three wrong triples) |

Two bureau queries still use `IN ('draft','calculated','approved')` and are deliberately
left alone: `bureauWorkAggregatorService.ts:47` builds a work queue of runs still needing
attention and `ownerCashPositionService.ts:131` a cash position. Neither declares anything
to SARS, so the declarable set is the wrong vocabulary for them. Whether the cash position
should count `paid` runs is a separate question, not this defect.

**Limits.** A company whose runs were never approved now exports zero employees, which the
IRP5 route turns into a 400 "No employees with payroll activity". Correct, but the message
does not say the runs were never approved. Not changed here.
