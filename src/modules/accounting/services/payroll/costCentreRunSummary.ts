/**
 * A payroll run rolled up by cost centre: each run line split across the
 * employee's cost allocations (migration 451), or charged whole to
 * payroll_employees.cost_centre_id when the employee has none. A report over a
 * run, not master data — the cost-centre master lives in core/costCentreService
 * and gl/dimensions.
 */

import { sql } from '@/lib/neon';

export interface CostCentreSummaryRow {
  costCentreId: string | null;
  costCentreCode: string | null;
  costCentreName: string | null;
  employeeCount: number;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalEti: number;
  totalNet: number;
}

export interface CostCentreSummary {
  runId: string;
  rows: CostCentreSummaryRow[];
  totals: {
    employeeCount: number;
    totalGross: number;
    totalPaye: number;
    totalUif: number;
    totalSdl: number;
    totalEti: number;
    totalNet: number;
  };
}

export async function costCentreSummaryForRun(
  companyId: string,
  runId: string,
): Promise<CostCentreSummary> {
  const runRows = (await sql`
    SELECT id FROM payroll_run_headers
     WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Record<string, unknown>[];
  if (runRows.length === 0) throw new Error(`Payroll run ${runId} not found in company`);

  // Per-employee cost allocations (mig 451) override the single-centre FK
  // when present. The CTE below produces one row per (run-line × centre),
  // weighted by allocation percentage, with a fallback row for employees
  // that have no allocations.
  const rows = (await sql`
    WITH line_splits AS (
      SELECT prl.employee_id,
             prl.gross_pay,
             prl.paye,
             prl.uif_employee,
             prl.uif_employer,
             prl.sdl,
             prl.eti,
             prl.net_pay,
             a.cost_centre_id        AS allocated_cost_centre_id,
             (a.percentage / 100.0)  AS weight
        FROM payroll_run_lines prl
        JOIN payroll_employee_cost_allocations a
          ON a.company_id = ${companyId}::uuid
         AND a.employee_id = prl.employee_id
       WHERE prl.run_id = ${runId}::uuid
      UNION ALL
      SELECT prl.employee_id,
             prl.gross_pay,
             prl.paye,
             prl.uif_employee,
             prl.uif_employer,
             prl.sdl,
             prl.eti,
             prl.net_pay,
             e.cost_centre_id        AS allocated_cost_centre_id,
             1.0                     AS weight
        FROM payroll_run_lines prl
        JOIN payroll_employees e ON e.id = prl.employee_id
       WHERE prl.run_id = ${runId}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM payroll_employee_cost_allocations a2
            WHERE a2.company_id = ${companyId}::uuid
              AND a2.employee_id = prl.employee_id
         )
    )
    SELECT
      ls.allocated_cost_centre_id                                     AS cost_centre_id,
      cc.code                                                         AS cost_centre_code,
      cc.name                                                         AS cost_centre_name,
      COUNT(DISTINCT ls.employee_id)::int                             AS employee_count,
      COALESCE(SUM(ls.gross_pay * ls.weight), 0)                      AS total_gross,
      COALESCE(SUM(ls.paye * ls.weight), 0)                           AS total_paye,
      COALESCE(SUM((ls.uif_employee + ls.uif_employer) * ls.weight), 0) AS total_uif,
      COALESCE(SUM(ls.sdl * ls.weight), 0)                            AS total_sdl,
      COALESCE(SUM(ls.eti * ls.weight), 0)                            AS total_eti,
      COALESCE(SUM(ls.net_pay * ls.weight), 0)                        AS total_net
    FROM line_splits ls
    LEFT JOIN cost_centres cc ON cc.id = ls.allocated_cost_centre_id
    GROUP BY ls.allocated_cost_centre_id, cc.code, cc.name
    ORDER BY COALESCE(cc.code, 'zzz')
  `) as Record<string, unknown>[];

  const rowsOut: CostCentreSummaryRow[] = rows.map(r => ({
    costCentreId: r.cost_centre_id == null ? null : String(r.cost_centre_id),
    costCentreCode: r.cost_centre_code == null ? null : String(r.cost_centre_code),
    costCentreName: r.cost_centre_name == null ? null : String(r.cost_centre_name),
    employeeCount: Number(r.employee_count ?? 0),
    totalGross: Number(r.total_gross ?? 0),
    totalPaye: Number(r.total_paye ?? 0),
    totalUif: Number(r.total_uif ?? 0),
    totalSdl: Number(r.total_sdl ?? 0),
    totalEti: Number(r.total_eti ?? 0),
    totalNet: Number(r.total_net ?? 0),
  }));

  const totals = rowsOut.reduce(
    (acc, r) => ({
      employeeCount: acc.employeeCount + r.employeeCount,
      totalGross: acc.totalGross + r.totalGross,
      totalPaye: acc.totalPaye + r.totalPaye,
      totalUif: acc.totalUif + r.totalUif,
      totalSdl: acc.totalSdl + r.totalSdl,
      totalEti: acc.totalEti + r.totalEti,
      totalNet: acc.totalNet + r.totalNet,
    }),
    { employeeCount: 0, totalGross: 0, totalPaye: 0, totalUif: 0, totalSdl: 0, totalEti: 0, totalNet: 0 },
  );

  return { runId, rows: rowsOut, totals };
}
