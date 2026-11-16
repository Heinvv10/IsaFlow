/**
 * Runs whose status says approved or paid but which are NOT final (no `approved_at`, no `approval_grandfathered_at`;
 * `payRunFinalSql.ts`), in a window of pay months (wave 6 EF). The EMP201 and the IRP5 leave them out, as every
 * final-run reader does, and name each one in a warning, so a declaration never silently drops a run the ledger
 * carries (its journal was posted at approval). Only a hand edit makes this shape: reopen clears the stamps with the
 * status, and approval sets `approved_at` with it. A production read on 2026-11-16 found none (spec §0a.19).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { PAY_RUN_FINAL_STATUSES, payRunFinalSql } from './payRunFinalSql';

export interface NotFinalRun {
  id: string;
  /** YYYY-MM of the pay month. */
  month: string;
  status: string;
}

/**
 * Company-scoped; `start`/`end` are dates bounding the first of the pay month, as the EMP201 and IRP5 windows are.
 * With `employeeId`, only the runs that carry a line for that employee (a one-employee IRP5).
 */
export async function listNotFinalDeclaredRuns(
  companyId: string, start: string, end: string, employeeId: string | null = null,
): Promise<NotFinalRun[]> {
  const statuses: string[] = [...PAY_RUN_FINAL_STATUSES];
  const rows = (await sql`
    SELECT prh.id::text AS id, prh.period_year, prh.period_month, prh.status
      FROM payroll_run_headers prh
     WHERE prh.company_id = ${companyId}::uuid
       AND prh.status = ANY(${statuses}::text[])
       AND NOT ${sql.unsafe(payRunFinalSql('prh'))}
       AND make_date(prh.period_year, prh.period_month, 1) BETWEEN ${start}::date AND ${end}::date
       AND (${employeeId}::uuid IS NULL
            OR EXISTS (SELECT 1 FROM payroll_run_lines prl WHERE prl.run_id = prh.id AND prl.employee_id = ${employeeId}::uuid))
     ORDER BY prh.period_year, prh.period_month, prh.id
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id),
    month: `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
    status: String(r.status),
  }));
}

/** One sentence per run, naming the month, why it is left out, and the fix. */
export function notFinalRunWarning(run: NotFinalRun, form: 'EMP201' | 'IRP5'): string {
  return `The ${run.status} pay run for ${run.month} has no approval time (approved_at or grandfathered), so it is not `
    + `final and is not on this ${form}. Reopen it and approve it again.`;
}
