/**
 * The lines of a payroll run as the run detail page and the MCP tools read them (the line-row mapping).
 * Split out of payrollRunLines.ts (which re-exports it) to keep that file under the 300-line cap.
 */

import { isEmployerFundBenefitCode } from './retirementFund';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ValidationResult } from './payrollTypes';

type Row = DbRow;

export interface PayrollRunLine {
  id: string;
  runId: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  /** The breakdown's items flagged isNonCash (the 3801 loan benefit): taxed and levied, not in grossPay. */
  nonCashBenefits: number;
  /** RF: of nonCashBenefits, the employer's 3817 / 3825 / 3828 fund contributions, also deemed paid by the employee into s11F. */
  employerRetirement: number;
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
export function parseValidationResults(raw: unknown): ValidationResult[] {
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
    nonCashBenefits: Array.isArray(r.component_breakdown)
      ? Math.round((r.component_breakdown as Array<{ isNonCash?: boolean; amount?: unknown }>)
        .reduce((s, i) => s + (i?.isNonCash === true ? Number(i.amount) || 0 : 0), 0) * 100) / 100
      : 0,
    employerRetirement: employerRetirementOf(r.component_breakdown),
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

/** RF: the line's taxable non-cash 3817 / 3825 / 3828 items (the employer's fund contributions, as deemed), to the cent; 0 for none or an unreadable breakdown. */
export function employerRetirementOf(breakdown: unknown): number {
  if (!Array.isArray(breakdown)) return 0;
  return Math.round((breakdown as Array<{ isNonCash?: boolean; isTaxable?: boolean; sarsSourceCode?: unknown; amount?: unknown }>)
    .reduce((s, i) => s + (i?.isNonCash === true && i.isTaxable === true && isEmployerFundBenefitCode(String(i.sarsSourceCode ?? '')) ? Number(i.amount) || 0 : 0), 0) * 100) / 100;
}
