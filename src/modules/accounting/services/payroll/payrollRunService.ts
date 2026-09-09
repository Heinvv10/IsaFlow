import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PayrollPeriod, ValidationResult } from './payrollTypes';
export { calculatePayrollRun } from './payrollCalculationService';
type Row = DbRow;
export interface PayrollRunSummary {
  id: string;
  companyId: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalEti: number;
  totalNet: number;
  employeeCount: number;
}

export function mapRunRow(r: Row): PayrollRunSummary {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    periodMonth: Number(r.period_month),
    periodYear: Number(r.period_year),
    status: String(r.status),
    totalGross: Number(r.total_gross) || 0,
    totalPaye: Number(r.total_paye) || 0,
    totalUif: Number(r.total_uif) || 0,
    totalSdl: Number(r.total_sdl) || 0,
    totalEti: Number(r.total_eti) || 0,
    totalNet: Number(r.total_net) || 0,
    employeeCount: Number(r.employee_count) || 0,
  };
}

export async function listPayrollRuns(companyId: string): Promise<PayrollRunSummary[]> {
  const rows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE company_id = ${companyId}::uuid
    ORDER BY period_year DESC, period_month DESC
  `) as Row[];
  return rows.map(mapRunRow);
}

export class PayrollRunDuplicateError extends Error {
  readonly month: number;
  readonly year: number;
  constructor(month: number, year: number) {
    super(`A payroll run for ${month}/${year} already exists.`);
    this.name = 'PayrollRunDuplicateError';
    this.month = month;
    this.year = year;
  }
}

export async function createPayrollRun(
  companyId: string,
  period: PayrollPeriod,
  createdBy?: string,
): Promise<PayrollRunSummary> {
  log.info('Creating payroll run', { companyId, period }, 'payrollRunService');
  const rows = (await sql`
    INSERT INTO payroll_run_headers (company_id, period_month, period_year, created_by)
    VALUES (${companyId}::uuid, ${period.month}, ${period.year}, ${createdBy ?? null}::uuid)
    ON CONFLICT (company_id, period_year, period_month) DO NOTHING
    RETURNING *
  `) as Row[];
  if (rows.length === 0) {
    throw new PayrollRunDuplicateError(period.month, period.year);
  }
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapRunRow(rows[0]);
}

export async function getPayrollRun(
  id: string,
  companyId: string,
): Promise<PayrollRunSummary | null> {
  const rows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  return rows.length > 0 && rows[0] ? mapRunRow(rows[0]) : null;
}

export interface PayrollRunLine {
  id: string;
  runId: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  taxableIncome: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  netPay: number;
  /**
   * Warnings raised while calculating this line. Written since the run service
   * was built, but dropped by this mapper until the ETI work — so every warning
   * the validation engine produced was invisible to every caller.
   */
  validationResults: ValidationResult[];
}

/**
 * Read `payroll_run_lines.validation_results` defensively.
 *
 * pg hands back parsed jsonb, but a text column or a driver change would give a
 * string. A malformed value must degrade to "no warnings" rather than throw —
 * a broken warning payload may not take down the run detail page.
 */
function parseValidationResults(raw: unknown): ValidationResult[] {
  const value = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  return Array.isArray(value) ? (value as ValidationResult[]) : [];
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getPayrollRunLines(
  runId: string,
  companyId: string,
): Promise<PayrollRunLine[]> {
  const rows = (await sql`
    SELECT
      prl.*,
      pe.employee_number,
      pe.first_name,
      pe.last_name
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees    pe  ON pe.id  = prl.employee_id
    WHERE prl.run_id = ${runId}::uuid
      AND prh.company_id = ${companyId}::uuid
    ORDER BY pe.employee_number
  `) as Row[];

  return rows.map(r => ({
    id: String(r.id),
    runId: String(r.run_id),
    employeeId: String(r.employee_id),
    employeeNumber: String(r.employee_number),
    employeeName: `${r.first_name} ${r.last_name}`,
    grossPay: Number(r.gross_pay),
    taxableIncome: Number(r.taxable_income),
    paye: Number(r.paye),
    uifEmployee: Number(r.uif_employee),
    uifEmployer: Number(r.uif_employer),
    sdl: Number(r.sdl),
    eti: Number(r.eti),
    netPay: Number(r.net_pay),
    validationResults: parseValidationResults(r.validation_results),
  }));
}
