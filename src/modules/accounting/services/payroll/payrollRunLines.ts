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
  /** The loans this run took from the employee (loan numbers). */
  loans?: string[];
  /** A line at nil from before the codes whose breakdown cannot be read: nothing can say whether it is overdrawn. */
  unreadable?: true;
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
 * stored amount is no R0.01 shortfall. Only a line at nil is rebuilt: one that paid anything was not
 * overdrawn. A line at nil whose breakdown is not an array, or is empty beside a gross, cannot be judged
 * and is returned `unreadable`.
 * Limit: a LOAN-coded EARNING counts as an instalment here. POST /api/payroll/components can make one,
 * but the loan service only puts its instalment on a deduction (loadLoanComponents), so it reaches a
 * stored line only when assigned by hand.
 * Net pay itself cannot prove the condition because negative values were always floored at nil.
 */
export async function findOverdrawnLines(companyId: string, runId: string): Promise<OverdrawnLine[]> {
  const rows = (await sql`
    WITH run_lines AS (
      SELECT prl.employee_id, pe.employee_number, prl.validation_results, prl.net_pay = 0 AS net_pay_nil,
        (SELECT COALESCE(array_agg(l.loan_number ORDER BY l.loan_number), '{}') FROM payroll_loan_payments p
           JOIN payroll_loans l ON l.id = p.loan_id WHERE p.run_id = prl.run_id AND l.employee_id = prl.employee_id) AS loans,
        (prl.validation_results @> '[{"code":"DEDUCTIONS_EXCEED_PAY"}]'::jsonb
          OR prl.validation_results @> '[{"code":"LOAN_INSTALMENT_EXCEEDS_PAY"}]'::jsonb) AS coded,
        -- CASE, not AND: jsonb_array_length raises on a non-array, and SQL does not promise to short-circuit.
        CASE WHEN jsonb_typeof(prl.component_breakdown) IS DISTINCT FROM 'array' THEN TRUE
             ELSE jsonb_array_length(prl.component_breakdown) = 0 AND prl.gross_pay <> 0 END AS unreadable,
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
    WHERE coded OR (net_pay_nil AND (unreadable OR derived_raw_net < 0))
    ORDER BY employee_number
  `) as Row[];
  return rows.flatMap((r): OverdrawnLine[] => {
    const flagged = r.coded === true
      ? parseValidationResults(r.validation_results).find((v) => OVERDRAWN_CODES.has(v.code))
      : undefined;
    if (!flagged && r.unreadable === true) {
      return [{ employeeId: String(r.employee_id), employeeNumber: String(r.employee_number), shortfall: 0, fromLoan: false, unreadable: true as const }];
    }
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
      loans: Array.isArray(r.loans) ? r.loans.map(String) : [],
    }];
  });
}

export interface WithheldLoanLine { employeeNumber: string; loans: string[]; fringeToo: boolean }

/** Lines carrying LOAN_FRINGE_NOT_RECORDED: a loan collected whose fringe benefit no 3801 earning carried. */
export async function findFringeNotRecordedLines(companyId: string, runId: string): Promise<LoanPaymentOnPayslip[]> {
  const rows = (await sql`
    SELECT pe.employee_number, prl.validation_results
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees    pe  ON pe.id  = prl.employee_id
    WHERE prl.run_id = ${runId}::uuid
      AND prh.company_id = ${companyId}::uuid
      AND prl.validation_results @> '[{"code":"LOAN_FRINGE_NOT_RECORDED"}]'::jsonb
    ORDER BY pe.employee_number
  `) as Row[];
  return rows.flatMap((r) => {
    const flagged = parseValidationResults(r.validation_results).find((v) => v.code === 'LOAN_FRINGE_NOT_RECORDED');
    return flagged ? (flagged.loans ?? ['']).map((loanNumber) => ({ employeeNumber: String(r.employee_number), loanNumber })) : [];
  });
}

/** Lines whose loan was not taken for want of a LOAN deduction (payrollLoanWithholding). */
export async function findWithheldLoanLines(companyId: string, runId: string): Promise<WithheldLoanLine[]> {
  const rows = (await sql`
    SELECT pe.employee_number, prl.validation_results
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees    pe  ON pe.id  = prl.employee_id
    WHERE prl.run_id = ${runId}::uuid
      AND prh.company_id = ${companyId}::uuid
      AND prl.validation_results @> '[{"code":"LOAN_DEDUCTION_MISSING"}]'::jsonb
    ORDER BY pe.employee_number
  `) as Row[];
  return rows.flatMap((r) => {
    const withheld = parseValidationResults(r.validation_results).find((v) => v.code === 'LOAN_DEDUCTION_MISSING');
    return withheld ? [{ employeeNumber: String(r.employee_number), loans: withheld.loans ?? [], fringeToo: withheld.missing?.includes('3801') === true }] : [];
  });
}

export interface LoanPaymentOnPayslip { employeeNumber: string; loanNumber: string }

/**
 * How this run's recorded loan payments show on its payslips.
 *  - `offPayslip`: refused until recalculated. A repayment with no item on the employee's line coded
 *    LOAN (as the line stored it) whose component (by componentId) is a deduction, costed as not
 *    taxable (the item's own isTaxable), of that amount; or a fringe benefit with a 3801 item of exactly
 *    that amount but none that is a taxable earning (the old code took any 3801), unless the line warns
 *    LOAN_FRINGE_NOT_RECORDED for that loan. A run calculated before loans failed closed could do
 *    each of these. Zero amounts need no item.
 *  - `fringeNotRecorded`: a fringe benefit with no 3801 earning item of that amount. Collected without
 *    its benefit (Hein): an advisory, so the approver of an old run sees what a new one warns.
 */
export async function findLoanPaymentsOffPayslip(
  companyId: string, runId: string,
): Promise<{ offPayslip: LoanPaymentOnPayslip[]; fringeNotRecorded: LoanPaymentOnPayslip[] }> {
  const rows = (await sql`
    SELECT pe.employee_number, l.loan_number,
      (p.interest_charged + p.principal_paid > 0
        AND NOT COALESCE(bool_or(item.code = 'LOAN' AND item.type = 'deduction' AND NOT item.taxed
          AND item.amount = ROUND(p.interest_charged + p.principal_paid, 2)), false))
      OR (p.fringe_benefit > 0 AND NOT bool_or(COALESCE(prl.validation_results, '[]'::jsonb) @> jsonb_build_array(
            jsonb_build_object('code', 'LOAN_FRINGE_NOT_RECORDED', 'loans', jsonb_build_array(l.loan_number))))
        AND NOT COALESCE(bool_or(item.code = '3801' AND item.type = 'earning' AND item.taxed AND item.amount = ROUND(p.fringe_benefit, 2)), false)
        AND COALESCE(bool_or(item.code = '3801' AND item.amount = ROUND(p.fringe_benefit, 2)), false)) AS off_payslip,
      p.fringe_benefit > 0
        AND NOT COALESCE(bool_or(item.code = '3801' AND item.type = 'earning' AND item.taxed AND item.amount = ROUND(p.fringe_benefit, 2)), false) AS fringe_missing
      FROM payroll_loan_payments p
      JOIN payroll_loans l ON l.id = p.loan_id AND l.company_id = ${companyId}::uuid
      JOIN payroll_employees pe ON pe.id = l.employee_id
      LEFT JOIN payroll_run_lines prl ON prl.run_id = p.run_id AND prl.employee_id = l.employee_id
      LEFT JOIN LATERAL (
        SELECT BTRIM(i->>'sarsSourceCode', E' \t\r\n') AS code, pc.component_type AS type,
               (i->>'isTaxable') = 'true' AS taxed, ROUND((i->>'amount')::numeric, 2) AS amount
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(prl.component_breakdown) = 'array' THEN prl.component_breakdown ELSE '[]'::jsonb END) i
          JOIN payroll_components pc ON pc.id::text = i->>'componentId' AND pc.company_id = ${companyId}::uuid
      ) item ON true
     WHERE p.run_id = ${runId}::uuid
     GROUP BY p.id, pe.employee_number, l.loan_number, p.interest_charged, p.principal_paid, p.fringe_benefit
     ORDER BY pe.employee_number, l.loan_number
  `) as Row[];
  const of = (keep: (r: Row) => boolean) => rows.filter(keep)
    .map((r) => ({ employeeNumber: String(r.employee_number), loanNumber: String(r.loan_number) }));
  // A refused payment is told as a refusal only, not also as a benefit merely unrecorded.
  return { offPayslip: of((r) => r.off_payslip === true), fringeNotRecorded: of((r) => r.fringe_missing === true && r.off_payslip !== true) };
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
