/**
 * The lines of a payroll run, as the run detail page and the MCP tools read
 * them. Extracted from payrollRunService (which re-exports it) to keep that
 * file under the 300-line cap.
 */

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

/** A line whose deductions and tax exceed its pay, by how much in rand. */
export interface OverdrawnLine {
  employeeId: string;
  employeeNumber: string;
  shortfall: number;
}

/**
 * The run's lines the calculator flagged DEDUCTIONS_EXCEED_PAY. Their net is floored at nil, so the
 * residual the journal credits to 2175 understates what was deducted. Only a line calculated since the
 * code existed can carry it: a run calculated earlier shows nothing until it is recalculated.
 */
export async function findOverdrawnLines(companyId: string, runId: string): Promise<OverdrawnLine[]> {
  const rows = (await sql`
    SELECT prl.employee_id, pe.employee_number, prl.validation_results
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees    pe  ON pe.id  = prl.employee_id
    WHERE prl.run_id = ${runId}::uuid
      AND prh.company_id = ${companyId}::uuid
      AND prl.validation_results @> '[{"code":"DEDUCTIONS_EXCEED_PAY"}]'::jsonb
    ORDER BY pe.employee_number
  `) as Row[];
  return rows.flatMap((r) => {
    const flagged = parseValidationResults(r.validation_results).find((v) => v.code === 'DEDUCTIONS_EXCEED_PAY');
    return flagged ? [{ employeeId: String(r.employee_id), employeeNumber: String(r.employee_number), shortfall: -Number(flagged.rawNet) }] : [];
  });
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
