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

const OVERDRAWN_CODES = new Set(['DEDUCTIONS_EXCEED_PAY', 'LOAN_INSTALMENT_EXCEEDS_PAY']);

/** A line whose deductions and tax exceed its pay, by how much in rand. */
export interface OverdrawnLine {
  employeeId: string;
  employeeNumber: string;
  shortfall: number;
  /** The shortfall would not exist without the loan instalment: LOAN_INSTALMENT_EXCEEDS_PAY. */
  fromLoan: boolean;
}

/**
 * The run's overdrawn lines. A line calculated since the codes existed carries DEDUCTIONS_EXCEED_PAY or
 * LOAN_INSTALMENT_EXCEEDS_PAY with its raw net, and that decides. A line with neither predates them (or is
 * not overdrawn): its raw net is rebuilt from what the line stored, never from the catalogue as it reads
 * today. Deductions are the breakdown's total less gross pay, which is every earning: the breakdown
 * carries no component type, and a type re-assigned since must not change what the line took (no
 * employer_contribution component can exist: the column holds 20 characters). The instalment is the
 * breakdown's items coded LOAN after the calculator's own trim (normaliseSarsCode), exact case. Both
 * rebuilt figures are rounded to the cent first, as the calculator rounds net, so a float tail in a
 * stored amount is no R0.01 shortfall.
 * Limit: a LOAN-coded EARNING (which the loan service never writes) would count as an instalment here.
 * Net pay itself cannot prove the condition because negative values were always floored at nil.
 */
export async function findOverdrawnLines(companyId: string, runId: string): Promise<OverdrawnLine[]> {
  const rows = (await sql`
    WITH run_lines AS (
      SELECT prl.employee_id, pe.employee_number, prl.validation_results,
        (prl.validation_results @> '[{"code":"DEDUCTIONS_EXCEED_PAY"}]'::jsonb
          OR prl.validation_results @> '[{"code":"LOAN_INSTALMENT_EXCEEDS_PAY"}]'::jsonb) AS coded,
        ROUND(prl.gross_pay - prl.paye - prl.uif_employee - (stored.total - prl.gross_pay), 2) AS derived_raw_net,
        ROUND(prl.gross_pay - prl.paye - prl.uif_employee - (stored.total - prl.gross_pay) + stored.loan, 2) AS derived_without_loan
      FROM payroll_run_lines prl
      JOIN payroll_run_headers prh ON prh.id = prl.run_id
      JOIN payroll_employees    pe  ON pe.id  = prl.employee_id
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM((item->>'amount')::numeric), 0) AS total,
          COALESCE(SUM((item->>'amount')::numeric) FILTER (WHERE BTRIM(item->>'sarsSourceCode', E' \t\r\n') = 'LOAN'), 0) AS loan
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(prl.component_breakdown) = 'array' THEN prl.component_breakdown ELSE '[]'::jsonb END) item
      ) stored ON true
      WHERE prl.run_id = ${runId}::uuid
        AND prh.company_id = ${companyId}::uuid
    )
    SELECT * FROM run_lines
    WHERE coded OR derived_raw_net < 0
    ORDER BY employee_number
  `) as Row[];
  return rows.flatMap((r) => {
    const flagged = r.coded === true
      ? parseValidationResults(r.validation_results).find((v) => OVERDRAWN_CODES.has(v.code))
      : undefined;
    const rawNet = typeof flagged?.rawNet === 'number' ? flagged.rawNet : Number(r.derived_raw_net);
    if (!Number.isFinite(rawNet) || rawNet >= 0) return [];
    const fromLoan = flagged
      ? flagged.code === 'LOAN_INSTALMENT_EXCEEDS_PAY'
      : Number(r.derived_without_loan) >= 0;
    return [{
      employeeId: String(r.employee_id),
      employeeNumber: String(r.employee_number),
      shortfall: -rawNet,
      fromLoan,
    }];
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
