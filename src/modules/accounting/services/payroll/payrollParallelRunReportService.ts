/**
 * Parallel-run report assembly: load an external import + the IsaFlow payroll
 * run for the same period (or an explicit run), convert run lines to cents,
 * and hand both sides to the pure comparator.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { compareParallelRun } from './payrollParallelRunComparator';
import type {
  IsaflowRunLineInput,
  ParallelRunComparisonReport,
} from './payrollParallelRunTypes';
import {
  getExternalImport,
  getExternalImportPayslips,
  type ExternalImportSummary,
} from './payrollExternalImportService';

export interface ParallelRunReportRunInfo {
  id: string;
  periodMonth: number;
  periodYear: number;
  status: string;
}

export interface ParallelRunReport {
  import: ExternalImportSummary;
  run: ParallelRunReportRunInfo | null;
  comparison: ParallelRunComparisonReport | null;
}

/** NUMERIC(14,2) rand string/number → integer cents. */
function randToCents(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100);
}

async function findRunForPeriod(
  companyId: string,
  periodMonth: number,
  periodYear: number,
): Promise<DbRow | null> {
  const rows = (await sql`
    SELECT id, period_month, period_year, status
      FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid
       AND period_month = ${periodMonth}
       AND period_year = ${periodYear}
       AND status <> 'cancelled'
     LIMIT 1
  `) as DbRow[];
  return rows[0] ?? null;
}

async function getRunById(companyId: string, runId: string): Promise<DbRow | null> {
  const rows = (await sql`
    SELECT id, period_month, period_year, status
      FROM payroll_run_headers
     WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  return rows[0] ?? null;
}

async function loadRunLines(runId: string): Promise<IsaflowRunLineInput[]> {
  const rows = (await sql`
    SELECT prl.gross_pay, prl.paye, prl.uif_employee, prl.uif_employer,
           prl.sdl, prl.eti, prl.net_pay,
           e.employee_number, e.first_name, e.last_name
      FROM payroll_run_lines prl
      JOIN payroll_employees e ON e.id = prl.employee_id
     WHERE prl.run_id = ${runId}::uuid
  `) as DbRow[];
  return rows.map((r) => ({
    employeeNumber: String(r.employee_number),
    employeeName: `${String(r.first_name)} ${String(r.last_name)}`.trim(),
    gross: randToCents(r.gross_pay),
    paye: randToCents(r.paye),
    uifEmployee: randToCents(r.uif_employee),
    uifEmployer: randToCents(r.uif_employer),
    sdl: randToCents(r.sdl),
    eti: randToCents(r.eti),
    net: randToCents(r.net_pay),
  }));
}

/**
 * Build the comparison report. When `runId` is omitted the run is resolved by
 * the import's period (one run per company+period). `run`/`comparison` are
 * null when no IsaFlow run exists for the period yet.
 */
export async function getParallelRunReport(
  companyId: string,
  importId: string,
  runId?: string,
): Promise<ParallelRunReport | null> {
  const imp = await getExternalImport(companyId, importId);
  if (!imp) return null;

  const runRow = runId
    ? await getRunById(companyId, runId)
    : await findRunForPeriod(companyId, imp.periodMonth, imp.periodYear);
  if (runId && !runRow) {
    throw new Error('Payroll run not found');
  }
  if (!runRow) {
    return { import: imp, run: null, comparison: null };
  }

  const [lines, payslips] = await Promise.all([
    loadRunLines(String(runRow.id)),
    getExternalImportPayslips(companyId, importId),
  ]);

  return {
    import: imp,
    run: {
      id: String(runRow.id),
      periodMonth: Number(runRow.period_month),
      periodYear: Number(runRow.period_year),
      status: String(runRow.status),
    },
    comparison: compareParallelRun(lines, payslips),
  };
}
